/**
 * Image-generation protocol adapters.
 *
 * Each adapter turns one resolved request into HTTP calls and brings the bytes
 * back. No adapter decides *which* model to use or *how* to phrase the prompt —
 * that is the router's and the translator's job — so a wrong image is always
 * traceable to exactly one layer.
 *
 * The response readers are exported separately so the parsing rules can be tested
 * offline against recorded payloads without a server.
 */

/** Protocols this module speaks. Anything else is refused, not guessed at. */
export const SUPPORTED_PROTOCOLS = ['openai-images', 'openai-images-edits', 'stability-sd-webui']

/** Media types the attachment service accepts. */
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Sniff a media type from magic bytes; the attachment service stays authoritative. */
export function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}

/** `data:image/png;base64,…` to bytes, or undefined when the shape is wrong. */
function decodeDataUrl(value) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/is.exec(String(value))
  if (match === null) return undefined
  try {
    return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], 'base64') }
  } catch (_failure) {
    return undefined
  }
}

/** Base64 payload to bytes, refusing the shapes `atob` would accept silently. */
function decodeBase64(value) {
  const text = String(value).replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return undefined
  try {
    const data = Buffer.from(text, 'base64')
    return data.length > 0 ? data : undefined
  } catch (_failure) {
    return undefined
  }
}

/**
 * Read the images out of an OpenAI Images response body.
 *
 * The documented shape is `{ data: [{ b64_json } | { url }] }`; relays in the
 * wild also answer with a bare array, or with `image` / `images` keys, so those
 * are accepted rather than treated as a failure.
 *
 * @param body - the decoded JSON body.
 * @returns `{ images }` entries carrying either `data` bytes or `url`.
 */
export function readOpenAiImagesBody(body) {
  const list = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object' && Array.isArray(body.data)
      ? body.data
      : body !== null && typeof body === 'object' && Array.isArray(body.images)
        ? body.images
        : body !== null && typeof body === 'object' && typeof body.image === 'string'
          ? [body]
          : []
  const images = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const decoded = decodeDataUrl(entry) ?? (decodeBase64(entry) === undefined ? undefined : { mediaType: undefined, data: decodeBase64(entry) })
      if (decoded !== undefined) images.push({ data: decoded.data, mediaType: decoded.mediaType })
      else if (/^https?:\/\//i.test(entry)) images.push({ url: entry })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const base64 = entry.b64_json ?? entry.base64 ?? entry.image
    if (typeof base64 === 'string') {
      const decoded = decodeDataUrl(base64)
      if (decoded !== undefined) images.push({ data: decoded.data, mediaType: decoded.mediaType })
      else {
        const bytes = decodeBase64(base64)
        if (bytes !== undefined) images.push({ data: bytes, mediaType: undefined })
      }
      continue
    }
    if (typeof entry.url === 'string' && entry.url.length > 0) images.push({ url: entry.url })
  }
  return { images }
}

/**
 * Read the images out of a Stable Diffusion WebUI response body.
 *
 * `images` is an array of base64 strings (optionally `data:` URLs); `info` is a
 * JSON string and is deliberately ignored here.
 *
 * @param body - the decoded JSON body.
 */
export function readSdWebUiBody(body) {
  const list = body !== null && typeof body === 'object' && Array.isArray(body.images) ? body.images : []
  const images = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const decoded = decodeDataUrl(entry)
    if (decoded !== undefined) {
      images.push({ data: decoded.data, mediaType: decoded.mediaType })
      continue
    }
    const bytes = decodeBase64(entry)
    if (bytes !== undefined) images.push({ data: bytes, mediaType: undefined })
  }
  return { images }
}

/** Pick a reader for a protocol. */
export function readerFor(protocol) {
  if (protocol === 'stability-sd-webui') return readSdWebUiBody
  return readOpenAiImagesBody
}

/** Strip one trailing slash so `base` and `/path` join predictably. */
function trimBase(baseUrl) {
  return String(baseUrl ?? '').replace(/\/+$/, '')
}

/** Build the request body for one protocol. */
export function buildBody(protocol, resolved, count) {
  const size = resolved.params?.size
  const steps = resolved.params?.steps
  if (protocol === 'stability-sd-webui') {
    return {
      prompt: resolved.prompt,
      ...(resolved.params?.width === undefined ? {} : { width: resolved.params.width }),
      ...(resolved.params?.height === undefined ? {} : { height: resolved.params.height }),
      ...(steps === undefined ? {} : { steps }),
      ...(count > 1 ? { batch_size: count } : {}),
    }
  }
  // openai-images and openai-images-edits share a body shape; the edits variant
  // adds its source image as multipart instead, which this stage does not send.
  return {
    // The provider matches its own model identifier, never our display name.
    model: resolved.modelIdentifier,
    prompt: resolved.prompt,
    ...(size === undefined ? {} : { size }),
    ...(count > 1 ? { n: count } : {}),
  }
}

/** Build the request URL for one protocol. */
export function buildUrl(protocol, baseUrl) {
  const base = trimBase(baseUrl)
  if (protocol === 'stability-sd-webui') return `${base}/sdapi/v1/txt2img`
  if (protocol === 'openai-images-edits') {
    // The documented edits route is `/images/edits` beside `/images/generations`.
    return /\/images$/i.test(base) ? `${base}/edits` : `${base}/images/edits`
  }
  return /\/images$/i.test(base) ? `${base}/generations` : `${base}/images/generations`
}

/** Headers for one request: the model's own rows, then the key, then defaults. */
export function buildHeaders(model, apiKey) {
  const headers = { 'content-type': 'application/json' }
  for (const row of Array.isArray(model.headers) ? model.headers : []) {
    const name = String(row?.name ?? '').trim()
    if (name.length === 0) continue
    headers[name.toLowerCase()] = String(row?.value ?? '')
  }
  if (typeof apiKey === 'string' && apiKey.length > 0 && headers.authorization === undefined) {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * Turn a provider's error body into one readable line.
 *
 * Providers answer with `{error:{code,message}}`, a bare string, or HTML from a
 * proxy. The provider's message matters more than the JSON around it: a rate limit
 * or an invalid key has to be legible in the conversation rather than buried in
 * escaped JSON.
 *
 * @param text - the raw response body.
 */
export function describeFailureBody(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw)
    const error = parsed !== null && typeof parsed === 'object' ? (parsed.error ?? parsed) : undefined
    if (typeof error === 'string') return error
    if (error !== null && typeof error === 'object') {
      const code = error.code === undefined ? undefined : String(error.code)
      const message = error.message === undefined ? undefined : String(error.message)
      if (message !== undefined && message.length > 0) return code === undefined ? message : `${code}: ${message}`
    }
    if (typeof parsed?.message === 'string' && parsed.message.length > 0) return parsed.message
  } catch (_failure) {
    // Not JSON: fall through to the trimmed text.
  }
  return raw
}

/**
 * Run one image generation.
 *
 * @param options - `{ model, resolved, count, apiKey, fetchImpl, signal }`.
 * @returns `{ ok: true, images }` or `{ ok: false, reason, message, status }`.
 */
export async function generate(options) {
  const { model, resolved, count = 1, apiKey, signal } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'no-fetch', message: 'this runtime has no fetch implementation' }
  }
  const protocol = model.protocol
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    return {
      ok: false,
      reason: 'unsupported-protocol',
      message: `protocol "${protocol}" has no adapter; it is a stored configuration for a future stage`,
    }
  }
  const baseUrl = String(model.baseUrl ?? '').trim()
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, reason: 'bad-endpoint', message: `endpoint "${baseUrl}" is not an HTTP or HTTPS URL` }
  }

  const url = buildUrl(protocol, baseUrl)
  const timeoutMs = resolved.params?.timeoutMs ?? 120000
  const controller = new AbortController()
  // The two aborts are different outcomes and must not be conflated: the caller's
  // signal means the user cancelled, while this controller firing means the
  // deadline passed — and a deadline is the common case for an image model that
  // takes a minute or more per image.
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) return { ok: false, reason: 'aborted', message: 'the request was cancelled before it started' }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('image generation timed out'))
  }, timeoutMs)

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: buildHeaders(model, apiKey),
      body: JSON.stringify(buildBody(protocol, resolved, count)),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      const detail = describeFailureBody(text)
      return {
        ok: false,
        reason: 'http-error',
        status: response.status,
        message: detail.length > 0
          ? `HTTP ${String(response.status)} ${response.statusText}: ${detail.slice(0, 400)}`
          : `HTTP ${String(response.status)} ${response.statusText}`,
      }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (_failure) {
      return { ok: false, reason: 'bad-json', message: `the endpoint did not answer with JSON: ${text.slice(0, 200)}` }
    }
    const { images } = readerFor(protocol)(body)
    const usable = []
    for (const image of images) {
      if (image.data !== undefined) {
        usable.push({ data: image.data, mediaType: image.mediaType ?? sniffMediaType(image.data) })
        continue
      }
      if (image.url !== undefined) {
        const fetched = await fetchImpl(image.url, { signal: controller.signal })
        if (!fetched.ok) continue
        const bytes = new Uint8Array(await fetched.arrayBuffer())
        usable.push({ data: bytes, mediaType: sniffMediaType(bytes) })
      }
    }
    const complete = usable.filter((image) => image.mediaType !== undefined && MEDIA_TYPES.includes(image.mediaType))
    if (complete.length === 0) {
      return { ok: false, reason: 'no-image', message: 'the endpoint answered without a usable image' }
    }
    return { ok: true, images: complete.slice(0, Math.max(1, count)) }
  } catch (error) {
    // A deadline and a cancellation are different faults with different fixes.
    if (timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        message: `the endpoint did not answer within ${String(Math.round(timeoutMs / 1000))}s; raise the model's timeout in the settings page if this provider is slower`,
      }
    }
    if (controller.signal.aborted) {
      return {
        ok: false,
        reason: 'aborted',
        message: error instanceof Error ? error.message : 'the request was cancelled',
      }
    }
    return {
      ok: false,
      reason: 'transport',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
