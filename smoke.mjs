/**
 * Host-half smoke test for `dsh-image-studio`.
 *
 * It answers the questions a bundle install cannot: does the Config schema accept
 * the records the page writes, does the page's path-op strategy keep a stored
 * secret while it appends, edits, and defaults records, and do the stage-2
 * configuration fields exist with the defaults the scheduler expects?
 *
 * The plugin imports packages that resolve from the DSH installation rather than
 * from this package, so the test links them first, for the import that follows.
 *
 * Run: node smoke.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/**
 * Every package this plugin imports at runtime. Each is resolved from the
 * installation by its bare specifier (an `exports` map rarely exposes
 * `./package.json`), then the package root is found by walking up to the manifest.
 * The plugin deliberately imports only packages a profile can also resolve, so
 * this list stays short.
 */
const RUNTIME_PACKAGES = ['schemastery']

/** Link each runtime package from the DSH installation when this package has no node_modules. */
function ensureRuntimePackages() {
  const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
  for (const name of RUNTIME_PACKAGES) {
    const shim = path.join(moduleDir, 'node_modules', '@deepseek-ai', name)
    if (fs.existsSync(path.join(shim, 'package.json'))) continue
    let entryPath
    try {
      entryPath = appRequire.resolve(`@deepseek-ai/${name}`)
    } catch (_failure) {
      continue
    }
    let root = path.dirname(entryPath)
    while (root !== path.dirname(root) && !fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root)
    if (!fs.existsSync(path.join(root, 'package.json'))) continue
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.symlinkSync(root, shim, 'junction')
  }
}

ensureRuntimePackages()
const host = await import(pathToFileURL(path.join(moduleDir, 'index.js')).href)

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

/**
 * Mirror of `dsh-settings`' `plainConfig`: a volatile node holds a live
 * reference, and every reader (the settings form projection included) unwraps it
 * before looking at the value.
 */
const plain = (value) => {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && Symbol.for('cosmokit.volatile') !== undefined) {
    const tag = Object.getOwnPropertySymbols(value).find((symbol) => String(symbol) === 'Symbol(cosmokit.volatile.write)')
    if (tag !== undefined) return plain(value.get())
  }
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  return value
}

// ------------------------------------------------------------------ schema

check('Config accepts an empty section', () => {
  assert.deepEqual(plain(host.Config({}).imageModels), [])
})

check('Config fills protocol, format, params, and header defaults', () => {
  const value = plain(
    host.Config({
      imageModels: [{ id: 'a', name: 'Local SD', protocol: 'stability-sd-webui', baseUrl: 'http://127.0.0.1:7860', model: 'sd_xl' }],
    }),
  )
  const record = value.imageModels[0]
  assert.equal(record.promptFormat, 'natural')
  assert.equal(record.apiKey, '')
  assert.deepEqual(record.headers, [])
  assert.deepEqual(record.params, { size: '', width: 1024, height: 1024, steps: 0, timeoutMs: 300000 })
  assert.equal(record.isDefault, false)
})

check('the whole model list is one volatile node (live edits, no remount)', () => {
  const section = host.Config({})
  const tag = Object.getOwnPropertySymbols(section.imageModels).find((symbol) => String(symbol) === 'Symbol(cosmokit.volatile.write)')
  assert.notEqual(tag, undefined)
})

check('stage-2 scheduler fields exist with their documented defaults', () => {
  const section = plain(host.Config({}))
  assert.deepEqual(section.nativeImageRoutes, [])
  assert.equal(section.autoGenerate, true, 'automatic routing is on by default')
  assert.equal(section.announce, true)
  assert.equal(section.autoImageCount, 1)
  assert.equal(section.autoWidth, 0, 'zero means "keep the model stored size"')
  assert.equal(section.autoHeight, 0)
})

check('every stage-2 field is volatile, so an edit applies without a restart', () => {
  const section = host.Config({})
  for (const field of ['imageModels', 'nativeImageRoutes', 'autoGenerate', 'announce', 'autoImageCount', 'autoWidth', 'autoHeight']) {
    const tag = Object.getOwnPropertySymbols(section[field]).find((symbol) => String(symbol) === 'Symbol(cosmokit.volatile.write)')
    assert.notEqual(tag, undefined, `${field} is not volatile`)
  }
})

check('the per-model pass-through policy defaults to auto', () => {
  const record = plain(host.Config({ imageModels: [{ name: 'x' }] })).imageModels[0]
  assert.equal(record.promptPassThrough, 'auto')
})

check('an unknown pass-through policy is rejected', () => {
  assert.throws(() => host.Config({ imageModels: [{ promptPassThrough: 'sometimes' }] }))
})

check('the native route list accepts provider/model strings', () => {
  const section = plain(host.Config({ nativeImageRoutes: ['deepseek-account/dall-e-3', 'local-sd'] }))
  assert.deepEqual(section.nativeImageRoutes, ['deepseek-account/dall-e-3', 'local-sd'])
})

check('Config accepts a full record the editor produces', () => {
  const draft = {
    id: 'img-1',
    name: 'Relay',
    protocol: 'openai-images',
    baseUrl: 'https://relay.example/v1',
    apiKey: 'sk-test',
    model: 'gpt-image-1',
    headers: [{ name: 'X-Tenant', value: 'acme' }],
    promptFormat: 'custom',
    promptPrefix: 'cinematic, ',
    promptNegative: 'blurry',
    promptTemplate: '{prefix}{prompt} --no {negative}',
    params: { size: 'square', width: 1024, height: 1024, steps: 30, timeoutMs: 60000 },
    isDefault: true,
  }
  const value = plain(host.Config({ imageModels: [draft] }))
  assert.equal(value.imageModels[0].promptTemplate, '{prefix}{prompt} --no {negative}')
  assert.equal(value.imageModels[0].params.steps, 30)
})

check('Config rejects an unknown protocol', () => {
  assert.throws(() => host.Config({ imageModels: [{ protocol: 'midjourney-imagine' }] }))
})

check('Config rejects an unknown prompt format', () => {
  assert.throws(() => host.Config({ imageModels: [{ promptFormat: 'haiku' }] }))
})

check('a role(secret) position is reported without its value', () => {
  // Mirror of dsh-settings' redact walk: the schema must declare the position,
  // or a reader would see the key in clear.
  const schema = host.Config
  const array = schema.dict.imageModels
  const item = array.inner
  assert.equal(item.dict.apiKey.meta.role, 'secret')
  assert.equal(item.dict.name.meta.role, undefined)
})

// --------------------------------------------------------------- op strategy

/**
 * Stand-in for the Settings service's `applyPathOp` + stored-secret retention:
 * ops edit the stored section in order, and the reader only ever sees a redacted
 * copy. A whole-record write therefore replaces a stored key with the redaction
 * placeholder, which is exactly the bug the op order avoids.
 */
const applyOps = (section, ops) => {
  const next = structuredClone(section)
  for (const op of ops) {
    let node = next
    for (const key of op.path.slice(0, -1)) {
      const at = Number(key)
      node = Array.isArray(node) ? node[at] : node[key]
    }
    const leaf = op.path[op.path.length - 1]
    if (op.op === 'unset') {
      if (Array.isArray(node)) node.splice(Number(leaf), 1)
      else delete node[leaf]
    } else if (Array.isArray(node)) node[Number(leaf)] = op.value
    else node[leaf] = op.value
  }
  return next
}

const redact = (section) => ({
  imageModels: section.imageModels.map((model) => ({ ...model, apiKey: '' })),
})

const stored = {
  imageModels: [
    { id: 'a', name: 'A', protocol: 'openai-images', baseUrl: 'https://a/v1', apiKey: 'sk-a', model: 'm-a', headers: [], promptFormat: 'natural', promptPrefix: '', promptNegative: '', promptTemplate: '', params: { size: '', width: 1024, height: 1024, steps: 0, timeoutMs: 120000 }, isDefault: true },
  ],
}
const seen = redact(stored)

check('appending a second record keeps the first key', () => {
  const payload = { id: 'b', name: 'B', protocol: 'stability-sd-webui', baseUrl: 'http://127.0.0.1:7860', model: 'sd_xl', headers: [], promptFormat: 'sd-tags', promptPrefix: 'best quality', promptNegative: 'worst quality', promptTemplate: '', params: { size: '', width: 1024, height: 1024, steps: 25, timeoutMs: 120000 }, isDefault: false }
  const next = applyOps(stored, [{ op: 'set', path: ['imageModels', '1'], value: payload }])
  assert.equal(next.imageModels[0].apiKey, 'sk-a')
  assert.equal(next.imageModels[1].name, 'B')
})

check('editing a record field keeps its own key', () => {
  const next = applyOps(stored, [{ op: 'set', path: ['imageModels', '0', 'name'], value: 'A renamed' }])
  assert.equal(next.imageModels[0].apiKey, 'sk-a')
  assert.equal(next.imageModels[0].name, 'A renamed')
})

check('a whole-array write of a redacted read WOULD erase the key (why the page uses paths)', () => {
  const next = applyOps(stored, [{ op: 'set', path: ['imageModels'], value: seen.imageModels }])
  assert.equal(next.imageModels[0].apiKey, '')
})

check('setting a new default clears the previous flag and keeps both keys', () => {
  const two = applyOps(stored, [
    { op: 'set', path: ['imageModels', '1'], value: { ...stored.imageModels[0], id: 'b', name: 'B', apiKey: '', isDefault: false } },
    { op: 'set', path: ['imageModels', '0', 'isDefault'], value: false },
    { op: 'set', path: ['imageModels', '1', 'isDefault'], value: true },
  ])
  assert.equal(two.imageModels[0].isDefault, false)
  assert.equal(two.imageModels[1].isDefault, true)
  assert.equal(two.imageModels[0].apiKey, 'sk-a')
})

check('unset removes the array element instead of leaving a hole', () => {
  const next = applyOps(stored, [{ op: 'unset', path: ['imageModels', '0'] }])
  assert.equal(next.imageModels.length, 0)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
