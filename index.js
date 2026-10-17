/**
 * Host half of `dsh-image-studio`.
 *
 * Stage 1 owns the image-model configuration and the settings page that edits it.
 * Stage 2 adds the scheduler:
 *
 * - **Detection** (`src/intent.mjs`) reads the claimed user messages of a step and
 *   decides whether a picture was asked for.
 * - **Capability** (`src/router.mjs`) answers whether the conversation model
 *   already owns image generation. The Harness declares input modalities only, so
 *   this is an explicit user-owned route list rather than a catalog probe.
 * - **Translation** (`src/prompt.mjs`) passes a compatible prompt through byte for
 *   byte and converts only on a real format mismatch.
 * - **Routing** (same module) leaves a native-capable model alone, otherwise calls
 *   the configured default image model, and otherwise explains how to configure one.
 * - **Delivery** uses `agent/pre-step`: the generated image is added to the current
 *   step as a durable user message, so it reaches the model context and the
 *   conversation UI without changing the conversation model or opening a tool call.
 *
 * The same operation is also exposed as the `generate_image` tool, so a model or a
 * skill can ask for an image deliberately and get identical routing and
 * translation decisions.
 */
import { randomUUID } from 'node:crypto'

import z from '@deepseek-ai/schemastery'

import { describeOutcome, detectRequestInMessages, runImageRequest } from './src/generate.mjs'
import { skillOwnsImageGeneration } from './src/resilience.mjs'
import { registerImageTool, registerStatusTool } from './src/tool.mjs'
import { readModels } from './src/router.mjs'

/** Settings namespace (Loader entry id and profile patch row id) owned by this plugin. */
export const IMAGE_STUDIO_NAMESPACE = 'image-studio'

/** Image-generation protocol a record speaks. */
export const IMAGE_PROTOCOLS = [
  'openai-images',
  'openai-images-edits',
  'stability-sd-webui',
  'custom',
]

/** How a record's prompt text is assembled. */
export const PROMPT_FORMATS = ['natural', 'sd-tags', 'custom']

/** Per-model pass-through policy: decide from the formats, always hold, always convert. */
export const PASS_THROUGH_MODES = ['auto', 'always', 'never']

/** The `source.kind` this plugin stamps on the messages it contributes. */
export const IMAGE_MESSAGE_SOURCE_KIND = 'image-studio'

/** One `{ name, value }` request header. An array keeps the editor's row order. */
const header = z.object({
  name: z.string().default(''),
  value: z.string().default(''),
})

/**
 * One connected image-generation model.
 *
 * `apiKey` carries `role('secret')`, so the Settings service hides its value from
 * every remote read and reports only whether the position currently holds one:
 * the page can clear and replace the key but never echo it. Nested roles are what
 * force {@link Config}'s single volatile node to sit on the array itself (the
 * Loader rejects a volatile field inside a volatile container).
 */
const imageModel = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  protocol: z.union(IMAGE_PROTOCOLS).default('openai-images'),
  baseUrl: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
  model: z.string().default(''),
  headers: z.array(header).default([]),
  promptFormat: z.union(PROMPT_FORMATS).default('natural'),
  promptPassThrough: z.union(PASS_THROUGH_MODES).default('auto'),
  promptPrefix: z.string().default(''),
  promptNegative: z.string().default(''),
  promptTemplate: z.string().default(''),
  params: z.object({
    size: z.string().default(''),
    width: z.natural().default(1024),
    height: z.natural().default(1024),
    steps: z.natural().default(0),
    // Image models routinely take a minute or more per image; a tight deadline
    // discards a generation the user already paid for.
    timeoutMs: z.natural().default(300000),
  }).default({}),
  isDefault: z.boolean().default(false),
})

/**
 * Live plugin configuration. One volatile node holds the whole model list: the
 * Loader commits volatile changes into the running fiber without restarting this
 * plugin, and the Settings service persists them through the profile patch, so
 * the list survives an application restart.
 */
const Config = z.object({
  imageModels: z.array(imageModel).default([]).volatile(),
  /**
   * Conversation routes that generate images by themselves, written as
   * `provider/model` (a bare model id or provider also matches). A request routed
   * here is left to the conversation model and never triggers a second endpoint.
   */
  nativeImageRoutes: z.array(z.string()).default([]).volatile(),
  /** Whether a user prompt asking for a picture triggers generation without a tool call. */
  autoGenerate: z.boolean().default(true).volatile(),
  /** Whether the generated image is also announced as text in the conversation. */
  announce: z.boolean().default(true).volatile(),
  /** How many images one automatic request may produce. */
  autoImageCount: z.natural().default(1).volatile(),
  /** Optional size for automatic requests; 0 keeps each model's stored size. */
  autoWidth: z.natural().default(0).volatile(),
  autoHeight: z.natural().default(0).volatile(),
})

export { Config }

/**
 * Activate the Host half.
 *
 * @param ctx - plugin context.
 * @param config - the validated row configuration.
 */
export function apply(ctx, config) {
  /** The symbol `@deepseek-ai/cosmokit` brands a live volatile reference with. */
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

  /**
   * Replace every live volatile reference with the value it currently holds.
   *
   * A `.volatile()` field validates into a getter-backed reference object, and
   * `JSON.stringify` serializes that wrapper as `{}` — which would silently erase
   * the whole model list. Unwrapping first is what makes the detach below safe.
   *
   * @param value - a validated config value.
   */
  const unwrapVolatile = (value) => {
    if (value === null || typeof value !== 'object') return value
    if (typeof value.get === 'function' && Object.getOwnPropertySymbols(value).includes(VOLATILE_WRITE)) {
      try {
        return unwrapVolatile(value.get())
      } catch (_failure) {
        return undefined
      }
    }
    if (Array.isArray(value)) return value.map(unwrapVolatile)
    const result = {}
    for (const [key, child] of Object.entries(value)) result[key] = unwrapVolatile(child)
    return result
  }

  /**
   * Copy one config value into a detached plain value.
   *
   * @param value - the live config, or a section of it.
   */
  const detach = (value) => {
    try {
      return JSON.parse(JSON.stringify(unwrapVolatile(value)))
    } catch (_failure) {
      return undefined
    }
  }

  /**
   * Every place this plugin's live section can be read from, most authoritative
   * first.
   *
   * A plugin whose row comes from a **bundle layer** rather than from the profile
   * patch owns no profile row, and the activation-time `config` argument is the
   * value captured when the entry loaded — for this plugin, before any image model
   * existed. The owner's own entry answers what the page last saved; the live
   * fiber answers a volatile commit; the argument is the last resort for a
   * deployment that configures this plugin in a patch layer.
   *
   * Each value is validated through {@link Config} separately, so one candidate the
   * schema rejects (an entry mid-edit, or a `!!js` expression in a scalar field)
   * cannot mask a usable one behind it.
   */
  const configCandidates = () => {
    const candidates = []
    try {
      const configEditor = ctx.get('configEditor')
      if (configEditor !== undefined && configEditor !== null) {
        const own = configEditor.entries().find((entry) => entry?.options?.id === IMAGE_STUDIO_NAMESPACE)
        if (own !== undefined) candidates.push(own.options?.config)
      }
    } catch (_failure) {
      // A context without the config editor keeps the fallbacks below.
    }
    try {
      candidates.push(ctx.fiber?.config)
    } catch (_failure) {
      // An unattached fiber is simply not a candidate.
    }
    candidates.push(config)
    return candidates
  }

  /** The validated live section, or undefined when no candidate resolves. */
  const storedSection = () => {
    for (const candidate of configCandidates()) {
      const detached = detach(candidate)
      if (detached === undefined || detached === null || typeof detached !== 'object') continue
      try {
        return detach(Config(detached))
      } catch (_failure) {
        // Try the next candidate.
      }
    }
    return undefined
  }

  /**
   * The live configuration, re-read on every decision so an edit applies at once.
   * `storedSection()` already detached and validated its value.
   */
  const currentConfig = () => {
    const stored = storedSection()
    return stored ?? {}
  }

  /**
   * Resolve the conversation route of one agent, following the codebase idiom:
   * the live session header first, then the creation-time options.
   *
   * @param agent - the agent, or undefined.
   */
  const resolveRoute = (agent) => {
    let routed
    try {
      routed = agent?.session?.requestHeader?.()?.config
    } catch (_failure) {
      routed = undefined
    }
    return {
      provider: routed?.provider ?? agent?.options?.provider,
      model: routed?.model ?? agent?.options?.model,
    }
  }

  /** Build the state one generation call needs, read fresh every time. */
  const stateFor = (agent) => {
    const live = currentConfig()
    const route = resolveRoute(agent)
    return {
      models: readModels({ imageModels: live.imageModels }),
      nativeRoutes: Array.isArray(live.nativeImageRoutes) ? live.nativeImageRoutes : [],
      automatic: live.autoGenerate !== false,
      provider: route.provider,
      model: route.model,
      attachments: ctx.get('attachments'),
      fetchImpl: globalThis.fetch,
    }
  }

  // The settings page is hand written, so the automatic per-schema form is off.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, settingsCtx.fiber),
      'image-studio: page policy',
    )
  })

  // The model-driven door. Registered globally so every agent and every skill sees
  // it; execution resolves the calling agent's route, which is why the tool's
  // `getState` receives `exec.agent`.
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(
      () => registerImageTool(toolsCtx, { getState: (agent) => stateFor(agent) }),
      'image-studio: generate_image tool',
    )
    toolsCtx.effect(
      () => registerStatusTool(toolsCtx, { getState: (agent) => stateFor(agent) }),
      'image-studio: status tool',
    )
  })

  // Tell the model what the tool is for, without spending a tool call on the
  // common case: the scheduler below already handles a plain user request.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'image-studio',
          order: 3000,
          complete: true,
          text: [
            'The harness routes image generation for this session: a request for a picture is detected from the conversation and generated by the configured image model, then attached to the conversation as an image.',
            'Call the `generate_image` tool when you need to choose the prompt, size, or count yourself, or when a skill instructs you to.',
            'Never claim to have drawn an image without calling `generate_image`, and never describe an image you did not receive.',
          ].join(' '),
        }),
      'image-studio: prompt section',
    )
  })

  // Delivery. Per-agent registration on `agent.ctx`, with the disposer kept here
  // so plugin unload and agent disposal both release it.
  const perAgent = new Map()
  ctx.effect(() => {
    const disposers = [
      ctx.on('agent/created', ({ agent }) => {
        const dispose = agent.ctx.effect(function* registerImageScheduler() {
          // The loop dispatches `agent/pre-step` with `{ messages, turn, step, signal }`
          // and carries the agent on `this` rather than in the payload. This listener
          // is registered per-agent on `agent.ctx`, so the agent is already in scope:
          // closing over it keeps the live-route lookup correct without depending on
          // the dispatch shape.
          yield agent.ctx.on('agent/pre-step', async (payload, next) => {
            const decision = await next()
            try {
              return await scheduleBeforeStep(ctx, agent, payload, decision, currentConfig(), stateFor)
            } catch (error) {
              // A scheduler failure must never break the turn: the step proceeds
              // exactly as it would have without this plugin.
              ctx.logger?.warn?.(
                `image-studio: scheduling failed: ${error instanceof Error ? error.message : String(error)}`,
              )
              return decision
            }
          })
        }, 'image-studio: agent scheduler')
        perAgent.set(agent.id, dispose)
      }),
      ctx.on('agent/disposed', ({ agent }) => {
        perAgent.get(agent.id)?.()
        perAgent.delete(agent.id)
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      for (const dispose of perAgent.values()) dispose()
      perAgent.clear()
    }
  }, 'image-studio: agent lifecycle')
}

/**
 * Build one user-role message of this plugin's own.
 *
 * The message is written out here rather than through `createUserMessage` from
 * `@deepseek-ai/dsh-llm`: that package resolves only inside the installation, so
 * importing it would make this bundle unloadable in a profile. The shape is the
 * documented one — `{ role, content, source, id }`, frozen before publication —
 * and a plain string id is what the constructor produces anyway.
 *
 * @param input - `{ content, source }`.
 */
function createUserMessage(input) {
  return Object.freeze({
    role: 'user',
    id: randomUUID(),
    content: input.content,
    source: input.source,
  })
}

/**
 * The automatic path: inspect the claimed messages of one step, and on an image
 * request generate the picture and add it to the step.
 *
 * The decision is rewritten by spreading it, so fields this listener does not own
 * (`kind`, `startsRequestSeries`) survive.
 *
 * @param ctx - plugin context.
 * @param agent - the agent this listener was registered for. The loop dispatches
 *   `agent/pre-step` with `{ messages, turn, step, signal }` and carries the agent
 *   on `this`, so the agent is taken from the per-agent registration scope rather
 *   than from the payload.
 * @param payload - the `agent/pre-step` payload.
 * @param decision - the decision `next()` produced.
 * @param config - the live configuration.
 * @param stateFor - builds the generation state for an agent.
 */
async function scheduleBeforeStep(ctx, agent, payload, decision, config, stateFor) {
  if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
  // The total switch. When it is off the plugin contributes nothing here at all;
  // the `generate_image` tool stays available to the model and to skills.
  if (config.autoGenerate !== true) return decision
  if (payload.signal?.aborted) return decision

  // Skill priority: when the author already called an image-generation tool, the
  // plugin must not add a second generation. The author's choice wins outright —
  // nothing is called and nothing is injected.
  const ownership = skillOwnsImageGeneration(payload.messages)
  if (ownership.owned === true) {
    ctx.logger?.debug?.(
      `image-studio: standing aside because "${String(ownership.toolName)}" already handles image generation`,
    )
    return decision
  }

  const detected = detectRequestInMessages(payload.messages, IMAGE_MESSAGE_SOURCE_KIND)
  if (detected.wanted !== true) return decision

  const result = await runImageRequest(stateFor(agent), {
    prompt: detected.prompt,
    source: detected.source,
    // The plugin-level defaults, in their own slot: a value the user wrote in the
    // sentence must win over a value this code filled in.
    defaultCount: config.autoImageCount,
    width: config.autoWidth > 0 ? config.autoWidth : undefined,
    height: config.autoHeight > 0 ? config.autoHeight : undefined,
    signal: payload.signal,
  })

  // The conversation model owns the capability: leave the step exactly as it is.
  if (result.ok === true && result.handledByModel === true) return decision

  if (result.ok !== true) {
    // Only a failure the user must act on — nothing is configured, or what is
    // configured cannot be called — becomes a conversation message. A provider blip
    // (a timeout, a rejected key, a rate limit) is logged instead: turning every
    // failed call into a chat message would bury the conversation, and the model can
    // still answer without a picture.
    if (result.kind === 'unconfigured' || result.kind === 'unusable') {
      const notice = createUserMessage({
        content: [{ type: 'text', text: `[Image generation] ${result.message}` }],
        source: { kind: IMAGE_MESSAGE_SOURCE_KIND },
      })
      return { ...decision, messages: [...decision.messages, notice] }
    }
    ctx.logger?.warn?.(
      `image-studio: ${result.failure?.kind ?? result.kind}: ${result.message}${result.failure?.kind === undefined ? '' : ` (cause: ${result.kind})`}`,
    )
    return decision
  }

  const summary = describeOutcome(result, { source: detected.source })
  const content = []
  if (config.announce !== false) content.push({ type: 'text', text: `[Image generation] ${summary}` })
  for (const ref of result.refs) content.push({ type: 'image', attachment: ref })

  const message = createUserMessage({ content, source: { kind: IMAGE_MESSAGE_SOURCE_KIND } })
  return { ...decision, messages: [...decision.messages, message] }
}
