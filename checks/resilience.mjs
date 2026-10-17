/**
 * The resilience layer: translation degradation, skill priority, request clamping,
 * and failure classification.
 *
 * These decide whether a fault *interrupts* the conversation or merely reports
 * itself, so every failure path is exercised here.
 *
 * Run: node checks/resilience.mjs
 */
import assert from 'node:assert/strict'

import { MAX_IMAGES, classifyFailure, clampRequest, passthrough, skillOwnsImageGeneration, translateWithFallback } from '../src/resilience.mjs'

let failures = 0
/** Run one named case, recording failure instead of aborting the suite. */
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

const model = { id: 'img-1', name: 'Relay', protocol: 'openai-images' }

// ------------------------------------------------------------------ degradation

check('a healthy translation is used as-is', () => {
  const outcome = translateWithFallback(() => ({ ok: true, prompt: 'a cat', reason: 'auto-format-match' }), model, { prompt: 'a cat' })
  assert.equal(outcome.degraded, false)
  assert.equal(outcome.resolved.prompt, 'a cat')
})

check('a throwing translator degrades to a verbatim pass-through', () => {
  const outcome = translateWithFallback(
    () => {
      throw new Error('boom')
    },
    model,
    { prompt: 'a cat on a windowsill', negative: 'blur' },
  )
  assert.equal(outcome.degraded, true)
  assert.equal(outcome.resolved.ok, true, 'the request must still be usable')
  assert.equal(outcome.resolved.prompt, 'a cat on a windowsill', 'the author\'s text is sent verbatim')
  assert.equal(outcome.resolved.negative, 'blur')
  assert.equal(outcome.resolved.reason, 'translation-fallback-passthrough')
  assert.match(outcome.note, /translation faulted/)
})

check('a refused translation also degrades, carrying the reason', () => {
  const outcome = translateWithFallback(() => ({ ok: false, reason: 'no-model' }), model, { prompt: 'a cat' })
  assert.equal(outcome.degraded, true)
  assert.equal(outcome.resolved.prompt, 'a cat')
  assert.match(outcome.note, /no-model/)
})

check('an empty prompt is not treated as a translator fault', () => {
  const outcome = translateWithFallback(() => ({ ok: false, reason: 'empty-prompt' }), model, { prompt: '' })
  assert.equal(outcome.degraded, false, 'the caller sent nothing; there is nothing to degrade to')
  assert.equal(outcome.resolved.ok, false)
})

check('the pass-through target never maps parameters it cannot know', () => {
  const target = passthrough(model, { prompt: 'x' })
  assert.deepEqual(target.params, {})
  assert.equal(target.modelId, 'img-1')
})

// --------------------------------------------------------------- skill priority

check('another plugin\'s image tool makes the scheduler stand aside', () => {
  const messages = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '画一张猫' }] },
    { id: 'm2', role: 'user', content: [{ type: 'tool-call', name: 'mcp__imagegen__create_image', arguments: {} }] },
  ]
  const ownership = skillOwnsImageGeneration(messages)
  assert.equal(ownership.owned, true)
  assert.equal(ownership.toolName, 'mcp__imagegen__create_image')
})

check('this plugin\'s own tools never count as a conflict', () => {
  const messages = [{ id: 'm1', role: 'user', content: [{ type: 'tool-call', name: 'generate_image', arguments: {} }] }]
  assert.equal(skillOwnsImageGeneration(messages).owned, false)
  const status = [{ id: 'm1', role: 'user', content: [{ type: 'tool-call', name: 'image_studio_status', arguments: {} }] }]
  assert.equal(skillOwnsImageGeneration(status).owned, false)
})

check('an unrelated tool call does not suppress generation', () => {
  const messages = [{ id: 'm1', role: 'user', content: [{ type: 'tool-call', name: 'read_file', arguments: {} }] }]
  assert.equal(skillOwnsImageGeneration(messages).owned, false)
})

check('malformed messages are skipped, not crashed on', () => {
  assert.equal(skillOwnsImageGeneration(undefined).owned, false)
  assert.equal(skillOwnsImageGeneration([null, 'x', { content: 'nope' }]).owned, false)
})

// --------------------------------------------------------------------- clamping

check('a wild size is clamped and a wild count is bounded', () => {
  const clamped = clampRequest({ width: 99999, height: -5, count: 40 })
  assert.equal(clamped.width, 4096)
  assert.equal(clamped.height, undefined, 'a non-positive side is dropped, not coerced')
  assert.equal(clamped.count, MAX_IMAGES)
})

check('missing values stay missing so the template applies', () => {
  const clamped = clampRequest({})
  assert.equal(clamped.width, undefined)
  assert.equal(clamped.height, undefined)
  assert.equal(clamped.count, 1)
})

// ---------------------------------------------------------------- classification

check('an authentication failure is named and marked actionable', () => {
  const failure = classifyFailure({ kind: 'http-error', status: 401, message: 'HTTP 401 Unauthorized: bad key' })
  assert.equal(failure.kind, 'auth')
  assert.equal(failure.guide, true)
  assert.match(failure.message, /rejected the API key/)
  assert.match(failure.message, /bad key/, 'the provider text is preserved')
})

check('a rate limit is distinguished from an auth failure', () => {
  const failure = classifyFailure({ kind: 'http-error', status: 429, message: 'HTTP 429: 1302: slow down' })
  assert.equal(failure.kind, 'rate-limit')
  assert.match(failure.message, /rate limiting/)
  assert.match(failure.message, /1302: slow down/)
})

check('a rejected parameter is a bad request, not a crash', () => {
  const failure = classifyFailure({ kind: 'http-error', status: 400, message: 'HTTP 400: size must be one of' })
  assert.equal(failure.kind, 'bad-request')
  assert.match(failure.message, /rejected the request/)
})

check('a server error is reported as the provider\'s fault', () => {
  const failure = classifyFailure({ kind: 'http-error', status: 503, message: 'HTTP 503: unavailable' })
  assert.equal(failure.kind, 'server')
})

check('a transport fault reads as unreachable, not as a bad key', () => {
  const failure = classifyFailure({ kind: 'transport', message: 'fetch failed' })
  assert.equal(failure.kind, 'network')
  assert.equal(failure.guide, true)
  assert.match(failure.message, /could not be reached/)
})

check('a timeout tells the user what to raise', () => {
  const failure = classifyFailure({ kind: 'timeout', message: 'the endpoint did not answer within 300s' })
  assert.equal(failure.kind, 'timeout')
  assert.equal(failure.guide, true)
  assert.match(failure.message, /within 300s/)
})

check('a cancellation is not treated as a fault to fix', () => {
  const failure = classifyFailure({ kind: 'aborted', message: 'cancelled' })
  assert.equal(failure.kind, 'cancelled')
  assert.equal(failure.guide, false, 'a user cancellation needs no instruction')
})

check('a configuration gap is the one failure the user must act on', () => {
  const failure = classifyFailure({ kind: 'unconfigured', message: 'add an image model' })
  assert.equal(failure.kind, 'config')
  assert.equal(failure.guide, true)
  assert.equal(failure.message, 'add an image model')
})

check('an unreadable provider body becomes a bad response', () => {
  assert.equal(classifyFailure({ kind: 'bad-json', message: 'not JSON' }).kind, 'bad-response')
  assert.equal(classifyFailure({ kind: 'no-image', message: 'no usable image' }).kind, 'bad-response')
})

check('an unrecognised failure still classifies', () => {
  const failure = classifyFailure({ kind: 'something-new', message: 'details' })
  assert.equal(failure.kind, 'internal')
  assert.equal(failure.message, 'details')
})

check('every classified kind is in the declared vocabulary', () => {
  const kinds = [
    classifyFailure({ kind: 'http-error', status: 401 }),
    classifyFailure({ kind: 'http-error', status: 429 }),
    classifyFailure({ kind: 'http-error', status: 400 }),
    classifyFailure({ kind: 'http-error', status: 500 }),
    classifyFailure({ kind: 'transport' }),
    classifyFailure({ kind: 'timeout' }),
    classifyFailure({ kind: 'aborted' }),
    classifyFailure({ kind: 'unconfigured' }),
    classifyFailure({ kind: 'bad-json' }),
    classifyFailure({ kind: 'unknown' }),
  ].map((failure) => failure.kind)
  for (const kind of kinds) {
    assert.ok(['auth', 'timeout', 'network', 'rate-limit', 'bad-request', 'server', 'bad-response', 'no-image', 'config', 'empty', 'cancelled', 'internal'].includes(kind), `undeclared kind ${kind}`)
  }
  assert.equal(new Set(kinds).size, kinds.length, 'each cause maps to its own kind')
})

console.log(failures === 0 ? '\nall resilience checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
