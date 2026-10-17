/**
 * The `generate_image` tool: the model-driven entry point into the same operation
 * the automatic path uses.
 *
 * It exists for two reasons. A model can ask for an image deliberately — with an
 * explicit prompt, size, or count — and a skill can call it with a prompt it has
 * already optimized. Both end in the identical `runImageRequest` call, so there is
 * one routing decision and one translation decision per image, whichever door the
 * request came through.
 *
 * The definition is written as a raw `ToolDefinition` rather than through
 * `defineTool` from `@deepseek-ai/dsh-tools`. A harness package would have to
 * resolve inside the profile, and nothing about a tool definition requires the
 * helper: the registry accepts `{ name, description, parameters, output, execute }`
 * directly and validates the schema itself. Arguments are checked here instead of
 * by the compiled wrapper.
 */

import { describeOutcome, runImageRequest } from './generate.mjs'

/** The tool's model-facing description. */
const DESCRIPTION = [
  'Generate one or more images from a text prompt and attach them to the conversation.',
  'Use this whenever the user asks for a picture, illustration, poster, diagram, logo, wallpaper, or any other visual to be produced.',
  'The plugin picks the image model: one already configured as image-capable handles it, otherwise the globally default image model configured under Settings, Models, "Image generation models" is called, and the conversation model never changes.',
  'A request that came from a skill sets source to "skill" so the plugin applies no default words of its own.',
  'Do not describe an image you would have drawn — call this tool and the real image is attached.',
].join(' ')

/** Raw JSON Schema for the arguments, within the registry-supported subset. */
export const PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'The image prompt, as written. Do not translate, shorten, or add style words.',
    },
    model: {
      type: 'string',
      description: 'Optional id of a configured image model from the settings page. Omit to use the default image model.',
    },
    source: {
      type: 'string',
      enum: ['user', 'agent', 'skill'],
      description: 'Where the prompt came from. "skill" keeps the prompt verbatim and turns off the plugin default-word completion.',
    },
    width: { type: 'integer', minimum: 1, description: 'Optional width in pixels; overrides any size stated in the prompt and the stored size.' },
    height: { type: 'integer', minimum: 1, description: 'Optional height in pixels; overrides any size stated in the prompt and the stored size.' },
    ratio: {
      type: 'string',
      description: 'Optional aspect ratio such as "16:9", "9:16", or "1:1". Resolved to a pixel size when width and height are not given.',
    },
    count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many images to generate. Defaults to 1.' },
    style: {
      type: 'string',
      description: 'Optional style such as "oil painting" or "anime". Carried as a prompt hint, because none of the supported protocols declares a style field.',
    },
    negative: {
      type: 'string',
      description: 'Optional negative prompt: what the picture must not contain. Sent where the target protocol supports it.',
    },
  },
  required: ['prompt'],
}

/** The declared shape of one generated image in the tool's value. */
const IMAGE_PROPERTIES = {
  attachmentId: { type: 'string' },
  mediaType: { type: 'string' },
  bytes: { type: 'integer' },
  width: { type: 'integer' },
  height: { type: 'integer' },
  name: { type: 'string' },
}

/**
 * Normalize and check the model-generated arguments. Invalid input is a normal
 * outcome, not a crash: the caller turns it into an error result.
 *
 * @param args - the raw arguments.
 * @returns `{ ok: true, request }` or `{ ok: false, message }`.
 */
export function readArguments(args) {
  const source = args !== null && typeof args === 'object' ? args : {}
  const prompt = typeof source.prompt === 'string' ? source.prompt : ''
  if (prompt.trim().length === 0) return { ok: false, message: 'prompt must be a non-empty string' }
  if (source.source !== undefined && !['user', 'agent', 'skill'].includes(source.source)) {
    return { ok: false, message: 'source must be one of "user", "agent", or "skill"' }
  }
  for (const key of ['width', 'height', 'count']) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || value < 1) return { ok: false, message: `${key} must be a positive integer` }
  }
  if (Number.isInteger(source.count) && source.count > 4) return { ok: false, message: 'count must be at most 4' }
  if (source.ratio !== undefined && source.ratio !== null && !/^\s*\d{1,2}\s*[:：]\s*\d{1,2}\s*$/.test(String(source.ratio))) {
    return { ok: false, message: 'ratio must look like "16:9"' }
  }
  for (const key of ['style', 'negative']) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return { ok: false, message: `${key} must be a string` }
  }
  return {
    ok: true,
    request: {
      prompt,
      modelId: typeof source.model === 'string' && source.model.length > 0 ? source.model : undefined,
      source: source.source === 'skill' ? 'skill' : source.source === 'agent' ? 'agent' : 'user',
      width: Number.isInteger(source.width) ? source.width : undefined,
      height: Number.isInteger(source.height) ? source.height : undefined,
      // Normalize the ratio's full-width colon so the resolver sees one spelling.
      ratio: typeof source.ratio === 'string' ? source.ratio.replace('：', ':').replace(/\s+/g, '') : undefined,
      count: Number.isInteger(source.count) ? source.count : 1,
      style: typeof source.style === 'string' && source.style.length > 0 ? source.style : undefined,
      negative: typeof source.negative === 'string' && source.negative.length > 0 ? source.negative : undefined,
    },
  }
}

/**
 * Build the registry-ready tool definition.
 *
 * @param deps - `{ getState }`; `getState()` returns the live state
 *   `runImageRequest` needs, read fresh on every call so a settings change applies
 *   without re-registering the tool.
 * @returns the definition for `ctx.tools.register`.
 */
export function createImageToolDefinition(deps) {
  return {
    name: 'generate_image',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          handledByModel: { type: 'boolean' },
          modelId: { type: 'string' },
          modelName: { type: 'string' },
          protocol: { type: 'string' },
          passThrough: { type: 'boolean' },
          degraded: { type: 'boolean' },
          promptSent: { type: 'string' },
          endpoint: { type: 'string' },
          parameters: { type: 'object' },
          images: { type: 'array', items: { type: 'object', properties: IMAGE_PROPERTIES } },
        },
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: String(value?.summary ?? '') }]
        // The prompt actually sent is part of the result, not buried in a log: a
        // user debugging a bad picture needs to see what the model was told.
        if (typeof value?.promptSent === 'string' && value.promptSent.length > 0) {
          blocks.push({ type: 'text', text: `Prompt sent to the image model:\n${value.promptSent}` })
        }
        for (const image of Array.isArray(value?.images) ? value.images : []) {
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: image.attachmentId,
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              ...(image.name === undefined ? {} : { name: image.name }),
            },
          })
        }
        return blocks
      },
      presentationMeta(_args, value) {
        return {
          ...(value?.modelName === undefined ? {} : { model: value.modelName }),
          ...(Array.isArray(value?.images) ? { images: value.images.length } : {}),
        }
      },
    },
    // Concurrent calls each spend money on a provider, so they are serialized
    // rather than fanned out.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const read = readArguments(args)
      if (read.ok !== true) {
        return { summary: `The image request was not understood: ${read.message}`, images: [] }
      }
      const request = { ...read.request, signal: exec.signal }
      // The calling agent is what makes the live conversation route readable, so
      // the native-capability check sees the model this call actually runs under.
      const result = await runImageRequest(deps.getState(exec.agent), request)
      const summary = describeOutcome(result, request)

      if (result.ok === true && result.handledByModel === true) {
        return { summary, handledByModel: true, images: [] }
      }
      if (result.ok !== true) {
        // The summary explains the refusal so the model relays it instead of
        // inventing a picture it cannot produce.
        return { summary, images: [] }
      }
      const trace = result.trace ?? {}
      return {
        summary,
        modelId: trace.modelId ?? result.decision.modelId,
        modelName: trace.modelName ?? result.decision.modelName,
        protocol: trace.protocol ?? result.decision.protocol,
        endpoint: trace.endpoint,
        passThrough: result.decision.passThrough === true,
        degraded: result.decision.degraded === true,
        promptSent: trace.promptSent ?? result.decision.prompt,
        parameters: trace.parameters ?? {},
        images: result.refs.map((ref) => ({
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        })),
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Generate image: ${String(args?.prompt ?? '').slice(0, 80)}`,
        kind: 'other',
        rawInput: args,
      }
    },
  }
}

/**
 * Register the image-generation tool.
 *
 * @param ctx - the registering context.
 * @param deps - `{ getState }` as for {@link createImageToolDefinition}.
 * @returns the registration disposer.
 */
export function registerImageTool(ctx, deps) {
  return ctx.tools.register(createImageToolDefinition(deps))
}

/**
 * A configuration self-check the user can run from the conversation.
 *
 * It reports what the plugin actually resolved — not what is stored — so a
 * mismatch between "the page saved it" and "the plugin sees it" is one tool call
 * away from being visible. The API key is reported as a length, never echoed.
 *
 * @param deps - `{ getState }`.
 * @returns the definition for `ctx.tools.register`.
 */
export function createStatusToolDefinition(deps) {
  return {
    name: 'image_studio_status',
    description:
      'Report the image-generation configuration this plugin currently sees: every configured image model, whether each has an API key, which one is the default, which routes are declared image-capable, and each endpoint\'s callability. Use it when image generation does not work as expected.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          modelCount: { type: 'integer' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.summary ?? '') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const state = deps.getState(exec?.agent)
      const models = Array.isArray(state?.models) ? state.models : []
      const nativeRoutes = Array.isArray(state?.nativeRoutes) ? state.nativeRoutes : []
      const route = `${String(state?.provider ?? '?')}/${String(state?.model ?? '?')}`
      const lines = [
        `Image generation: ${String(models.length)} model(s) configured; conversation route ${route}; declared image-capable routes: ${nativeRoutes.length > 0 ? nativeRoutes.join(', ') : 'none'}; automatic scheduling ${state?.automatic === false ? 'off' : 'on'}.`,
      ]
      if (models.length === 0) {
        lines.push('No image model is visible to the plugin. Add one on the settings page — or restart the app if that page already shows one.')
      }
      for (const model of models) {
        const callable =
          ['openai-images', 'openai-images-edits', 'stability-sd-webui'].includes(model.protocol) &&
          /^https?:\/\//i.test(String(model.baseUrl ?? '').trim())
        lines.push(
          `- ${model.name} [${model.protocol}] ${model.baseUrl} model=${model.model} default=${String(model.isDefault)} key=${model.apiKey.length > 0 ? `set (${String(model.apiKey.length)} chars)` : 'MISSING'} timeout=${String(model.params?.timeoutMs ?? '?')}ms${callable ? '' : ' — NOT callable'}`,
        )
      }
      return { summary: lines.join('\n'), modelCount: models.length }
    },
  }
}

/**
 * Register the configuration self-check.
 *
 * @param ctx - the registering context.
 * @param deps - `{ getState }`.
 * @returns the registration disposer.
 */
export function registerStatusTool(ctx, deps) {
  return ctx.tools.register(createStatusToolDefinition(deps))
}
