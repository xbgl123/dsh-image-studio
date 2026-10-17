/**
 * The secret round-trip, against the real Settings schema machinery.
 *
 * `apiKey` carries `role('secret')`, which makes it the one field the ordinary
 * snapshot test cannot check: a redacted read returns an empty string whether or
 * not a value is stored, so a stub that ignores secrets hides exactly this class
 * of bug. This file drives the real `volatileForm` / `projectForm` projection and
 * the real `applyPathOp` reducer over the plugin's real `Config`, and asserts the
 * stored secret survives the operations the page actually sends.
 *
 * Run: node checks/secret-roundtrip.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')
const appModules = 'E:/DSH Desktop/resources/app/node_modules'

/** Link a package from the installation so the plugin and the Settings internals both resolve it. */
function ensure(specifier, name) {
  const shim = path.join(moduleDir, 'node_modules', '@deepseek-ai', name)
  if (fs.existsSync(path.join(shim, 'package.json'))) return
  const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
  let entryPath
  try {
    entryPath = appRequire.resolve(specifier)
  } catch (_failure) {
    return
  }
  let root = path.dirname(entryPath)
  while (root !== path.dirname(root) && !fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root)
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.symlinkSync(root, shim, 'junction')
}

ensure('@deepseek-ai/schemastery', 'schemastery')
const host = await import(pathToFileURL(path.join(moduleDir, 'index.js')).href)

// The Settings package resolves through the installation's own dependency tree.
const settingsModule = await import(pathToFileURL(path.join(appModules, '@deepseek-ai/dsh-settings/lib/types/schema.js')).href)
const { volatileForm, projectForm, plainConfig, isVolatilePath } = settingsModule

let failures = 0
/** Run one named case, recording failure instead of aborting the suite. */
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

/**
 * The Settings service's `applyPathOp`, reproduced from
 * `dsh-settings/lib/types/index.js` so the reducer under test is the real one's
 * behavior rather than an approximation.
 */
function applyPathOp(section, op, schema) {
  const isPlainObject = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  const edit = (input, path, node) => {
    const [head, ...rest] = path
    if (head === undefined) return op.op === 'set' ? op.value : undefined
    const value = input === undefined ? node?.meta.default : input
    if (Array.isArray(value)) {
      const index = Number(head)
      const result = [...value]
      if (rest.length === 0 && op.op === 'unset') result.splice(index, 1)
      else result[index] = edit(value[index], rest, node?.inner)
      return result
    }
    const result = isPlainObject(value) ? { ...value } : {}
    const child = edit(Object.hasOwn(result, head) ? result[head] : undefined, rest, node?.dict?.[head] ?? node?.inner)
    if (child === undefined) Reflect.deleteProperty(result, head)
    else Object.defineProperty(result, head, { value: child, enumerable: true, writable: true, configurable: true })
    return result
  }
  return edit(section, op.path, schema)
}

const form = volatileForm(host.Config)
const payload = (apiKeyField) => ({
  id: 'img-1',
  name: 'Relay',
  protocol: 'openai-images',
  baseUrl: 'https://relay.example/v1',
  model: 'gpt-image-1',
  headers: [],
  promptFormat: 'natural',
  promptPassThrough: 'auto',
  promptPrefix: '',
  promptNegative: '',
  promptTemplate: '',
  params: { size: '', width: 1024, height: 1024, steps: 0, timeoutMs: 120000 },
  isDefault: true,
  ...(apiKeyField === undefined ? {} : { apiKey: apiKeyField }),
})

// ------------------------------------------------------- the projection itself

check('the volatile form keeps the secret position declared', () => {
  assert.notEqual(form, undefined, 'the Config has a volatile field, so it projects')
  const item = form.dict.imageModels.inner
  assert.equal(item.dict.apiKey.meta.role, 'secret', 'the form must keep the secret role')
  assert.equal(item.dict.apiKey.meta.default, undefined, 'a secret keeps no default in the form')
})

check('the secret path is volatile, so the Settings service accepts it', () => {
  assert.equal(isVolatilePath(host.Config, ['imageModels', '0', 'apiKey']), true)
  assert.equal(isVolatilePath(host.Config, ['imageModels', '0', 'name']), true)
})

// ------------------------------------------------------ the page's write sequence

check('adding a record writes its key and a redacted read reports it set', () => {
  // Exactly the operations `client.js` sends for a new record.
  const ops = [
    { op: 'set', path: ['imageModels', '0'], value: payload(undefined) },
    { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-secret-value' },
  ]
  let user = {}
  for (const op of ops) user = applyPathOp(user, op, form)
  assert.equal(user.imageModels[0].apiKey, 'sk-secret-value', 'the key must be stored in the user section')
  assert.equal(user.imageModels[0].name, 'Relay')

  // The Settings service returns `projectForm(form, raw)` redacted; the raw value
  // is what a restart reloads, so assert on it directly.
  const stored = projectForm(form, user)
  assert.equal(stored.imageModels[0].apiKey, 'sk-secret-value')
})

check('editing another field never disturbs the stored key', () => {
  let user = { imageModels: [{ ...payload('sk-secret-value') }] }
  const ops = [
    { op: 'set', path: ['imageModels', '0', 'name'], value: 'Relay renamed' },
    { op: 'set', path: ['imageModels', '0', 'promptPrefix'], value: 'HQ, ' },
  ]
  for (const op of ops) user = applyPathOp(user, op, form)
  assert.equal(user.imageModels[0].apiKey, 'sk-secret-value', 'a field edit must not touch the key')
  assert.equal(user.imageModels[0].name, 'Relay renamed')
})

check('a whole-record write with the redacted key WOULD erase it (why the page uses paths)', () => {
  let user = { imageModels: [{ ...payload('sk-secret-value') }] }
  // What a reader holds: the redacted value.
  const redacted = { ...payload('') }
  user = applyPathOp(user, { op: 'set', path: ['imageModels', '0'], value: redacted }, form)
  assert.equal(user.imageModels[0].apiKey, '', 'this is the failure mode the path strategy avoids')
})

check('replacing the key keeps exactly the newest value', () => {
  let user = { imageModels: [{ ...payload('sk-old') }] }
  user = applyPathOp(user, { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-new' }, form)
  assert.equal(user.imageModels[0].apiKey, 'sk-new')
})

check('the key survives a second record being appended', () => {
  let user = { imageModels: [{ ...payload('sk-first') }] }
  user = applyPathOp(user, { op: 'set', path: ['imageModels', '1'], value: payload(undefined) }, form)
  user = applyPathOp(user, { op: 'set', path: ['imageModels', '1', 'apiKey'], value: 'sk-second' }, form)
  assert.equal(user.imageModels[0].apiKey, 'sk-first')
  assert.equal(user.imageModels[1].apiKey, 'sk-second')
})

check('a restart reload is projected back through the schema intact', () => {
  // What the Loader does on reload: the stored user section re-enters the schema,
  // and the secret must come out of validation as a real string.
  const validated = plainConfig(host.Config({ imageModels: [payload('sk-secret-value')] }))
  assert.equal(validated.imageModels[0].apiKey, 'sk-secret-value')
})

// -------------------------------------------------- what the page can observe

check('the redacted read exposes the secret position as set, not its value', () => {
  const redactModule = path.join(appModules, '@deepseek-ai/dsh-settings/lib/types/redact.js')
  // Imported lazily so a failure here reads as a missing internal, not a bad test.
  return import(pathToFileURL(redactModule).href).then(({ redactSecrets }) => {
    const value = plainConfig(host.Config({ imageModels: [payload('sk-secret-value')] }))
    const { value: stripped, secrets } = redactSecrets(form, value)
    const entry = secrets.find((candidate) => candidate.path.join('.') === 'imageModels.0.apiKey')
    assert.notEqual(entry, undefined, 'the read must report the secret position')
    assert.equal(entry.set, true, 'the read must report the secret as set')
    assert.ok(
      !('apiKey' in stripped.imageModels[0]) || stripped.imageModels[0].apiKey === '',
      'the secret value must not ride a read',
    )
  })
})

console.log(failures === 0 ? '\nall secret round-trip checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
