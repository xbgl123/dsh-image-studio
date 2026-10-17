/**
 * The live configuration read, against the real profile patch.
 *
 * The offline checks prove the read order with hand-written configs. This one uses
 * the row the running app actually stored, so it answers the question that
 * mattered: does `apply()` see the configured model when its only source is the
 * saved row (a bundle-provided row has no profile entry of its own, and the
 * activation-time `config` argument predates every saved model)?
 *
 * It never echoes the key and never calls the provider.
 *
 * Run: node checks/live-config-read.mjs
 */
import assert from 'node:assert/strict'
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
// The same projection the Host's own read uses to unwrap a `.volatile()` field.
const { plainConfig } = await import(
  pathToFileURL('E:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js').href
)
const { registerImageTool, registerStatusTool } = await import(pathToFileURL(path.join(moduleDir, 'src/tool.mjs')).href)

let failures = 0
/** Run one named case, recording failure instead of aborting the suite. */
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

const rows = yaml.load(fs.readFileSync(patchPath, 'utf8'))
const savedRow = rows.find((candidate) => candidate.id === 'image-studio')
if (savedRow === undefined) {
  console.log(`skip: no image-studio row in ${patchPath}`)
  process.exit(0)
}

/**
 * Apply the plugin with a context whose only config source is the saved row, and
 * whose activation-time argument is the stale empty config the Loader passed when
 * the bundle first loaded.
 */
function applyOverSavedRow(options = {}) {
  const registered = []
  const services = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    attachments: { saveImage: async (input) => ({ attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }) },
    settings: { configure: () => () => {} },
    systemPrompt: { section: () => () => {} },
    configEditor: { entries: () => [{ options: { id: 'image-studio', config: savedRow.config } }] },
  }
  const staleActivationConfig = options.stale === false ? savedRow.config : { imageModels: [], autoGenerate: true }
  /** A fiber that still holds the activation-time value, as a bundle row's does. */
  const fiberConfig = options.staleFiber === false ? host.Config(savedRow.config) : host.Config({ imageModels: [], autoGenerate: true })
  const listeners = new Map()
  const base = {
    fiber: { config: fiberConfig },
    logger: { warn: () => {} },
    get: (name) => services[name],
    effect: (callback) => {
      const disposed = callback()
      return typeof disposed === 'function' ? disposed : () => {}
    },
    inject: (_names, callback) => {
      callback(ctx)
      return () => {}
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
  }
  const ctx = new Proxy(base, {
    get: (target, key) => (key in target ? target[key] : services[key]),
  })
  host.apply(ctx, staleActivationConfig)
  return { registered, ctx }
}

const { registered } = applyOverSavedRow()
const status = registered.find((definition) => definition.name === 'image_studio_status')
const generate = registered.find((definition) => definition.name === 'generate_image')

await check('the saved model is visible even though both other sources are stale', async () => {
  assert.notEqual(status, undefined, 'the self-check tool is registered')
  const value = await status.execute({}, { signal: new AbortController().signal })
  console.log(`     ${value.summary.split('\n').join('\n     ')}`)
  const row = yaml.load(fs.readFileSync(patchPath, 'utf8')).find((candidate) => candidate.id === 'image-studio')
  const expected = row.config.imageModels.length
  assert.equal(value.modelCount, expected, `expected ${String(expected)} model(s) from the saved row`)
})

await check('the saved model is callable through the generation tool', async () => {
  assert.notEqual(generate, undefined)
  const calls = []
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) }
  }
  let value
  try {
    value = await generate.execute({ prompt: 'a cat' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls.length, 1, 'exactly one provider call')
  assert.match(calls[0].url, /\/images\/generations$/)
  assert.equal(value.images.length, 1, `generation failed: ${value.summary}`)
  assert.equal(value.passThrough, true, 'a natural prompt to an OpenAI-compatible model passes through')
  // The key must have been resolved from the saved row and used as a bearer header.
  const authorization = Object.entries(calls[0].headers).find(([name]) => name.toLowerCase() === 'authorization')
  assert.notEqual(authorization, undefined, 'the request must carry an Authorization header')
  assert.match(String(authorization[1]), /^Bearer /)
})

await check('the key value never appears in the reported summary', async () => {
  const value = await status.execute({}, { signal: new AbortController().signal })
  const key = savedRow.config.imageModels[0].apiKey
  assert.doesNotMatch(value.summary, new RegExp(String(key).slice(0, 12)))
  assert.match(value.summary, /key=set/)
})

await check('the persisted row on disk re-validates through the plugin schema', () => {
  // This is the assertion the old `patch-write.mjs` wanted, made against the real
  // file the running app wrote: a saved section must survive being read back and
  // validated, with its secret still in place. Mocking DSH's own YAML writer needed
  // the whole launcher, so the check asserts the loop that matters instead.
  const fromDisk = yaml.load(fs.readFileSync(patchPath, 'utf8')).find((candidate) => candidate.id === 'image-studio')
  assert.notEqual(fromDisk, undefined, 'the app must have written the row')
  const validated = host.Config(fromDisk.config)
  const section = plainConfig(validated)
  assert.equal(Array.isArray(section.imageModels), true)
  assert.ok(section.imageModels.length > 0, 'the saved model list survives a re-read')
  const stored = fromDisk.config.imageModels[0]
  assert.ok(String(stored.apiKey ?? '').length > 0, 'the saved key is still on disk')
  assert.equal(section.imageModels[0].model, stored.model, 'the stored model identifier round-trips')
  assert.equal(section.imageModels[0].baseUrl, stored.baseUrl, 'the stored endpoint round-trips')
})

await check('the row written for this bundle carries its package name', () => {
  const fromDisk = yaml.load(fs.readFileSync(patchPath, 'utf8')).find((candidate) => candidate.id === 'image-studio')
  // Without `name`, a bundle-provided row would not resolve back to this package.
  assert.equal(fromDisk.name, 'dsh-image-studio')
})

console.log(failures === 0 ? '\nall live config-read checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
