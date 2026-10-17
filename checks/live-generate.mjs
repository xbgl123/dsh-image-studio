/**
 * One live end-to-end run of the plugin's own generation path.
 *
 * It loads the real `Config` from the profile patch (the same values the running
 * app uses), then calls `runImageRequest` — the single operation both entry points
 * share — with the real `fetch` and a stand-in attachment service. Nothing is
 * stubbed except the durable store, so this exercises routing, translation, the
 * HTTP request, the response reader, the URL fetch, and the media-type check.
 *
 * It spends one real provider call, so it is not part of `pnpm check`.
 *
 * Run: node checks/live-generate.mjs [prompt]
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')
const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
const patchPath = path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

/** Link `@deepseek-ai/schemastery`, which the Host half imports. */
function ensureRuntimePackages() {
  const shim = path.join(moduleDir, 'node_modules', '@deepseek-ai', 'schemastery')
  if (fs.existsSync(path.join(shim, 'package.json'))) return
  let entryPath
  try {
    entryPath = appRequire.resolve('@deepseek-ai/schemastery')
  } catch (_failure) {
    return
  }
  let root = path.dirname(entryPath)
  while (root !== path.dirname(root) && !fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root)
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.symlinkSync(root, shim, 'junction')
}

ensureRuntimePackages()
const yaml = appRequire('js-yaml')
const host = await import(pathToFileURL(path.join(moduleDir, 'index.js')).href)
const { runImageRequest, describeOutcome } = await import(pathToFileURL(path.join(moduleDir, 'src/generate.mjs')).href)
const { readModels, routeRequest } = await import(pathToFileURL(path.join(moduleDir, 'src/router.mjs')).href)

// ------------------------------------------------ the configuration in use

const rows = yaml.load(fs.readFileSync(patchPath, 'utf8'))
const row = rows.find((candidate) => candidate.id === 'image-studio')
if (row === undefined) {
  console.error(`no image-studio row in ${patchPath}`)
  process.exit(1)
}
const section = host.Config(row.config)
const { plainConfig } = await import(
  pathToFileURL('E:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js').href
)
const config = plainConfig(section)
const models = readModels({ imageModels: config.imageModels })

console.log(`config: ${String(models.length)} image model(s)`)
for (const model of models) {
  console.log(
    `  - ${model.name} [${model.protocol}] ${model.baseUrl} model=${model.model} default=${String(model.isDefault)} key=${model.apiKey.length > 0 ? `${String(model.apiKey.length)} chars` : 'MISSING'}`,
  )
}
const routed = routeRequest({ models, nativeRoutes: config.nativeImageRoutes ?? [], provider: 'deepseek-account', model: 'deepseek-flash' })
console.log(`route: ${routed.kind} (${routed.reason})${routed.model === undefined ? '' : ` → ${routed.model.name}`}`)
if (routed.kind !== 'configured') {
  console.error(`routing would not call an image model: ${routed.kind}`)
  process.exit(1)
}

// ------------------------------------------------------------ the call itself

/** A stand-in for the durable attachment store, so nothing is written to disk. */
const saved = []
const attachments = {
  async saveImage(input) {
    saved.push(input)
    return { attachmentId: `att-${String(saved.length)}`, mediaType: input.mediaType, bytes: input.data.length, width: 0, height: 0, name: input.name }
  },
}

/** The request fields actually sent, captured by wrapping the real transport. */
const fields = {}
const realFetch = globalThis.fetch
const fetchImpl = async (url, init) => {
  if (init !== undefined && typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body)
      for (const key of ['model', 'prompt', 'size', 'n', 'negative_prompt']) {
        if (parsed[key] !== undefined) fields[key] = parsed[key]
      }
      if (parsed.n === undefined) fields.n = '(omitted: one image)'
    } catch (_failure) {
      // A multipart body is not JSON; nothing to report.
    }
  }
  return realFetch(url, init)
}

const prompt = process.argv[2] ?? 'a small red apple on a white table'
const started = Date.now()
const result = await runImageRequest(
  { models, nativeRoutes: config.nativeImageRoutes ?? [], provider: 'deepseek-account', model: 'deepseek-flash', attachments, fetchImpl },
  // The plugin-level defaults ride in their own slot, exactly as the automatic path
  // passes them: a count written in the sentence must win over one set in the page.
  { prompt, source: 'user', defaultCount: config.autoImageCount ?? 1, width: config.autoWidth > 0 ? config.autoWidth : undefined, height: config.autoHeight > 0 ? config.autoHeight : undefined },
)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\nelapsed: ${elapsed}s`)
console.log(`outcome: ${result.ok === true ? (result.handledByModel === true ? 'handled-by-model' : 'generated') : `FAILED (${result.kind})`}`)
if (result.ok !== true) {
  console.log(`message: ${result.message}`)
  process.exitCode = 1
} else if (result.handledByModel !== true) {
  console.log(`decision: passThrough=${String(result.decision.passThrough)} translated=${String(result.decision.translated)} reason=${result.decision.reason} ${result.decision.sourceFormat}→${result.decision.targetFormat}`)
  console.log(`prompt sent: ${JSON.stringify(result.decision.prompt)}`)
  console.log(`fields sent: ${JSON.stringify(fields)}`)
  console.log(`parameters: ${JSON.stringify(result.trace?.parameters)}`)
  console.log(`images: ${String(result.refs.length)}`)
  for (const [index, input] of saved.entries()) {
    console.log(`  #${String(index + 1)}: ${input.mediaType}, ${String(input.data.length)} bytes, name=${String(input.name)}`)
    // Confirm the bytes really are an image rather than an error page.
    const head = Buffer.from(input.data.subarray(0, 8)).toString('hex')
    console.log(`     magic: ${head}`)
  }
  console.log(`summary: ${describeOutcome(result, { source: 'user' })}`)
}
