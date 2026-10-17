/**
 * The scheduler's resilience layer: parameter resolution, translation with a
 * pass-through fallback, the skill priority rules, and error classification.
 *
 * These are the behaviors that decide whether a failure *interrupts* a
 * conversation or merely reports itself, so they are pure functions with the
 * failure paths written out rather than delegated.
 */

/** How many images one request may ever produce, regardless of what was asked. */
export const MAX_IMAGES = 4

/**
 * The error kinds the caller may need to distinguish, with a stable label each.
 * `guide` marks the kinds a user must act on, which are worth a visible message;
 * the rest are worth a log line and nothing more.
 */
export const FAILURE_KINDS = [
  'auth',
  'timeout',
  'network',
  'rate-limit',
  'bad-request',
  'server',
  'bad-response',
  'no-image',
  'config',
  'empty',
  'cancelled',
  'internal',
]

/**
 * Classify one generation failure into an actionable kind and a readable message.
 *
 * The provider's own text is preserved: it names the real cause (a quota, a bad
 * key, a rejected parameter) far more precisely than a generic sentence could, and
 * a user cannot fix what they cannot read.
 *
 * @param outcome - a `runImageRequest` failure.
 * @returns `{ kind, guide, message }`.
 */
export function classifyFailure(outcome) {
  const status = Number.isFinite(outcome?.status) ? outcome.status : undefined
  const detail = typeof outcome?.message === 'string' ? outcome.message : ''
  const reason = String(outcome?.kind ?? outcome?.reason ?? 'internal')

  if (reason === 'unconfigured' || reason === 'unusable' || reason === 'config') {
    return { kind: 'config', guide: true, message: detail }
  }
  if (reason === 'empty') return { kind: 'empty', guide: false, message: detail }
  if (reason === 'aborted') return { kind: 'cancelled', guide: false, message: detail || 'the image request was cancelled' }
  if (reason === 'timeout') return { kind: 'timeout', guide: true, message: detail }
  if (reason === 'transport') {
    return {
      kind: 'network',
      guide: true,
      message: `the image provider could not be reached: ${detail}`,
    }
  }
  if (reason === 'unsupported-protocol' || reason === 'bad-endpoint' || reason === 'no-fetch') {
    return { kind: 'config', guide: true, message: detail }
  }
  if (reason === 'http-error') {
    if (status === 401 || status === 403) {
      return { kind: 'auth', guide: true, message: `the provider rejected the API key (HTTP ${String(status)}): ${detail}` }
    }
    if (status === 429) {
      return { kind: 'rate-limit', guide: true, message: `the provider is rate limiting this account (HTTP 429): ${detail}` }
    }
    if (status === 400 || status === 404 || status === 422) {
      return { kind: 'bad-request', guide: true, message: `the provider rejected the request (HTTP ${String(status)}): ${detail}` }
    }
    if (status !== undefined && status >= 500) {
      return { kind: 'server', guide: true, message: `the provider reported a server error (HTTP ${String(status)}): ${detail}` }
    }
    return { kind: 'bad-request', guide: true, message: detail }
  }
  if (reason === 'no-image' || reason === 'bad-json') {
    return { kind: 'bad-response', guide: true, message: detail }
  }
  if (reason === 'store-failed' || reason === 'no-attachments') {
    return { kind: 'internal', guide: true, message: detail }
  }
  return { kind: 'internal', guide: false, message: detail }
}

/**
 * Run the translator, degrading to a verbatim pass-through if it faults.
 *
 * This is the promise that a broken translation layer cannot stop an image: the
 * translator is pure, but it reads a stored model record, and a record is user
 * data. An unexpected throw therefore falls back to sending the author's prompt
 * exactly as written — which is always a valid request — and says so in the trail.
 *
 * @param translate - the translator, `(model) => resolved`.
 * @param model - the model record to translate against.
 * @param request - `{ prompt, negative? }`, the original request.
 * @returns `{ resolved, degraded, note? }`; `resolved` is never undefined.
 */export function translateWithFallback(translate, model, request) {
  try {
    const resolved = translate(model)
    if (resolved !== undefined && resolved !== null && resolved.ok !== false) {
      return { resolved, degraded: false }
    }
    if (resolved !== undefined && resolved !== null && resolved.ok === false && resolved.reason === 'empty-prompt') {
      // Not a translator fault: the caller sent nothing to translate.
      return { resolved, degraded: false }
    }
    return { resolved: passthrough(model, request), degraded: true, note: `translation refused: ${String(resolved?.reason ?? 'unknown')}` }
  } catch (error) {
    return {
      resolved: passthrough(model, request),
      degraded: true,
      note: `translation faulted, so the prompt was sent verbatim: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * The degradation target: the author's prompt, unmapped parameters, no rewriting.
 *
 * @param model - the model record.
 * @param request - `{ prompt, negative? }`.
 */
export function passthrough(model, request) {
  const negative = typeof request?.negative === 'string' ? request.negative : ''
  return {
    ok: true,
    passThrough: true,
    translated: false,
    degraded: true,
    reason: 'translation-fallback-passthrough',
    sourceFormat: 'unknown',
    targetFormat: 'unknown',
    prompt: String(request?.prompt ?? ''),
    negative,
    params: {},
    modelId: model?.id,
    modelName: model?.name,
    modelIdentifier: model?.model,
    protocol: model?.protocol,
  }
}

/** Names that mark an *image* generation tool in another plugin's registration. */
const IMAGE_TOOL = /(image|picture|draw|render|diffusion|stable|sd_|comfy|flux|midjourney|seedream|dall)/i

/**
 * Whether a skill (or another plugin) owns image generation for this turn.
 *
 * A tool call in the claimed messages whose name looks like image generation means
 * the author already chose how to draw: the plugin must stand aside entirely rather
 * than add a second generation. The check is deliberately name-based and
 * conservative — a false positive costs one skipped automatic image, while a false
 * negative costs a duplicate that the user pays for.
 *
 * @param messages - the claimed `UserMessage[]` of the step.
 * @param ownToolNames - this plugin's own tools, which never count as a conflict.
 * @returns `{ owned, toolName? }`.
 */
export function skillOwnsImageGeneration(messages, ownToolNames = ['generate_image', 'image_studio_status']) {
  if (!Array.isArray(messages)) return { owned: false }
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.type !== 'tool-call' && block.type !== 'tool_call') continue
      const name = typeof block.name === 'string' ? block.name : typeof block.toolName === 'string' ? block.toolName : ''
      if (name.length === 0 || ownToolNames.includes(name)) continue
      if (IMAGE_TOOL.test(name) && /(generat|draw|create|render|image|picture)/i.test(name)) {
        return { owned: true, toolName: name }
      }
    }
  }
  return { owned: false }
}

/**
 * Clamp every request field into what the protocols accept, so a wild value in a
 * user instruction or a skill's output cannot become an invalid API call.
 *
 * @param request - `{ width, height, count }`.
 * @param limits - `{ maxDimension }`, from the attachment policy's neighbourhood.
 */
export function clampRequest(request, limits = {}) {
  const maxDimension = Number.isFinite(limits.maxDimension) ? limits.maxDimension : 4096
  const clamp = (value) => {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.min(Math.trunc(value), maxDimension)
  }
  const count = Number.isFinite(request?.count) && request.count > 0 ? Math.min(MAX_IMAGES, Math.trunc(request.count)) : 1
  return { width: clamp(request?.width), height: clamp(request?.height), count }
}
