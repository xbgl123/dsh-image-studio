/**
 * The persistence half of the secret write: the real `strip` + `mergeLayers`
 * pipeline the Settings service runs before handing the section to the config
 * editor, on the plugin's real `Config`.
 *
 * `checks/secret-roundtrip.mjs` proves the reducer stores the key;
 * `checks/save-secret-e2e.mjs` proves the page sends it. This file proves the
 * value survives the transform in between, which is the step neither of those
 * reproduces.
 *
 * Run: node checks/secret-persist.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')
const appModules = 'E:/DSH Desktop/resources/app/node_modules'

/** Link a package from the installation when this package has no node_modules. */
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
const { volatileForm, projectForm, plainConfig, isVolatilePath } = await import(
  pathToFileURL(path.join(appModules, '@deepseek-ai/dsh-settings/lib/types/schema.js')).href
)
const { redactSecrets } = await import(pathToFileURL(path.join(appModules, '@deepseek-ai/dsh-settings/lib/types/redact.js')).href)

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

const form = volatileForm(host.Config)

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** `dsh-settings`' `applyPathOp`, reproduced from the shipped implementation. */
function applyPathOp(section, op, schema) {
  const edit = (input, opPath, node) => {
    const [head, ...rest] = opPath
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

/** `dsh-settings`' `mergeLayers`, reproduced from the shipped implementation. */
function mergeLayers(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isPlainObject(current) && isPlainObject(value) ? mergeLayers(current, value) : value
  }
  for (const key of Object.keys(result)) if (result[key] === undefined) Reflect.deleteProperty(result, key)
  return result
}

/** `dsh-settings`' `strip`, reproduced from the shipped implementation. */
function strip(value, node, schema, path_ = []) {
  if (isVolatilePath(schema, path_)) return {}
  const result = { ...value }
  for (const [key, field] of Object.entries(node.dict ?? {})) {
    const target = [...path_, key]
    if (isVolatilePath(schema, target)) Reflect.deleteProperty(result, key)
    else if (isPlainObject(result[key])) result[key] = strip(result[key], field, schema, target)
  }
  return result
}

/** Run one write the way the Settings service does, and return the new raw config. */
function runWrite(rawConfig, ops) {
  const current = projectForm(form, rawConfig)
  const next = ops.reduce((value, op) => applyPathOp(value, op, form), current)
  // The service validates the whole tree through the form before persisting.
  const validate = (node, value, path_ = []) => {
    for (const [key, child] of Object.entries(value)) {
      const target = [...path_, key]
      if (isVolatilePath(host.Config, target)) continue
      const field = Object.hasOwn(node.dict ?? {}, key) ? node.dict[key] : undefined
      if (isPlainObject(child) && field !== undefined) validate(field, child, target)
      else throw new Error(`Config field "${target.join('.')}" is not volatile`)
    }
  }
  validate(form, next)
  return mergeLayers(strip(rawConfig, form, host.Config), next)
}

const payload = {
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
}

check('a first write persists the key into the stored config', () => {
  const written = runWrite({}, [
    { op: 'set', path: ['imageModels', '0'], value: payload },
    { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-secret-value' },
  ])
  assert.equal(written.imageModels[0].apiKey, 'sk-secret-value', `stored config was ${JSON.stringify(written)}`)
})

check('a later write to another field keeps the stored key', () => {
  const first = runWrite({}, [
    { op: 'set', path: ['imageModels', '0'], value: payload },
    { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-secret-value' },
  ])
  const second = runWrite(first, [{ op: 'set', path: ['imageModels', '0', 'name'], value: 'Renamed' }])
  assert.equal(second.imageModels[0].apiKey, 'sk-secret-value')
  assert.equal(second.imageModels[0].name, 'Renamed')
})

check('the value the page reads back is redacted but reports the key as set', () => {
  const written = runWrite({}, [
    { op: 'set', path: ['imageModels', '0'], value: payload },
    { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-secret-value' },
  ])
  const { value: redacted, secrets } = redactSecrets(form, written)
  assert.ok(!('apiKey' in redacted.imageModels[0]), 'the value must not ride a read')
  const entry = secrets.find((candidate) => candidate.path.join('.') === 'imageModels.0.apiKey')
  assert.notEqual(entry, undefined, 'the position must be reported')
  assert.equal(entry.set, true, 'the position must read as set')
})

check('the Loader re-validates the stored section on reload with the key intact', () => {
  const written = runWrite({}, [
    { op: 'set', path: ['imageModels', '0'], value: payload },
    { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-secret-value' },
  ])
  // What the Loader does with the patch on the next start: re-validate the stored
  // section, then unwrap the volatile references the schema produces.
  const reloaded = plainConfig(host.Config(written))
  const positions = redactSecrets(form, { imageModels: [{ apiKey: reloaded.imageModels[0].apiKey ?? '' }] }).secrets
  assert.equal(positions[0]?.set, true, 'the reloaded value must still hold a key')
})

console.log(failures === 0 ? '\nall persistence checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
