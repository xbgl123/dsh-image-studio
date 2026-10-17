/**
 * Model selection and capability routing.
 *
 * Three questions live here, and they are the ones rule 2 and rule 4 of the
 * specification ask:
 *
 * 1. Is the conversation model itself able to produce an image?
 * 2. Which configured image model serves a request that the conversation model
 *    cannot serve?
 * 3. What must the user be told when nothing can serve it?
 *
 * Question 1 deserves an explicit note. The Harness LLM layer declares **input**
 * modalities only (`LlmModelInfo.inputModalities`, whose value type is
 * `'text' | 'image'`); there is no output-modality, no "can generate images", and
 * no image-generation call anywhere in `@deepseek-ai/dsh-llm`. Capability
 * therefore cannot be read from the catalog, and inventing a guess would either
 * silently skip a needed generation or silently spend the user's money. So it is
 * an explicit, user-owned declaration in the plugin configuration — the same
 * posture the Harness takes for every other provider fact it cannot observe.
 */

/** Protocols the adapters can actually call today. */
const SERVABLE_PROTOCOLS = ['openai-images', 'openai-images-edits', 'stability-sd-webui']

/**
 * Normalize the stored image-model list.
 * @param value - the namespace section's `imageModels`, of unknown shape.
 */
export function readModels(value) {
  const list = value !== null && typeof value === 'object' ? value.imageModels : undefined
  if (!Array.isArray(list)) return []
  return list.map((entry, index) => {
    const source = entry !== null && typeof entry === 'object' ? entry : {}
    return {
      id: typeof source.id === 'string' && source.id.length > 0 ? source.id : `image-${String(index + 1)}`,
      name: typeof source.name === 'string' ? source.name : '',
      protocol: typeof source.protocol === 'string' ? source.protocol : 'openai-images',
      baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
      apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
      model: typeof source.model === 'string' ? source.model : '',
      headers: Array.isArray(source.headers) ? source.headers : [],
      promptFormat: typeof source.promptFormat === 'string' ? source.promptFormat : 'natural',
      promptPassThrough: typeof source.promptPassThrough === 'string' ? source.promptPassThrough : 'auto',
      promptPrefix: typeof source.promptPrefix === 'string' ? source.promptPrefix : '',
      promptNegative: typeof source.promptNegative === 'string' ? source.promptNegative : '',
      promptTemplate: typeof source.promptTemplate === 'string' ? source.promptTemplate : '',
      params: source.params !== null && typeof source.params === 'object' ? source.params : {},
      isDefault: source.isDefault === true,
    }
  })
}

/** The one configured default, if any. */
export function defaultModel(models) {
  return models.find((model) => model.isDefault === true)
}

/** Whether an adapter exists for this record, i.e. whether it can be called now. */
export function isServable(model) {
  return SERVABLE_PROTOCOLS.includes(model.protocol) && /^https?:\/\//i.test(String(model.baseUrl ?? '').trim())
}

/**
 * Route one image request.
 *
 * `native` reports that the conversation model owns this capability and the
 * plugin must not touch it. `model` is the record to call. `guide` is the
 * user-facing message for the unconfigured case, and is also what an agent sees
 * when it calls the tool, so the two paths cannot drift apart.
 *
 * @param options - `{ models, nativeProviders, provider, model, requestedModelId }`.
 * @returns `{ kind, model?, reason, guide? }`.
 */
export function routeRequest(options) {
  const models = options.models ?? []
  const native = matchesNativeRoute(options, models)

  // Rule 4a: the conversation model declares image generation itself, so the
  // request is served in place — no switch, no second endpoint, nothing injected.
  if (native !== undefined) {
    return { kind: 'native', model: native, reason: 'conversation-model-is-image-capable' }
  }

  const byId =
    typeof options.requestedModelId === 'string' && options.requestedModelId.length > 0
      ? models.find((model) => model.id === options.requestedModelId)
      : undefined
  if (byId !== undefined) {
    if (!isServable(byId)) return { kind: 'unusable', model: byId, reason: 'explicit-model-not-servable' }
    return { kind: 'configured', model: byId, reason: 'explicit-model-requested' }
  }

  const fallback = defaultModel(models)
  if (fallback !== undefined) {
    if (!isServable(fallback)) return { kind: 'unusable', model: fallback, reason: 'default-model-not-servable' }
    return { kind: 'configured', model: fallback, reason: 'default-model' }
  }

  // Rule 4c: nothing can serve it. The message is one sentence the user can act
  // on, and it names the exact place to fix it.
  return {
    kind: 'unconfigured',
    reason: models.length === 0 ? 'no-image-model-configured' : 'no-default-image-model',
    guide:
      models.length === 0
        ? 'This request needs an image model, but none is connected yet. Open Settings → Models and add one under "Image generation models" (protocol, endpoint, model id, and API key), then set it as the default.'
        : 'This request needs an image model, but no default is set. Open Settings → Models → "Image generation models" and choose one with "Set as default".',
  }
}

/**
 * The configured image-capable conversation route matching the live one, if any.
 *
 * Matching accepts a `provider/model` pair, a bare model id, or a bare provider,
 * because a deployment may name the route at whatever granularity its catalog
 * actually supports.
 *
 * @param options - `{ nativeRoutes, provider, model }`.
 * @param models - the configured image models, used only to hand back a record.
 */
function matchesNativeRoute(options, models) {
  const routes = Array.isArray(options.nativeRoutes) ? options.nativeRoutes : []
  const route = `${String(options.provider ?? '')}/${String(options.model ?? '')}`
  const match = routes
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0)
    .find((entry) => entry === route || entry === options.model || entry === options.provider)
  if (match === undefined) return undefined
  // Report the matching conversation route; the image-model list plays no part in
  // serving it, so the record is informational only.
  return models.find((model) => model.id === match) ?? { id: match, name: match, native: true }
}

/**
 * Whether the conversation route declares the capability.
 * @param options - `{ nativeRoutes, provider, model }`.
 */
export function conversationModelGeneratesImages(options) {
  const routes = Array.isArray(options.nativeRoutes) ? options.nativeRoutes : []
  const route = `${String(options.provider ?? '')}/${String(options.model ?? '')}`
  return routes.some((entry) => {
    const value = String(entry).trim()
    return value.length > 0 && (value === route || value === options.model || value === options.provider)
  })
}
