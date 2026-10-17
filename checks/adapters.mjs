/**
 * Adapter behavior against a stubbed transport: request shape per protocol, and
 * the response-reading rules that decide whether bytes are usable.
 *
 * Run: node checks/adapters.mjs
 */
import assert from 'node:assert/strict'

import { buildBody, buildHeaders, buildUrl, generate, readOpenAiImagesBody, readSdWebUiBody, sniffMediaType } from '../src/adapters.mjs'

let failures = 0
/** Run one named case, recording failure instead of aborting the suite. */
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((error) => {
      failures += 1
      console.log(`FAIL ${name}\n     ${error.message}`)
    })
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8])

const model = (overrides = {}) => ({
  id: 'm1',
  name: 'Relay',
  protocol: 'openai-images',
  baseUrl: 'https://relay.example/v1',
  apiKey: 'sk-test',
  model: 'gpt-image-1',
  headers: [],
  params: { size: 'square', width: 1024, height: 1024, steps: 0, timeoutMs: 5000 },
  ...overrides,
})

/** A fetch stub that records calls and answers with one canned response. */
function stubFetch(response) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = typeof response === 'function' ? response(url, init, calls.length) : response
    return next
  }
  impl.calls = calls
  return impl
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  text: async () => JSON.stringify(body),
})

// ------------------------------------------------------------------ URL shapes

await check('OpenAI generations URL is appended to the base', () => {
  assert.equal(buildUrl('openai-images', 'https://relay.example/v1'), 'https://relay.example/v1/images/generations')
  assert.equal(buildUrl('openai-images', 'https://relay.example/v1/'), 'https://relay.example/v1/images/generations')
})

await check('a base that already ends in /images is not doubled', () => {
  assert.equal(buildUrl('openai-images', 'https://relay.example/v1/images'), 'https://relay.example/v1/images/generations')
})

await check('SD WebUI uses the txt2img route', () => {
  assert.equal(buildUrl('stability-sd-webui', 'http://127.0.0.1:7860'), 'http://127.0.0.1:7860/sdapi/v1/txt2img')
})

// ------------------------------------------------------------------ body shape

await check('OpenAI body carries the model identifier, prompt, size and count', () => {
  // The display name and the provider's identifier are different fields: the body
  // must carry the identifier, or the provider is asked for a model it does not have.
  const body = buildBody(
    'openai-images',
    { modelName: 'My Image Model', modelIdentifier: 'gpt-image-1', prompt: 'a cat', params: { size: '1024x1024' } },
    2,
  )
  assert.deepEqual(body, { model: 'gpt-image-1', prompt: 'a cat', size: '1024x1024', n: 2 })
})

await check('OpenAI body omits size when unset and count when one', () => {
  const body = buildBody('openai-images', { modelName: 'Display', modelIdentifier: 'm', prompt: 'a cat', params: {} }, 1)
  assert.deepEqual(body, { model: 'm', prompt: 'a cat' })
})

await check('a resolved model without an identifier falls back to nothing harmful', () => {
  // Guards the shape used by the degradation path, which builds a resolved object
  // from a stored record: an identifier must always be derivable from the record.
  const body = buildBody('openai-images', { modelName: 'Display', modelIdentifier: undefined, prompt: 'x', params: {} }, 1)
  assert.equal(body.model, undefined, 'an absent identifier must not become the display name')
})

await check('SD body uses width, height, steps and batch_size', () => {
  const body = buildBody('stability-sd-webui', { prompt: 'cat', params: { width: 1024, height: 768, steps: 28 } }, 3)
  assert.deepEqual(body, { prompt: 'cat', width: 1024, height: 768, steps: 28, batch_size: 3 })
})

// --------------------------------------------------------------------- headers

await check('the API key becomes a bearer header', () => {
  const headers = buildHeaders(model(), 'sk-abc')
  assert.equal(headers.authorization, 'Bearer sk-abc')
  assert.equal(headers['content-type'], 'application/json')
})

await check('a stored header row wins over the derived bearer header', () => {
  const headers = buildHeaders(model({ headers: [{ name: 'Authorization', value: 'Token custom' }] }), 'sk-abc')
  assert.equal(headers.authorization, 'Token custom')
})

await check('header names are lower-cased and empty rows are dropped', () => {
  const headers = buildHeaders(model({ headers: [{ name: 'X-Tenant', value: 'acme' }, { name: '  ', value: 'x' }] }), '')
  assert.equal(headers['x-tenant'], 'acme')
  assert.equal(headers.authorization, undefined)
})

// ------------------------------------------------------------ response readers

await check('an OpenAI b64_json answer is decoded', () => {
  const { images } = readOpenAiImagesBody({ data: [{ b64_json: PNG.toString('base64') }] })
  assert.equal(images.length, 1)
  assert.deepEqual(Buffer.from(images[0].data), PNG)
})

await check('an OpenAI url answer is reported as a url', () => {
  const { images } = readOpenAiImagesBody({ data: [{ url: 'https://cdn.example/a.png' }] })
  assert.deepEqual(images, [{ url: 'https://cdn.example/a.png' }])
})

await check('a bare array answer is accepted', () => {
  const { images } = readOpenAiImagesBody([{ b64_json: JPEG.toString('base64') }])
  assert.equal(images.length, 1)
})

await check('a data URL answer is decoded', () => {
  const { images } = readOpenAiImagesBody({ data: [{ b64_json: `data:image/png;base64,${PNG.toString('base64')}` }] })
  assert.equal(images[0].mediaType, 'image/png')
  assert.deepEqual(Buffer.from(images[0].data), PNG)
})

await check('an SD WebUI images array is decoded', () => {
  const { images } = readSdWebUiBody({ images: [PNG.toString('base64'), 'data:image/jpeg;base64,' + JPEG.toString('base64')], info: '{}' })
  assert.equal(images.length, 2)
  assert.equal(images[1].mediaType, 'image/jpeg')
})

await check('an unreadable body yields no images instead of throwing', () => {
  assert.deepEqual(readOpenAiImagesBody({ error: 'nope' }).images, [])
  assert.deepEqual(readSdWebUiBody(null).images, [])
  assert.deepEqual(readOpenAiImagesBody('a string').images, [])
})

await check('magic bytes identify the format', () => {
  assert.equal(sniffMediaType(PNG), 'image/png')
  assert.equal(sniffMediaType(JPEG), 'image/jpeg')
  assert.equal(sniffMediaType(Buffer.from([1, 2, 3])), undefined)
})

// ------------------------------------------------------------------ generation

await check('a successful OpenAI call returns usable image bytes', async () => {
  const fetchImpl = stubFetch(jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] }))
  const result = await generate({ model: model(), resolved: { modelName: 'gpt-image-1', prompt: 'a cat', params: {} }, count: 1, apiKey: 'sk-test', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mediaType, 'image/png')
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://relay.example/v1/images/generations')
})

await check('an image URL in the answer is fetched', async () => {
  const fetchImpl = stubFetch((url) => {
    if (url === 'https://cdn.example/a.png') {
      return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) }
    }
    return jsonResponse({ data: [{ url: 'https://cdn.example/a.png' }] })
  })
  const result = await generate({ model: model(), resolved: { modelName: 'm', prompt: 'a cat', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.images[0].mediaType, 'image/png')
  assert.equal(fetchImpl.calls.length, 2)
})

await check('an HTTP error is reported with its status and the provider message', async () => {
  const fetchImpl = stubFetch(jsonResponse({ error: { code: '1302', message: 'rate limit reached' } }, 429))
  const result = await generate({ model: model(), resolved: { modelName: 'm', prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'http-error')
  assert.equal(result.status, 429)
  assert.match(result.message, /HTTP 429/)
  assert.match(result.message, /1302: rate limit reached/, 'the provider message must be legible')
  assert.doesNotMatch(result.message, /\\"/, 'the message must not be escaped JSON')
})

await check('a non-JSON error body is reported as plain text', async () => {
  const fetchImpl = stubFetch({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '<html>bad gateway</html>' })
  const result = await generate({ model: model(), resolved: { modelName: 'm', prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.message, /HTTP 502/)
  assert.match(result.message, /bad gateway/)
})

await check('a non-JSON answer is reported, not thrown', async () => {
  const fetchImpl = stubFetch({ ok: true, status: 200, statusText: 'OK', text: async () => '<html>nope</html>' })
  const result = await generate({ model: model(), resolved: { modelName: 'm', prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad-json')
})

await check('an answer with no usable image is reported', async () => {
  const fetchImpl = stubFetch(jsonResponse({ data: [] }))
  const result = await generate({ model: model(), resolved: { modelName: 'm', prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-image')
})

await check('a deadline is reported as a timeout, not as a cancellation', async () => {
  // A transport that never answers, with a tiny deadline.
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  const result = await generate({ model: model(), resolved: { modelName: 'm', prompt: 'x', params: { timeoutMs: 30 } }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout', `got ${result.reason}: ${result.message}`)
  assert.match(result.message, /did not answer within/)
  assert.match(result.message, /timeout/, 'the message must tell the user what to raise')
})

await check('a caller cancellation is reported as aborted, not as a timeout', async () => {
  const controller = new AbortController()
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  const pending = generate({
    model: model(),
    resolved: { modelName: 'm', prompt: 'x', params: { timeoutMs: 5000 } },
    count: 1,
    apiKey: '',
    fetchImpl,
    signal: controller.signal,
  })
  controller.abort(new Error('user cancelled'))
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'aborted', `got ${result.reason}: ${result.message}`)
})

await check('a protocol with no adapter is refused before any request', async () => {
  const fetchImpl = stubFetch(jsonResponse({}))
  const result = await generate({ model: model({ protocol: 'custom' }), resolved: { prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsupported-protocol')
  assert.equal(fetchImpl.calls.length, 0)
})

await check('a non-HTTP endpoint is refused before any request', async () => {
  const fetchImpl = stubFetch(jsonResponse({}))
  const result = await generate({ model: model({ baseUrl: 'ftp://x/y' }), resolved: { prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad-endpoint')
  assert.equal(fetchImpl.calls.length, 0)
})

await check('an already-aborted signal stops before any request', async () => {
  const fetchImpl = stubFetch(jsonResponse({}))
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const result = await generate({ model: model(), resolved: { prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl, signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'aborted')
  assert.equal(fetchImpl.calls.length, 0)
})

await check('only the requested number of images is returned', async () => {
  const fetchImpl = stubFetch(jsonResponse({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: JPEG.toString('base64') }] }))
  const result = await generate({ model: model(), resolved: { prompt: 'x', params: {} }, count: 1, apiKey: '', fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 1)
})

console.log(failures === 0 ? '\nall adapter checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
