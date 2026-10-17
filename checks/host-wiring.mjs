/**
 * Host wiring: load the real Host half and drive `apply()` with a fake runtime.
 *
 * This is the layer the pure-module checks cannot reach — the tool registration,
 * the per-agent `agent/pre-step` listener, the message it contributes, and the
 * refusal notice. It catches wiring mistakes (a payload field that does not exist,
 * a service read from the wrong context) before a restart is spent on them.
 *
 * Run: node checks/host-wiring.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')

/** Link `@deepseek-ai/schemastery` from the installation, as the Host half imports it. */
function ensureRuntimePackages() {
  const shim = path.join(moduleDir, 'node_modules', '@deepseek-ai', 'schemastery')
  if (fs.existsSync(path.join(shim, 'package.json'))) return
  const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
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
const host = await import(pathToFileURL(path.join(moduleDir, 'index.js')).href)

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** The config row one install would carry. */
const config = {
  imageModels: [
    {
      id: 'img-1',
      name: 'Relay',
      protocol: 'openai-images',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      headers: [],
      promptFormat: 'natural',
      promptPassThrough: 'auto',
      promptPrefix: '',
      promptNegative: '',
      promptTemplate: '',
      params: { size: '', width: 1024, height: 1024, steps: 0, timeoutMs: 5000 },
      isDefault: true,
    },
  ],
  nativeImageRoutes: [],
  autoGenerate: true,
  announce: true,
  autoImageCount: 1,
  autoWidth: 0,
  autoHeight: 0,
}

/**
 * A fake plugin context: records registrations, resolves injected services, and
 * lets a test raise `agent/created` and dispatch `agent/pre-step` by hand.
 */
function fakeContext(rowConfig) {
  const validated = host.Config(rowConfig ?? {})
  const services = {
    tools: { registered: [], register(definition) { this.registered.push(definition); return () => {} } },
    attachments: {
      saved: [],
      async saveImage(input) {
        this.saved.push(input)
        return { attachmentId: `att-${String(this.saved.length)}`, mediaType: input.mediaType, bytes: input.data.length, width: 1024, height: 1024, name: input.name }
      },
    },
    settings: { configure: () => () => {} },
    systemPrompt: { sections: [], section(section) { this.sections.push(section); return () => {} } },
    // The real runtime has this service, and it is the surface a settings write
    // lands on — so the plugin reads its section from here. A test that passes its
    // own config to `apply` must therefore also see that config here, or it would be
    // asserting against a plugin that correctly ignored it.
    configEditor: { entries: () => [{ options: { id: 'image-studio', config: validated } }] },
  }
  const listeners = new Map()
  const warnings = []
  /**
   * The context object: a proxy over the base context that also exposes each
   * service as a property (`ctx.tools`, `ctx.settings`, …), which is how an
   * injected scope context behaves. A service that is not mounted stays undefined.
   */
  const base = {
    // A real fiber carries its *validated* config, not the Loader row wrapper, and
    // the config editor is the surface a settings write lands on.
    fiber: { config: validated },
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => services[name],
    effect: runEffect,
    inject: (names, callback) => {
      callback(ctx)
      return () => {}
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
  }
  const ctx = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key]
      return services[key]
    },
    has: (target, key) => key in target || key in services,
  })
  return { ctx, services, warnings, listeners }
}

/** A fake agent whose `agent.ctx` records the listeners registered on it. */
function fakeAgent(id, options = {}) {
  const on = new Map()
  const agent = {
    id,
    options,
    session: { requestHeader: () => ({ config: options.header }) },
    ctx: {
      on: (event, listener) => {
        const list = on.get(event) ?? []
        list.push(listener)
        on.set(event, list)
        return () => {}
      },
      // A generator callback is the idiom for registering several resources under
      // one effect, so the fake must iterate it rather than call it once.
      effect: runEffect,
    },
  }
  /** The listeners one event carries, in registration order. */
  agent.listenersFor = (event) => on.get(event) ?? []
  return agent
}

/**
 * Run an effect callback the way a cordis context does: call it, and if it is a
 * generator, drain it so its yielded registrations actually happen.
 *
 * @param fn - the callback, plain or generator.
 * @returns a disposer that drains the generator's return value when it has one.
 */
function runEffect(fn) {
  const returned = fn()
  if (returned === null || returned === undefined || typeof returned !== 'object' || typeof returned.next !== 'function') {
    return typeof returned === 'function' ? returned : () => {}
  }
  // Generator: drive it to completion, collecting the final return value.
  let step = returned.next()
  while (step.done !== true) step = returned.next(step.value)
  const disposed = step.value
  return typeof disposed === 'function' ? disposed : () => {}
}

/** The stubbed provider transport, answering an OpenAI-style payload. */
const stubFetch = () => async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
})

/** Build the payload the loop actually dispatches for `agent/pre-step`. */
const preStep = (messages) => ({ messages, turn: 1, step: 1, signal: new AbortController().signal })

// --------------------------------------------------------------------- wiring

await check('apply registers the tools, the prompt section, and one listener per service', () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  assert.deepEqual(
    services.tools.registered.map((definition) => definition.name).sort(),
    ['generate_image', 'image_studio_status'],
    'both tools are registered',
  )
  const generate = services.tools.registered.find((definition) => definition.name === 'generate_image')
  assert.equal(typeof generate.execute, 'function')
  assert.equal(services.systemPrompt.sections.length, 1)
  assert.equal(services.systemPrompt.sections[0].name, 'image-studio')
})

await check('the registered tool declares a registry-shaped definition', () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const definition = services.tools.registered[0]
  assert.equal(typeof definition.description, 'string')
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['prompt'])
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.output.schema, 'object')
  assert.equal(definition.isConcurrencySafe(), false)
})

await check('agent/created installs a pre-step listener on the agent context', () => {
  const { ctx } = fakeContext(config)
  host.apply(ctx, config)
  const agent = fakeAgent('s1', { provider: 'deepseek-account', model: 'deepseek-flash' })
  ctx.emit('agent/created', { agent })
  assert.equal(agent.listenersFor('agent/pre-step').length, 1, 'one scheduler listener is installed')
})

// ------------------------------------------------ reading the live configuration

await check('the live section survives validation of a volatile field', async () => {
  // Regression: `.volatile()` validates into a getter-backed reference, and a JSON
  // snapshot of that wrapper is `{}` — which would erase the model list entirely.
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const definition = services.tools.registered[0]
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch()
  let value
  try {
    value = await definition.execute({ prompt: 'a cat' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1, `the configured model must be visible; summary was: ${value.summary}`)
})

await check('a stale activation config does not mask the saved row', async () => {
  // Regression: the row of a bundle-provided plugin is not in the profile patch, so
  // the `config` argument captured at activation can predate every saved model. The
  // owner's entry is the surface a settings write lands on and must win.
  const activationConfig = { imageModels: [], autoGenerate: true }
  const savedRow = { imageModels: config.imageModels, autoGenerate: true }
  const { ctx, services } = fakeContext(activationConfig)
  // The config editor exposes the saved row, exactly as the Settings page writes it.
  services.configEditor = { entries: () => [{ options: { id: 'image-studio', config: savedRow } }] }
  host.apply(ctx, activationConfig)
  const definition = services.tools.registered[0]
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch()
  let value
  try {
    value = await definition.execute({ prompt: 'a cat' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1, `the saved row must be read; summary was: ${value.summary}`)
  assert.equal(value.modelName, 'Relay')
})

await check('an unreadable candidate falls through to the next one', async () => {
  // A candidate the schema rejects (here: a `!!js` expression in a scalar field)
  // must not mask a usable candidate behind it.
  const activationConfig = { imageModels: config.imageModels, autoGenerate: true }
  const { ctx, services } = fakeContext(activationConfig)
  services.configEditor = { entries: () => [{ options: { id: 'image-studio', config: { autoGenerate: { __jsExpr: 'true' } } } }] }
  host.apply(ctx, activationConfig)
  const definition = services.tools.registered[0]
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch()
  let value
  try {
    value = await definition.execute({ prompt: 'a cat' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1, `the fallback candidate must be used; summary was: ${value.summary}`)
})

await check('a context without a config editor still reads its own config', async () => {
  const { ctx, services } = fakeContext(config)
  delete services.configEditor
  host.apply(ctx, config)
  const definition = services.tools.registered[0]
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch()
  let value
  try {
    value = await definition.execute({ prompt: 'a cat' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1, 'the fiber config remains a valid source')
})

await check('the self-check reports what the plugin resolved, without echoing the key', async () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const status = services.tools.registered.find((definition) => definition.name === 'image_studio_status')
  assert.notEqual(status, undefined, 'the self-check is registered')
  const value = await status.execute({}, { signal: new AbortController().signal })
  assert.match(value.summary, /1 model\(s\) configured/)
  assert.match(value.summary, /Relay/)
  assert.match(value.summary, /key=set \(7 chars\)/, 'the key is reported as present, by length')
  assert.doesNotMatch(value.summary, /sk-test/, 'the key value must never be echoed')
  assert.equal(value.modelCount, 1)
})

await check('the self-check explains an empty configuration', async () => {
  const empty = { ...config, imageModels: [] }
  const { ctx, services } = fakeContext(empty)
  host.apply(ctx, empty)
  const status = services.tools.registered.find((definition) => definition.name === 'image_studio_status')
  const value = await status.execute({}, { signal: new AbortController().signal })
  assert.match(value.summary, /0 model\(s\) configured/)
  assert.match(value.summary, /No image model is visible/)
})

// ------------------------------------------------------------ the automatic path

await check('a picture request adds an image message to the step, with no model change', async () => {
  const { ctx, services, warnings } = fakeContext(config)
  host.apply(ctx, config)
  const agent = fakeAgent('s1', { provider: 'deepseek-account', model: 'deepseek-flash' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]

  // The plugin's transport is injected through the global fetch it reads.
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch()
  let decision
  try {
    decision = await listener(
      preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我生成一张猫咪的图片' }] }]),
      async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我生成一张猫咪的图片' }] }] }),
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(decision.kind, 'enter', 'the step still enters')
  assert.equal(decision.messages.length, 2, 'the image message is appended to the step')
  const added = decision.messages[1]
  assert.equal(added.role, 'user')
  assert.equal(added.source.kind, 'image-studio', 'the message is stamped as ours')
  assert.equal(typeof added.id, 'string')
  assert.equal(Object.isFrozen(added), true, 'the message is frozen before publication')
  const image = added.content.find((block) => block.type === 'image')
  assert.notEqual(image, undefined, 'the step carries the image block')
  assert.equal(image.attachment.attachmentId, 'att-1')
  assert.equal(services.attachments.saved.length, 1)
})

await check('a request with no image intent leaves the decision untouched', async () => {
  const { ctx } = fakeContext(config)
  host.apply(ctx, config)
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  const original = { kind: 'enter', messages: [{ id: 'm1' }] }
  const decision = await listener(preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '这段代码为什么报错？' }] }]), async () => original)
  assert.equal(decision, original, 'the very same decision object is returned')
})

await check('a native-capable conversation route is left completely alone', async () => {
  const native = { ...config, nativeImageRoutes: ['deepseek-account/dall-e-3'] }
  const { ctx, services } = fakeContext(native)
  host.apply(ctx, native)
  const agent = fakeAgent('s1', { provider: 'deepseek-account', model: 'dall-e-3' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  const original = { kind: 'enter', messages: [{ id: 'm1' }] }
  const decision = await listener(preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '画一张猫' }] }]), async () => original)
  assert.equal(decision, original)
  assert.equal(services.attachments.saved.length, 0, 'nothing is generated for a native route')
})

await check('nothing configured contributes the settings guidance as a message', async () => {
  const empty = { ...config, imageModels: [] }
  const { ctx, services } = fakeContext(empty)
  host.apply(ctx, empty)
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  const decision = await listener(
    preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我画一张猫' }] }]),
    async () => ({ kind: 'enter', messages: [{ id: 'm1' }] }),
  )
  assert.equal(decision.messages.length, 2)
  const text = decision.messages[1].content[0].text
  assert.match(text, /Image generation models/)
  assert.equal(services.attachments.saved.length, 0)
})

await check('autoGenerate off disables the automatic path entirely', async () => {
  const off = { ...config, autoGenerate: false }
  const { ctx, services } = fakeContext(off)
  host.apply(ctx, off)
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  const original = { kind: 'enter', messages: [{ id: 'm1' }] }
  const decision = await listener(preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '画一张猫' }] }]), async () => original)
  assert.equal(decision, original)
  assert.equal(services.attachments.saved.length, 0)
})

await check('a rejected decision is never rewritten', async () => {
  const { ctx } = fakeContext(config)
  host.apply(ctx, config)
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  const rejection = { kind: 'reject' }
  const decision = await listener(preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '画一张猫' }] }]), async () => rejection)
  assert.equal(decision, rejection)
})

await check('another plugin owning image generation makes the scheduler stand aside', async () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  const original = { kind: 'enter', messages: [{ id: 'm1' }] }
  const decision = await listener(
    preStep([
      { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '画一张猫' }] },
      { id: 'm2', role: 'user', source: { kind: 'skill-invocation' }, content: [{ type: 'tool-call', name: 'mcp__imagegen__create', arguments: {} }] },
    ]),
    async () => original,
  )
  assert.equal(decision, original, 'the author\'s own tool wins and nothing is injected')
  assert.equal(services.attachments.saved.length, 0, 'no second generation is started')
})

await check('the tools expose the new parameter and tracer surfaces', () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const generate = services.tools.registered.find((definition) => definition.name === 'generate_image')
  for (const name of ['ratio', 'style', 'negative', 'width', 'height', 'count', 'source', 'model']) {
    assert.ok(Object.hasOwn(generate.parameters.properties, name), `the tool must accept ${name}`)
  }
  for (const name of ['promptSent', 'endpoint', 'parameters', 'degraded']) {
    assert.ok(Object.hasOwn(generate.output.schema.properties, name), `the result must expose ${name}`)
  }
})

await check('the tool explains a rejected ratio instead of sending it', async () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const generate = services.tools.registered.find((definition) => definition.name === 'generate_image')
  const value = await generate.execute({ prompt: 'a cat', ratio: 'wide-ish' }, { signal: new AbortController().signal })
  assert.match(value.summary, /not understood/)
  assert.match(value.summary, /16:9/)
  assert.deepEqual(value.images, [])
})

await check('a ratio stated in the prompt reaches the request body', async () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const generate = services.tools.registered.find((definition) => definition.name === 'generate_image')
  const bodies = []
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) }
  }
  let value
  try {
    value = await generate.execute({ prompt: '画一张 16:9 的横版插画，两只猫', source: 'user' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1, `generation failed: ${value.summary}`)
  assert.equal(bodies[0].size, '1344x768', 'the parsed ratio must become the API size field')
  assert.equal(value.parameters.ratio, '16:9')
  assert.doesNotMatch(bodies[0].prompt, /16:9/, 'the digits are plumbing and stay out of the prompt')
  assert.match(bodies[0].prompt, /横版插画/, 'the descriptive word stays')
})

await check('a negative prompt is carried into the prompt for a protocol without the field', async () => {
  const sd = {
    ...config,
    imageModels: [{ ...config.imageModels[0], protocol: 'stability-sd-webui', baseUrl: 'http://127.0.0.1:7860', promptPrefix: '', promptNegative: '' }],
  }
  const { ctx, services } = fakeContext(sd)
  host.apply(ctx, sd)
  const generate = services.tools.registered.find((definition) => definition.name === 'generate_image')
  const bodies = []
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ images: [png.toString('base64')] }) }
  }
  let value
  try {
    value = await generate.execute({ prompt: 'a cat', negative: 'blurry, text' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1, `generation failed: ${value.summary}`)
  assert.match(bodies[0].prompt, /Negative prompt: blurry, text/)
  assert.equal(value.parameters.negative, 'blurry, text')
})

await check('the scheduler defaults are clamped before they reach a request', async () => {
  const wild = { ...config, autoImageCount: 99, autoWidth: 99999, autoHeight: 99999 }
  const { ctx, services } = fakeContext(wild)
  host.apply(ctx, wild)
  const bodies = []
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          data: [
            { b64_json: png.toString('base64') },
            { b64_json: png.toString('base64') },
            { b64_json: png.toString('base64') },
            { b64_json: png.toString('base64') },
            { b64_json: png.toString('base64') },
          ],
        }),
    }
  }
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  let decision
  try {
    decision = await listener(preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '画一张猫' }] }]), async () => ({ kind: 'enter', messages: [{ id: 'm1' }] }))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(bodies[0].n, 4, 'the count is clamped to the maximum')
  assert.equal(bodies[0].size, '4096x4096', 'both sides are clamped to the dimension limit')
  assert.equal(services.attachments.saved.length, 4, 'the clamped count is what actually runs')
})

await check('a count written in the sentence beats the configured default', async () => {
  // Regression: the plugin's own default was passed in the *explicit* slot, so the
  // configured `autoImageCount` silently overrode what the user actually wrote.
  const configured = { ...config, autoImageCount: 2 }
  const { ctx, services } = fakeContext(configured)
  host.apply(ctx, configured)
  const bodies = []
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) }
  }
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  try {
    await listener(
      preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我生成 3 张猫咪的图片' }] }]),
      async () => ({ kind: 'enter', messages: [{ id: 'm1' }] }),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(bodies[0].n, 3, 'the sentence asked for three, so three are requested')
})

await check('the configured default applies when the sentence says nothing', async () => {
  const configured = { ...config, autoImageCount: 2 }
  const { ctx, services } = fakeContext(configured)
  host.apply(ctx, configured)
  const bodies = []
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) }
  }
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  try {
    await listener(preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我画一只猫咪' }] }]), async () => ({ kind: 'enter', messages: [{ id: 'm1' }] }))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(bodies[0].n, 2, 'with no count in the sentence, the configured default is used')
})

await check('a provider returning fewer images than requested says so', async () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const generate = services.tools.registered.find((definition) => definition.name === 'generate_image')
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  // One image in the payload, three requested: a paid-op discrepancy the user must see.
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) })
  let value
  try {
    value = await generate.execute({ prompt: 'a cat', count: 3 }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1)
  assert.match(value.summary, /Note: the provider returned 1 of the 3 requested image/)
  assert.ok(value.parameters.notes.some((note) => note.includes('returned 1 of the 3')), 'the trace records it too')
})

await check('a transport failure is logged, not turned into a chat message', async () => {
  const { ctx, services, warnings } = fakeContext(config)
  host.apply(ctx, config)
  const agent = fakeAgent('s1', { provider: 'p', model: 'm' })
  ctx.emit('agent/created', { agent })
  const listener = agent.listenersFor('agent/pre-step')[0]
  const original = { kind: 'enter', messages: [{ id: 'm1' }] }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'Error', text: async () => 'boom' })
  let decision
  try {
    decision = await listener(preStep([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '画一张猫' }] }]), async () => original)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(decision, original, 'the step is unchanged')
  assert.equal(services.attachments.saved.length, 0)
  assert.equal(warnings.length, 1, 'the failure is logged once')
})

// ----------------------------------------------------------- the model-driven door

await check('the tool generates an image and returns a renderable image block', async () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const definition = services.tools.registered[0]
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch()
  let value
  try {
    value = await definition.execute({ prompt: 'a cat on a windowsill' }, { signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(value.images.length, 1)
  assert.equal(value.modelName, 'Relay')
  assert.match(value.summary, /Generated 1 image/)
  assert.doesNotMatch(value.summary, /Note:/, 'one image requested and one returned is not a shortfall')
  // The prompt actually sent is part of the result, so the user can inspect it.
  assert.equal(value.promptSent, 'a cat on a windowsill')
  assert.equal(value.endpoint, 'https://relay.example/v1')
  const blocks = definition.output.render({ prompt: 'x' }, value)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'text', 'the prompt trace rides a text block')
  assert.match(blocks[1].text, /a cat on a windowsill/)
  const image = blocks.find((block) => block.type === 'image')
  assert.notEqual(image, undefined, 'the image block is present')
  assert.equal(image.attachment.attachmentId, 'att-1')
})

await check('the tool reports invalid arguments instead of throwing', async () => {
  const { ctx, services } = fakeContext(config)
  host.apply(ctx, config)
  const definition = services.tools.registered[0]
  const empty = await definition.execute({}, { signal: new AbortController().signal })
  assert.match(empty.summary, /not understood/)
  assert.deepEqual(empty.images, [])
  const badCount = await definition.execute({ prompt: 'x', count: 9 }, { signal: new AbortController().signal })
  assert.match(badCount.summary, /count must be at most 4/)
})

await check('the tool relays the guidance when no model is configured', async () => {
  const empty = { ...config, imageModels: [] }
  const { ctx, services } = fakeContext(empty)
  host.apply(ctx, empty)
  const value = await services.tools.registered[0].execute({ prompt: 'a cat' }, { signal: new AbortController().signal })
  assert.match(value.summary, /Image generation models/)
  assert.deepEqual(value.images, [])
})

await check('the tool reports a native route without generating anything', async () => {
  const native = { ...config, nativeImageRoutes: ['p/m'] }
  const { ctx, services } = fakeContext(native)
  host.apply(ctx, native)
  // A tool call carries the calling agent, which is how the live route is read.
  const agent = fakeAgent('s1', { provider: 'p', model: 'm', header: { provider: 'p', model: 'm' } })
  const value = await services.tools.registered[0].execute({ prompt: 'a cat' }, { agent, signal: new AbortController().signal })
  assert.equal(value.handledByModel, true)
  assert.match(value.summary, /left to it/)
  assert.deepEqual(value.images, [])
})

console.log(failures === 0 ? '\nall host-wiring checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
