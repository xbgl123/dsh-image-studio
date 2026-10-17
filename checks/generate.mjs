/**
 * The orchestration layer: detecting a request inside a step's claimed messages,
 * and the routing/refusal outcomes `runImageRequest` produces.
 *
 * Run: node checks/generate.mjs
 */
import assert from 'node:assert/strict'

import { describeOutcome, detectRequestInMessages, runImageRequest } from '../src/generate.mjs'

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

/** One claimed user message, shaped like the runtime's `UserMessage`. */
const userMessage = (text, sourceKind = 'user') => ({
  id: `m-${text.slice(0, 4)}`,
  role: 'user',
  source: { kind: sourceKind },
  content: [{ type: 'text', text }],
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** A stub attachment service that records what it was asked to store. */
function stubAttachments() {
  const saved = []
  return {
    saved,
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: `att-${String(saved.length)}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1024,
        height: 1024,
        ...(input.name === undefined ? {} : { name: input.name }),
      }
    },
  }
}

/** A stub fetch answering one OpenAI-style payload. */
const stubFetch = (body, status = 200) => async () => ({
  ok: status === 200,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  text: async () => JSON.stringify(body),
})

/**
 * A stub fetch that answers in the shape the called protocol actually returns:
 * Stable Diffusion wraps base64 strings in `images`, OpenAI wraps them in `data`.
 */
const protocolAwareFetch = async (url) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () =>
    /sdapi/.test(String(url))
      ? JSON.stringify({ images: [PNG.toString('base64')], info: '{}' })
      : JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
})

const model = {
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
  params: { size: 'square', width: 1024, height: 1024, steps: 0, timeoutMs: 5000 },
  isDefault: true,
}

/** The live state `runImageRequest` reads. */
const stateWith = (overrides = {}) => ({
  models: [model],
  nativeRoutes: [],
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  attachments: stubAttachments(),
  fetchImpl: stubFetch({ data: [{ b64_json: PNG.toString('base64') }] }),
  ...overrides,
})

// ------------------------------------------------------- detection in messages

await check('a picture request in a user message is detected with its prompt', () => {
  const detected = detectRequestInMessages([userMessage('帮我生成一张猫咪的图片')], 'image-studio')
  assert.equal(detected.wanted, true)
  assert.equal(detected.prompt, '帮我生成一张猫咪的图片')
  assert.equal(detected.source, 'user')
})

await check('a conversation with no image request is left alone', () => {
  assert.equal(detectRequestInMessages([userMessage('这段代码为什么报错？')], 'image-studio').wanted, false)
})

await check('this plugin\'s own messages never trigger another generation', () => {
  const detected = detectRequestInMessages(
    [userMessage('[Image generation] Generated 1 image', 'image-studio'), userMessage('画一张猫')],
    'image-studio',
  )
  assert.equal(detected.wanted, true, 'the genuine request still fires')
  assert.equal(detected.prompt, '画一张猫', 'the plugin notice is not part of the prompt')
})

await check('a skill-sourced message is reported as skill provenance', () => {
  const detected = detectRequestInMessages([userMessage('generate an image of a logo', 'skill-invocation')], 'image-studio')
  assert.equal(detected.wanted, true)
  assert.equal(detected.source, 'skill')
})

await check('messages without text blocks are skipped, not crashed on', () => {
  const imageOnly = { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] }
  assert.equal(detectRequestInMessages([imageOnly], 'image-studio').wanted, false)
  assert.equal(detectRequestInMessages([null, undefined, 'nope'], 'image-studio').wanted, false)
  assert.equal(detectRequestInMessages(undefined, 'image-studio').wanted, false)
})

await check('a plugin notice is skipped and only genuine requests form the prompt', () => {
  const detected = detectRequestInMessages(
    [userMessage('[Image generation] Generated 1 image', 'image-studio'), userMessage('再画一只狗')],
    'image-studio',
  )
  assert.equal(detected.wanted, true, 'the genuine request still fires')
  assert.equal(detected.prompt, '再画一只狗', 'the plugin notice never enters the prompt')
})

await check('two requests in one step are merged in order', () => {
  const detected = detectRequestInMessages([userMessage('生成图片：一只猫'), userMessage('再画一只狗')], 'image-studio')
  assert.equal(detected.wanted, true)
  assert.equal(detected.prompt, '生成图片：一只猫\n再画一只狗')
})

// ------------------------------------------------------------------ routing

await check('a native-capable conversation route is never called out to', async () => {
  const state = stateWith({ nativeRoutes: ['deepseek-account/dall-e-3'], provider: 'deepseek-account', model: 'dall-e-3' })
  const result = await runImageRequest(state, { prompt: 'a cat' })
  assert.equal(result.ok, true)
  assert.equal(result.handledByModel, true)
  assert.equal(state.attachments.saved.length, 0, 'nothing may be generated or stored')
})

await check('a non-native route generates with the default model and stores the image', async () => {
  const state = stateWith()
  const result = await runImageRequest(state, { prompt: 'a cat on a windowsill' })
  assert.equal(result.ok, true)
  assert.equal(result.handledByModel, undefined)
  assert.equal(result.refs.length, 1)
  assert.equal(state.attachments.saved.length, 1)
  assert.equal(state.attachments.saved[0].mediaType, 'image/png')
  assert.equal(result.decision.passThrough, true, 'a natural prompt to an OpenAI model passes through')
  assert.equal(result.decision.modelId, 'img-1')
})

await check('no configured model returns the settings guidance and calls nothing', async () => {
  let called = false
  const state = stateWith({ models: [], fetchImpl: async () => { called = true } })
  const result = await runImageRequest(state, { prompt: 'a cat' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unconfigured')
  assert.match(result.message, /Image generation models/)
  assert.equal(called, false)
})

await check('a default that cannot be served is refused, not silently skipped', async () => {
  const state = stateWith({ models: [{ ...model, protocol: 'custom' }] })
  const result = await runImageRequest(state, { prompt: 'a cat' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unusable')
  assert.equal(state.attachments.saved.length, 0)
})

await check('an empty prompt is refused before routing', async () => {
  const result = await runImageRequest(stateWith(), { prompt: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'empty')
})

await check('a provider failure is reported without storing anything', async () => {
  const state = stateWith({ fetchImpl: stubFetch({ error: 'nope' }, 500) })
  const result = await runImageRequest(state, { prompt: 'a cat' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'http-error')
  assert.equal(state.attachments.saved.length, 0)
})

await check('an explicit model id selects that model', async () => {
  const second = { ...model, id: 'img-2', name: 'Second', isDefault: false }
  const state = stateWith({ models: [model, second] })
  const result = await runImageRequest(state, { prompt: 'a cat', modelId: 'img-2' })
  assert.equal(result.ok, true)
  assert.equal(result.decision.modelId, 'img-2')
})

await check('a skill prompt keeps its text and skips the stored defaults', async () => {
  const withDefaults = { ...model, promptPrefix: 'HQ, ', promptNegative: 'blurry' }
  const state = stateWith({ models: [withDefaults] })
  const result = await runImageRequest(state, { prompt: 'a very specific logo prompt', source: 'skill' })
  assert.equal(result.ok, true)
  assert.equal(result.decision.prompt, 'a very specific logo prompt', 'no prefix, no negative, no rewrite')
  assert.equal(result.decision.passThrough, true)
})

await check('a skill prompt with the wrong format is held rather than converted', async () => {
  const sd = {
    ...model,
    id: 'sd-1',
    name: 'Local SD',
    protocol: 'stability-sd-webui',
    baseUrl: 'http://127.0.0.1:7860',
    promptPrefix: 'masterpiece',
    promptNegative: 'worst quality',
    isDefault: true,
  }
  const state = stateWith({ models: [sd], fetchImpl: protocolAwareFetch })
  const result = await runImageRequest(state, { prompt: '一只猫坐在窗台上。', source: 'skill' })
  assert.equal(result.ok, true)
  assert.equal(result.decision.passThrough, true)
  assert.equal(result.decision.reason, 'auto-optimized-hold')
  assert.equal(result.decision.prompt, '一只猫坐在窗台上。')
})

await check('a caller width and height override the stored size', async () => {
  let body
  const state = stateWith({
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) }
    },
  })
  await runImageRequest(state, { prompt: 'a cat', width: 768, height: 1344 })
  assert.equal(body.size, '768x1344')
})

await check('a missing attachment service is reported instead of losing the image', async () => {
  const state = stateWith({ attachments: undefined })
  const result = await runImageRequest(state, { prompt: 'a cat' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'no-attachments')
})

// ------------------------------------------------------------------ wording

await check('the generated outcome reads as a factual report', () => {
  const text = describeOutcome(
    {
      ok: true,
      refs: [{}],
      trace: {
        modelId: 'img-1',
        modelName: 'Relay',
        protocol: 'openai-images',
        endpoint: 'https://relay.example/v1',
        promptSent: 'a cat',
        parameters: { width: 1024, height: 768, count: 1 },
      },
      decision: { modelId: 'img-1', modelName: 'Relay', protocol: 'openai-images', passThrough: true, translated: false, reason: 'auto-format-match', sourceFormat: 'natural', targetFormat: 'natural' },
    },
    { source: 'user' },
  )
  assert.match(text, /Generated 1 image at 1024x768px with the model "Relay"/)
  assert.match(text, /passed through unchanged/)
  // Traceability: the model, its endpoint, and the exact prompt sent are reported.
  assert.match(text, /endpoint=https:\/\/relay\.example\/v1/)
  assert.match(text, /prompt sent = "a cat"/)
})

await check('a shortfall against the requested count is reported', () => {
  const text = describeOutcome(
    {
      ok: true,
      refs: [{}],
      trace: { modelName: 'Relay', promptSent: 'a cat', parameters: { notes: ['the provider returned 1 of the 2 requested image(s)'] } },
      decision: { modelName: 'Relay', protocol: 'openai-images', passThrough: true, reason: 'auto-format-match', sourceFormat: 'natural', targetFormat: 'natural' },
    },
    { source: 'user' },
  )
  assert.match(text, /Note: the provider returned 1 of the 2 requested image/)
})

await check('a degraded translation is reported as such', () => {
  const text = describeOutcome(
    {
      ok: true,
      refs: [{}],
      trace: { modelName: 'Relay', promptSent: 'a cat', parameters: {} },
      decision: { modelName: 'Relay', protocol: 'openai-images', translated: false, degraded: true, reason: 'translation-fallback-passthrough', sourceFormat: 'unknown', targetFormat: 'unknown' },
    },
    { source: 'user' },
  )
  assert.match(text, /translator was unavailable/)
  assert.match(text, /sent verbatim/)
})

await check('an unconfigured outcome is passed through verbatim as the guidance', () => {
  const guidance = 'This request needs an image model, but none is connected yet.'
  assert.equal(describeOutcome({ ok: false, kind: 'unconfigured', message: guidance }, {}), guidance)
})

await check('the native outcome says nothing was generated', () => {
  assert.match(describeOutcome({ ok: true, handledByModel: true }, {}), /Nothing was generated/)
})

console.log(failures === 0 ? '\nall orchestration checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
