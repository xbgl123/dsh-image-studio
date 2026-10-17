/**
 * Prompt smart translation: the compatibility layer between the prompt a caller
 * wrote and the prompt the target image model actually accepts.
 *
 * The governing rule is **pass through first, change as little as possible, match
 * the format only when you must**. Concretely:
 *
 * - The body of a compatible prompt is copied byte for byte. No rewriting, no
 *   padding, no splitting.
 * - Parameters (size, count, steps, timeout) are always mapped, because those are
 *   API fields rather than prose, and a field the caller did not ask for is left
 *   for the model's own template.
 * - A full conversion runs only when the two formats genuinely disagree, and the
 *   result is reported as `translated: true` with the reason.
 *
 * Nothing here performs I/O: it is a pure function of (request, model profile),
 * which is what makes the pass-through promise testable.
 */

/** Prompt formats a caller can present. */
export const PROMPT_FORMATS = ['natural', 'sd-tags', 'custom']

/** Pass-through policy values, mirroring the per-model setting. */
export const PASS_THROUGH_MODES = ['auto', 'always', 'never']

/**
 * Whether a prompt is already optimized, so the plugin's own defaults stay off.
 *
 * Defined here rather than imported from `intent.mjs` to keep this module a leaf:
 * the translation rules are pure and must not depend on detection.
 *
 * @param source - provenance of the prompt.
 * @param flagged - explicit caller override.
 */
function isOptimizedPrompt(source, flagged) {
  if (flagged === true) return true
  if (flagged === false) return false
  return source === 'skill'
}

/** The `(token:1.2)` form. */
const SD_RATIO = /\(\s*[^()[\]]{1,80}\s*:\s*\d+(?:\.\d+)?\s*\)/
/** The `<lora:name:0.8>` / `<lyco:name>` form. */
const SD_TAG = /<\s*(?:lora|lyco|hypernet|embedding)\s*:[^>]{1,120}>/i

/**
 * Detect the format of a prompt from its own text.
 *
 * Weight syntax is the only signal used, because it is the only one that does not
 * occur in ordinary prose. A bare comma list is deliberately **not** read as tags:
 * "a cat, a window, a sunset" is a natural-language prompt that happens to contain
 * commas, and misreading it would rewrite a prompt that should have passed through
 * untouched. The cost is the opposite error — a weight-free tag list reads as
 * natural language — and that one is cheaper, because a weight-free tag list is
 * also valid prose and a per-model "force pass-through" switch covers the rest.
 *
 * @param text - the prompt body.
 * @returns the detected format.
 */
export function detectPromptFormat(text) {
  const value = String(text ?? '')
  if (SD_RATIO.test(value) || SD_TAG.test(value)) return 'sd-tags'
  return 'natural'
}

/**
 * The prompt format a protocol accepts natively.
 * @param protocol - the model profile's protocol.
 */
export function nativeFormatOf(protocol) {
  if (protocol === 'stability-sd-webui') return 'sd-tags'
  if (protocol === 'custom') return 'custom'
  return 'natural'
}

/**
 * Convert a natural-language prompt into the tag form a Stable Diffusion model
 * expects: split on sentence and clause boundaries, strip trailing punctuation,
 * keep the author's words and their order, and never invent a token.
 *
 * @param text - the natural-language prompt.
 */
export function naturalToTags(text) {
  return String(text ?? '')
    .split(/[。；;.!?！？\n]+/)
    .flatMap((sentence) => sentence.split(/[，,、]+/))
    .map((tag) => tag.trim().replace(/^[-–—\s]+|[-–—\s]+$/g, ''))
    .filter((tag) => tag.length > 0)
    .join(', ')
}

/**
 * Convert a tag-style prompt into the sentence form an OpenAI-compatible model
 * expects: join the tags, drop weight syntax rather than carrying it into prose
 * that has no meaning for it, and state the weights as words.
 *
 * @param text - the tag-style prompt.
 */
export function tagsToNatural(text) {
  const withoutTags = String(text ?? '').replace(new RegExp(SD_TAG.source, 'gi'), '')
  const words = withoutTags
    .replace(/\(\s*([^()[\]]{1,80}?)\s*:\s*(\d+(?:\.\d+)?)\s*\)/g, (_whole, token, weight) => {
      const trimmed = String(token).trim()
      const numeric = Number(weight)
      if (!Number.isFinite(numeric) || Math.abs(numeric - 1) < 0.05) return trimmed
      return numeric > 1 ? `${trimmed} (emphasis)` : `${trimmed} (subtle)`
    })
    .replace(/[[\]{}]/g, '')
    .split(/[,\n]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .join(', ')
  return words.length > 0 ? `${words}.` : ''
}

/** Apply a caller template. Unknown placeholders are left untouched. */
function applyTemplate(template, values) {
  return String(template).replace(/\{(prompt|prefix|negative)\}/g, (whole, key) => {
    const value = values[key]
    return typeof value === 'string' ? value : whole
  })
}

/** `1024x1024` from a numeric pair, or `undefined` when either side is unusable. */
function sizeOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return `${String(Math.trunc(width))}x${String(Math.trunc(height))}`
}

/**
 * Map the model profile's parameter template onto the model's request fields.
 *
 * Only fields the profile actually sets are emitted: an unset size or step count
 * stays unset so the endpoint's own default applies, rather than this layer
 * inventing a value the user never chose.
 *
 * @param model - the stored image-model record.
 * @returns the request fields for this protocol.
 */
export function mapParams(model) {
  const params = model.params ?? {}
  const width = Number.isFinite(params.width) ? params.width : 0
  const height = Number.isFinite(params.height) ? params.height : 0
  const size = sizeOf(width, height)
  const steps = Number.isFinite(params.steps) && params.steps > 0 ? Math.trunc(params.steps) : undefined
  // Image models routinely take a minute or more per image, so the fallback is
  // generous: an unnecessary wait costs patience, a premature deadline throws away
  // a generation the user already paid for.
  const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.trunc(params.timeoutMs) : 300000
  const protocol = model.protocol

  if (protocol === 'stability-sd-webui') {
    return {
      width: width > 0 ? Math.trunc(width) : undefined,
      height: height > 0 ? Math.trunc(height) : undefined,
      steps,
      timeoutMs,
    }
  }
  // `custom` gets no parameter mapping at all: its protocol is the caller's.
  if (protocol === 'custom') return { timeoutMs }
  return { size, steps, timeoutMs }
}

/**
 * Assemble the prompt text one model receives.
 *
 * Enhancement (the model's prefix and negative defaults) is applied only when the
 * caller is not an already-optimized source and the effective format still wants
 * it — a pass-through request keeps its body exactly, and a converted request
 * gets the author's defaults in the target's idiom.
 *
 * The caller supplies the already-decided `prefix` and `negative` as `options`;
 * this function never reaches back into the model for them, so the decision has
 * exactly one owner and the body cannot be padded behind the caller's back.
 *
 * @param request - `{ prompt }`.
 * @param model - the stored image-model record.
 * @param format - the effective prompt format.
 * @param options - `{ prefix, negative }`, both already resolved.
 */
export function assemblePrompt(request, model, format, options = {}) {
  const body = String(request.prompt ?? '')
  const prefix = String(options.prefix ?? '')
  const negative = String(options.negative ?? '')
  const head = prefix.length > 0 ? `${prefix}${prefix.endsWith(' ') ? '' : ' '}${body}` : body

  if (format === 'custom' && String(model.promptTemplate ?? '').length > 0) {
    return applyTemplate(model.promptTemplate, { prompt: body, prefix, negative })
  }
  if (format === 'sd-tags' && negative.length > 0) {
    // Stable Diffusion's endpoints carry the negative prompt inside the prompt
    // text; the request body has no field for it.
    return `${head}\nNegative prompt: ${negative}`
  }
  return head
}

/**
 * Resolve one image request against one model profile.
 *
 * @param request - `{ prompt, negative?, width?, height?, count?, source?, optimized?, modelId? }`.
 * @param model - the stored image-model record, or undefined when none is configured.
 * @param now - injectable clock for the decision record.
 * @returns the resolved request the adapter consumes, plus the decision trail.
 */
export function translateRequest(request, model, now = new Date()) {
  const body = String(request.prompt ?? '').trim()
  if (body.length === 0) {
    return { ok: false, reason: 'empty-prompt' }
  }
  if (model === undefined || model === null) {
    return { ok: false, reason: 'no-model' }
  }

  const sourceFormat = PROMPT_FORMATS.includes(request.format) ? request.format : detectPromptFormat(body)
  const targetFormat = nativeFormatOf(model.protocol)
  const mode = PASS_THROUGH_MODES.includes(model.promptPassThrough) ? model.promptPassThrough : 'auto'
  // Skill provenance is what marks a prompt already optimized; an explicit flag
  // overrides it in either direction.
  const optimized = isOptimizedPrompt(request.source, request.optimized)
  const sameFormat = sourceFormat === targetFormat

  // Pass-through decides first; policy can only override, never rewrite.
  let passThrough
  let reason
  if (mode === 'always') {
    passThrough = true
    reason = sameFormat ? 'policy-always-format-match' : 'policy-always'
  } else if (mode === 'never') {
    passThrough = false
    reason = sameFormat ? 'policy-never-format-match' : 'policy-never'
  } else if (sameFormat) {
    passThrough = true
    reason = 'auto-format-match'
  } else if (optimized) {
    // An already-optimized prompt is never rewritten: the author's text is the
    // authority, so a mismatch passes through instead of converting.
    passThrough = true
    reason = 'auto-optimized-hold'
  } else {
    passThrough = false
    reason = 'auto-format-mismatch'
  }

  let effectiveFormat = sourceFormat
  let prompt = body
  if (!passThrough) {
    const converted = targetFormat === 'sd-tags' ? naturalToTags(body) : targetFormat === 'natural' ? tagsToNatural(body) : body
    if (converted.trim().length > 0) prompt = converted
    effectiveFormat = targetFormat
  }

  // Enhancement is suppressed for optimized prompts, and for a pass-through whose
  // body must stay untouched unless the model actually declares defaults.
  const declaresDefaults = String(model.promptPrefix ?? '').length > 0 || String(model.promptNegative ?? '').length > 0
  const enhance = !optimized && declaresDefaults && (!passThrough || targetFormat === 'sd-tags')
  const prefix = enhance ? String(model.promptPrefix ?? '') : ''
  const negative = request.negative ?? (enhance ? String(model.promptNegative ?? '') : '')

  const finalText = assemblePrompt({ prompt }, model, effectiveFormat, { prefix, negative })

  return {
    ok: true,
    translated: !passThrough,
    passThrough,
    reason,
    mode,
    sourceFormat,
    targetFormat,
    prompt: finalText,
    negative,
    params: mapParams(model),
    modelId: model.id,
    // The display name is for people; the identifier is what the provider expects in
    // its `model` field. They are different fields in the settings record and must
    // not be conflated.
    modelName: model.name,
    modelIdentifier: model.model,
    protocol: model.protocol,
    decidedAt: now.toISOString(),
  }
}
