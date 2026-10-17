/**
 * The one image-generation operation, shared by both entry points.
 *
 * Everything the plugin can do to an image lives in `runImageRequest`: routing,
 * translation, capability re-check, the HTTP call, and persistence. The
 * `generate_image` tool and the automatic `agent/pre-step` path both call it, so
 * the two can never disagree about which model ran or what prompt it received —
 * the same rule `references/user-actions.md` states for UI actions and tools.
 */

import { generate } from './adapters.mjs'
import { extractParameters, resolveParameters } from './params.mjs'
import { translateRequest } from './prompt.mjs'
import { classifyFailure, clampRequest, translateWithFallback } from './resilience.mjs'
import { conversationModelGeneratesImages, isServable, readModels, routeRequest } from './router.mjs'
import { detectImageIntent } from './intent.mjs'

/**
 * Resolve the model that will serve one request, re-checking servability.
 * @param state - the live plugin state.
 * @param requestedModelId - an explicit model id from the caller, if any.
 */
function pickModel(state, requestedModelId) {
  const route = routeRequest({
    models: state.models,
    nativeRoutes: state.nativeRoutes,
    provider: state.provider,
    model: state.model,
    requestedModelId,
  })
  return route
}

/**
 * Generate one image and persist it.
 *
 * @param state - `{ models, nativeRoutes, provider, model, fetchImpl }`, read fresh per call.
 * @param request - `{ prompt, negative?, width?, height?, count?, source?, optimized?, modelId?, signal? }`.
 * @returns a discriminated outcome: `{ ok: true, ref, name, decision }`,
 *   `{ ok: false, kind, message, decision? }`, or `{ ok: true, handledByModel: true }`
 *   for the native case, which the caller must leave to the conversation model.
 */
export async function runImageRequest(state, request) {
  const prompt = String(request.prompt ?? '').trim()
  if (prompt.length === 0) {
    return { ok: false, kind: 'empty', message: 'the image request carried no prompt text' }
  }

  const route = pickModel(state, request.modelId)

  // Rule 4a: the conversation model owns the capability. Report that fact; the
  // caller must not generate anything, and nothing is switched.
  if (route.kind === 'native') {
    return {
      ok: true,
      handledByModel: true,
      decision: { kind: 'native', model: route.model, reason: route.reason },
    }
  }

  // Rule 4c: nothing can serve it — hand back the exact guidance the user needs.
  if (route.kind === 'unconfigured') {
    return { ok: false, kind: 'unconfigured', message: route.guide, decision: { kind: 'unconfigured', reason: route.reason } }
  }
  if (route.kind === 'unusable') {
    return {
      ok: false,
      kind: 'unusable',
      message: `the configured image model "${route.model.name ?? route.model.id}" cannot be called: it has no adapter for protocol "${route.model.protocol}" or its endpoint is not an HTTP URL`,
      decision: { kind: 'unusable', model: route.model, reason: route.reason },
    }
  }

  const model = { ...route.model }

  // Parameters come from four places, in this order of authority:
  //   1. what the caller passed explicitly — a tool argument, or a skill's own field;
  //   2. what the instruction text says;
  //   3. the plugin-level defaults the user set in the settings page;
  //   4. the model's stored template.
  // The caller's *defaults* are deliberately not in slot 1: a default filled in by
  // this code must never override what the user actually wrote in the sentence.
  const parsed = extractParameters(prompt, { width: model.params?.width, height: model.params?.height })
  const explicit = {
    width: Number.isFinite(request.width) ? request.width : undefined,
    height: Number.isFinite(request.height) ? request.height : undefined,
    ratio: typeof request.ratio === 'string' && request.ratio.length > 0 ? request.ratio : undefined,
    count: Number.isFinite(request.count) ? request.count : undefined,
    negative: typeof request.negative === 'string' && request.negative.length > 0 ? request.negative : undefined,
    style: typeof request.style === 'string' && request.style.length > 0 ? request.style : undefined,
  }
  const defaults = {
    width: model.params?.width,
    height: model.params?.height,
    count: request.defaultCount,
    negative: model.promptNegative,
  }
  const resolvedParams = resolveParameters(explicit, parsed, defaults)
  const clamped = clampRequest(resolvedParams, { maxDimension: 4096 })
  const effectivePrompt = parsed.prompt.length > 0 ? parsed.prompt : prompt
  // A resolved size replaces the stored template, and only when both sides are
  // known: a lone width would otherwise pair with a stale height.
  model.params =
    clamped.width === undefined || clamped.height === undefined
      ? { ...model.params }
      : { ...model.params, width: clamped.width, height: clamped.height }

  // Re-check capability at execution time: the route may have changed since the
  // decision was made, and a stale decision must not silently redirect a call.
  const stillNative = conversationModelGeneratesImages({
    nativeRoutes: state.nativeRoutes,
    provider: state.provider,
    model: state.model,
  })
  if (stillNative) {
    return { ok: true, handledByModel: true, decision: { kind: 'native', reason: 'native-route-recheck' } }
  }
  if (!isServable(model)) {
    return { ok: false, kind: 'unusable', message: `the image model "${model.name ?? model.id}" is not callable`, decision: { kind: 'unusable' } }
  }

  // Translation runs behind a fallback: a fault in this layer degrades to a
  // verbatim pass-through instead of failing the request.
  const translated = translateWithFallback(
    (against) =>
      translateRequest(
        {
          prompt: effectivePrompt,
          negative: resolvedParams.negative,
          source: request.source,
          optimized: request.optimized,
        },
        against,
      ),
    model,
    { prompt: effectivePrompt, negative: resolvedParams.negative },
  )
  const resolved = translated.resolved
  if (resolved.ok !== true) {
    return {
      ok: false,
      kind: resolved.reason,
      message: resolved.reason === 'empty-prompt' ? 'the image request carried no prompt text' : 'no image model is configured',
    }
  }

  // What was asked for, recorded now; whether the provider delivered it is added
  // below, once the answer is known.
  const parameters = {
    width: clamped.width,
    height: clamped.height,
    ratio: resolvedParams.ratio,
    count: clamped.count,
    style: resolvedParams.style,
    negative: resolvedParams.negative,
    matched: parsed.matched,
    notes: [...(parsed.notes ?? []), ...(resolvedParams.notes ?? [])],
  }

  const generated = await generate({
    model,
    resolved,
    count: clamped.count,
    apiKey: model.apiKey,
    fetchImpl: state.fetchImpl,
    signal: request.signal,
  })
  if (generated.ok !== true) {
    const failure = classifyFailure({ kind: generated.reason, message: generated.message, status: generated.status })
    return {
      ok: false,
      kind: generated.reason,
      status: generated.status,
      failure,
      message: failure.message,
      decision: { kind: 'call-failed', reason: generated.reason, status: generated.status, modelId: model.id, prompt: resolved.prompt },
    }
  }

  // A provider may answer with fewer images than were requested. That is a paid-op
  // discrepancy, not a silence to keep, so it is recorded with the other notes.
  if (generated.images.length < clamped.count) {
    parameters.notes.push(
      `the provider returned ${String(generated.images.length)} of the ${String(clamped.count)} requested image(s)`,
    )
  }

  const attachments = state.attachments
  if (attachments === undefined || attachments === null) {
    return {
      ok: false,
      kind: 'no-attachments',
      message: 'generated an image but no attachment service is mounted, so it cannot be shown in the conversation',
      decision: { kind: 'call-succeeded-unstored' },
    }
  }

  const refs = []
  for (const [index, image] of generated.images.entries()) {
    // Name the file after the format actually received, not an assumed one.
    const extension = image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType === 'image/webp' ? 'webp' : image.mediaType === 'image/gif' ? 'gif' : 'png'
    const base = model.name ?? model.id
    const name = generated.images.length > 1 ? `${base}-${String(index + 1)}.${extension}` : `${base}.${extension}`
    try {
      refs.push(await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name }))
    } catch (error) {
      const failure = classifyFailure({
        kind: 'store-failed',
        message: `the generated image could not be stored: ${error instanceof Error ? error.message : String(error)}`,
      })
      return {
        ok: false,
        kind: 'store-failed',
        failure,
        message: failure.message,
        decision: { kind: 'call-succeeded-unstored', modelId: model.id },
      }
    }
  }

  // The trace keeps every decision the user may want to inspect: which model ran,
  // the exact text that was sent, and how it was derived.
  const trace = {
    modelId: model.id,
    modelName: model.name,
    protocol: model.protocol,
    endpoint: model.baseUrl,
    promptSent: resolved.prompt,
    negativeSent: resolved.negative ?? '',
    promptAuthor: effectivePrompt,
    translation: {
      passThrough: resolved.passThrough === true,
      translated: resolved.translated === true,
      degraded: translated.degraded === true,
      reason: resolved.reason,
      sourceFormat: resolved.sourceFormat,
      targetFormat: resolved.targetFormat,
      mode: resolved.mode,
    },
    parameters,
    source: request.source ?? 'user',
    ...(translated.note === undefined ? {} : { degradationNote: translated.note }),
  }

  return {
    ok: true,
    refs,
    model: { id: model.id, name: model.name, protocol: model.protocol },
    trace,
    decision: {
      kind: 'generated',
      modelId: model.id,
      modelName: model.name,
      protocol: model.protocol,
      passThrough: resolved.passThrough,
      translated: resolved.translated,
      degraded: translated.degraded === true,
      reason: resolved.reason,
      sourceFormat: resolved.sourceFormat,
      targetFormat: resolved.targetFormat,
      mode: resolved.mode,
      prompt: resolved.prompt,
      parameters,
    },
  }
}

/**
 * Build the model-facing description of a generation outcome.
 * @param result - a `runImageRequest` outcome.
 * @param request - the originating request, for provenance in the text.
 */
export function describeOutcome(result, request) {
  if (result.ok === true && result.handledByModel === true) {
    return `The current conversation model is declared as image-capable, so this request was left to it. Nothing was generated by the plugin.`
  }
  if (result.ok !== true) {
    if (result.kind === 'unconfigured') return result.message
    if (result.kind === 'unusable') return result.message
    if (result.kind === 'no-attachments') return result.message
    if (result.kind === 'store-failed') return result.message
    if (result.kind === 'aborted') return 'The image request was cancelled.'
    if (result.kind === 'timeout') return result.message
    return `Image generation failed: ${result.message}`
  }
  const decision = result.decision ?? {}
  const trace = result.trace ?? {}
  const how = decision.translated === true ? 'converted for the target model' : 'passed through unchanged'
  const source = request?.source === 'skill' ? ' (from a skill; the prompt was kept verbatim)' : ''
  const degraded = decision.degraded === true ? ' The prompt translator was unavailable, so the prompt was sent verbatim.' : ''
  const parameters = trace.parameters ?? {}
  const dimensions = parameters.width !== undefined && parameters.height !== undefined ? ` at ${String(parameters.width)}x${String(parameters.height)}px` : ''
  const shortfall = (parameters.notes ?? []).find((note) => typeof note === 'string' && note.includes('returned'))
  return [
    `Generated ${String(result.refs.length)} image${result.refs.length === 1 ? '' : 's'}${dimensions} with the model "${decision.modelName ?? result.model.name}" (${decision.protocol ?? result.model.protocol}).`,
    `Prompt ${how}: ${decision.reason ?? 'unknown'}, ${String(decision.sourceFormat ?? '?')} → ${String(decision.targetFormat ?? '?')}${source}.${degraded}`,
    shortfall === undefined ? '' : `Note: ${shortfall}.`,
    `The image${result.refs.length === 1 ? ' is' : 's are'} attached to this result and shown in the conversation.`,
    `Trace: model=${String(trace.modelName ?? '?')} id=${String(trace.modelId ?? '?')} endpoint=${String(trace.endpoint ?? '?')}; prompt sent = ${JSON.stringify(String(trace.promptSent ?? decision.prompt ?? '').slice(0, 500))}.`,
  ].filter((part) => part.length > 0).join(' ')
}

/**
 * Detect an image request in a batch of claimed user messages.
 *
 * Plugin-generated messages are skipped: their source kind marks them as our own
 * output, so a generated image can never trigger another generation.
 *
 * @param messages - the claimed `UserMessage[]` of the step, or `{content}`-shaped objects.
 * @param ownSourceKind - this plugin's message source kind.
 * @returns `{ wanted, prompt, source, messageId }` or `{ wanted: false }`.
 */
export function detectRequestInMessages(messages, ownSourceKind) {
  if (!Array.isArray(messages)) return { wanted: false }
  let prompt = ''
  let source = 'user'
  let messageId
  let wanted = false

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const kind = message.source !== null && typeof message.source === 'object' ? message.source.kind : undefined
    if (kind === ownSourceKind) continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.trim().length === 0) continue
    const intent = detectImageIntent(text, { source })
    if (intent.wanted) {
      wanted = true
      prompt = prompt.length === 0 ? text.trim() : `${prompt}\n${text.trim()}`
      source = kind === 'skill-invocation' || kind === 'skill' ? 'skill' : source
      messageId = message.id
    }
  }
  return wanted ? { wanted: true, prompt, source, messageId } : { wanted: false }
}

export { readModels }
