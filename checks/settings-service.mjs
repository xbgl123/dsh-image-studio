/**
 * The real `SettingsForms` service, on a real Cordis context, over a mocked Loader
 * entry whose schema is the plugin's real `Config`.
 *
 * Every earlier secret check reproduced part of this service by hand. This one runs
 * the shipped class, so the projection, the write-time validation, the strip, the
 * persistence callback, and the redaction are all the real implementations. If a
 * saved API key does not come back as "set", the reason has to appear here.
 *
 * Run: node checks/settings-service.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')
const appModules = 'E:/DSH Desktop/resources/app/node_modules'
const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')

/** Link a package from the installation when this package has no node_modules. */
function ensure(specifier, name) {
  const shim = path.join(moduleDir, 'node_modules', '@deepseek-ai', name)
  if (fs.existsSync(path.join(shim, 'package.json'))) return
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
const { Context } = appRequire('@deepseek-ai/cordis')
const host = await import(pathToFileURL(path.join(moduleDir, 'index.js')).href)
const settings = await import(pathToFileURL(path.join(appModules, '@deepseek-ai/dsh-settings/lib/index.js')).href)
const schemaModule = await import(pathToFileURL(path.join(appModules, '@deepseek-ai/dsh-settings/lib/types/schema.js')).href)

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

const payload = (overrides = {}) => ({
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
  ...overrides,
})

/**
 * A real Cordis context with a mocked `configEditor` and `profileContext`, plus one
 * Loader entry whose runtime Config is the plugin's real schema.
 *
 * @returns the context, the service, and readers for the persisted raw config.
 */
function makeHost() {
  const ctx = new Context()
  const raw = {}
  const entry = {
    options: { id: 'image-studio', name: 'dsh-image-studio', config: raw },
    fiber: undefined,
  }
  const configEditor = {
    documentPath: 'C:/fake/profile/cordis.patch.yml',
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: raw }],
    edit: async (target, change) => {
      const current = structuredClone(target.options.config ?? {})
      const next = change(current, {})
      for (const key of Object.keys(target.options.config)) delete target.options.config[key]
      Object.assign(target.options.config, next)
      // The Loader re-validates and re-materializes the running config.
      const validation = new ctx.constructor === undefined ? undefined : undefined
      void validation
      target.fiber.config = host.Config(target.options.config)
    },
  }
  ctx.provide('configEditor', configEditor)
  ctx.provide('profileContext', { patchPath: configEditor.documentPath, dir: 'C:/fake/profile', home: 'C:/fake/home' })
  // `SettingsForms` awaits the Loader once on construction to import a legacy
  // document; a resolved promise keeps that path inert.
  ctx.provide('loader', { entries: () => [entry], await: () => Promise.resolve() })
  // The entry's fiber context is the plugin's own; give it the same providers.
  const fiberCtx = {
    configEditor,
    profileContext: { patchPath: configEditor.documentPath, dir: 'C:/fake/profile' },
    waterfall: (_fiber, _name, value) => value,
    logger: ctx.logger,
    emit: () => {},
    on: () => () => {},
    effect: (fn) => {
      const disposed = fn()
      return typeof disposed === 'function' ? disposed : () => {}
    },
  }
  entry.fiber = {
    uid: 'fake-uid',
    state: 2,
    config: host.Config({}),
    runtime: { Config: host.Config },
    ctx: fiberCtx,
  }
  const service = new settings.SettingsForms(ctx)
  return {
    ctx,
    service,
    raw: () => raw,
    reload: () => {
      entry.fiber.config = host.Config(raw)
    },
  }
}

await check('describe reports the namespace with no key set yet', () => {
  const { service, reload } = makeHost()
  reload()
  const descriptors = service.describe({ redactSecrets: true })
  assert.equal(descriptors.length, 1, 'the entry is configurable')
  assert.equal(descriptors[0].ns, 'image-studio')
  assert.deepEqual(descriptors[0].secrets ?? [], [], 'nothing is set before a write')
})

await check('mutate persists an API key and describe then reports it set', async () => {
  const { service, raw, reload } = makeHost()
  reload()
  const before = service.describe({ redactSecrets: true }).find((row) => row.ns === 'image-studio')
  await service.mutate(
    'image-studio',
    [
      { op: 'set', path: ['imageModels', '0'], value: payload() },
      { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-real-secret' },
    ],
    before.revision,
  )
  assert.equal(raw().imageModels[0].apiKey, 'sk-real-secret', `persisted: ${JSON.stringify(raw())}`)

  reload()
  const after = service.describe({ redactSecrets: true }).find((row) => row.ns === 'image-studio')
  const entry = (after.secrets ?? []).find((candidate) => candidate.path.join('.') === 'imageModels.0.apiKey')
  assert.notEqual(entry, undefined, `secrets were ${JSON.stringify(after.secrets)}`)
  assert.equal(entry.set, true, 'the key must read as set')
})

await check('the unredacted read a local caller gets still holds the key', async () => {
  const { service, reload } = makeHost()
  reload()
  const before = service.describe().find((row) => row.ns === 'image-studio')
  await service.mutate(
    'image-studio',
    [
      { op: 'set', path: ['imageModels', '0'], value: payload() },
      { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-real-secret' },
    ],
    before.revision,
  )
  reload()
  const after = service.describe().find((row) => row.ns === 'image-studio')
  assert.equal(after.value.imageModels[0].apiKey, 'sk-real-secret')
})

await check('a later single-field write keeps the stored key', async () => {
  const { service, raw, reload } = makeHost()
  reload()
  const first = service.describe({ redactSecrets: true }).find((row) => row.ns === 'image-studio')
  await service.mutate(
    'image-studio',
    [
      { op: 'set', path: ['imageModels', '0'], value: payload() },
      { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-real-secret' },
    ],
    first.revision,
  )
  reload()
  const second = service.describe({ redactSecrets: true }).find((row) => row.ns === 'image-studio')
  await service.mutate('image-studio', [{ op: 'set', path: ['imageModels', '0', 'name'], value: 'Renamed' }], second.revision)
  assert.equal(raw().imageModels[0].apiKey, 'sk-real-secret', 'the key must survive a field edit')
  assert.equal(raw().imageModels[0].name, 'Renamed')
})

await check('the inline set-default action keeps every stored key', async () => {
  const { service, raw, reload } = makeHost()
  reload()
  const first = service.describe({ redactSecrets: true }).find((row) => row.ns === 'image-studio')
  await service.mutate(
    'image-studio',
    [
      { op: 'set', path: ['imageModels', '0'], value: payload() },
      { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-first' },
      { op: 'set', path: ['imageModels', '1'], value: payload({ id: 'img-2', name: 'Second', isDefault: false }) },
      { op: 'set', path: ['imageModels', '1', 'apiKey'], value: 'sk-second' },
    ],
    first.revision,
  )
  reload()
  const second = service.describe({ redactSecrets: true }).find((row) => row.ns === 'image-studio')
  await service.mutate(
    'image-studio',
    [
      { op: 'set', path: ['imageModels', '0', 'isDefault'], value: false },
      { op: 'set', path: ['imageModels', '1', 'isDefault'], value: true },
    ],
    second.revision,
  )
  assert.equal(raw().imageModels[0].apiKey, 'sk-first')
  assert.equal(raw().imageModels[1].apiKey, 'sk-second')
})

await check('the stored key survives the Loader re-validating the patch on restart', async () => {
  const { service, raw, reload } = makeHost()
  reload()
  const first = service.describe({ redactSecrets: true }).find((row) => row.ns === 'image-studio')
  await service.mutate(
    'image-studio',
    [
      { op: 'set', path: ['imageModels', '0'], value: payload() },
      { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-real-secret' },
    ],
    first.revision,
  )
  // A restart validates the patch through the plugin schema and re-describes it.
  const form = schemaModule.volatileForm(host.Config)
  const reloaded = schemaModule.plainConfig(host.Config(raw()))
  const redacted = settings.redactSecrets(form, { imageModels: [{ apiKey: reloaded.imageModels[0].apiKey ?? '' }] })
  assert.equal(redacted.secrets[0]?.set, true, 'the key must still be present after a reload')
})

console.log(failures === 0 ? '\nall settings-service checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
