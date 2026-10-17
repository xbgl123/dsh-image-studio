/**
 * Prompt translation rules. The pass-through promise is the point of this file:
 * when formats match, the body must come out byte for byte.
 *
 * Run: node checks/prompt.mjs
 */
import assert from 'node:assert/strict'

import {
  assemblePrompt,
  detectPromptFormat,
  mapParams,
  nativeFormatOf,
  naturalToTags,
  tagsToNatural,
  translateRequest,
} from '../src/prompt.mjs'

let failures = 0
/** Run one named case, recording a failure instead of throwing out of the suite. */
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

/** An OpenAI Images model row, as step 1 stores it. */
const openaiModel = (overrides = {}) => ({
  id: 'openai-1',
  name: 'Relay',
  protocol: 'openai-images',
  baseUrl: 'https://relay.example/v1',
  model: 'gpt-image-1',
  promptFormat: 'natural',
  promptPassThrough: 'auto',
  promptPrefix: '',
  promptNegative: '',
  promptTemplate: '',
  params: { size: '', width: 1024, height: 1024, steps: 0, timeoutMs: 120000 },
  isDefault: true,
  ...overrides,
})

/** A Stable Diffusion WebUI model row. */
const sdModel = (overrides = {}) => ({
  id: 'sd-1',
  name: 'Local SD',
  protocol: 'stability-sd-webui',
  baseUrl: 'http://127.0.0.1:7860',
  model: 'sd_xl_base_1.0',
  promptFormat: 'sd-tags',
  promptPassThrough: 'auto',
  promptPrefix: 'masterpiece, best quality',
  promptNegative: 'worst quality, blurry',
  promptTemplate: '',
  params: { size: 'square', width: 1024, height: 1024, steps: 28, timeoutMs: 180000 },
  isDefault: false,
  ...overrides,
})

// ------------------------------------------------------------ format detection

check('weight syntax reads as tags', () => {
  assert.equal(detectPromptFormat('(masterpiece:1.3), 1girl, blue hair'), 'sd-tags')
  assert.equal(detectPromptFormat('best quality, <lora:add_detail:0.8>, cat'), 'sd-tags')
})

check('a sentence reads as natural language', () => {
  assert.equal(detectPromptFormat('A cat sitting on a windowsill at sunset.'), 'natural')
  assert.equal(detectPromptFormat('画一只在窗台上看夕阳的猫'), 'natural')
})

check('commas alone never make a prompt tag-style', () => {
  // Misreading this would rewrite a prompt that must pass through untouched, so
  // only weight syntax counts as evidence.
  assert.equal(detectPromptFormat('cat, windowsill, sunset, warm light'), 'natural')
  assert.equal(detectPromptFormat('a cat, a window, a sunset'), 'natural')
})

check('each protocol has a native format', () => {
  assert.equal(nativeFormatOf('openai-images'), 'natural')
  assert.equal(nativeFormatOf('openai-images-edits'), 'natural')
  assert.equal(nativeFormatOf('stability-sd-webui'), 'sd-tags')
  assert.equal(nativeFormatOf('custom'), 'custom')
})

// --------------------------------------------------------------- conversions

check('natural language becomes tags without inventing words', () => {
  assert.equal(naturalToTags('一只猫坐在窗台上。暖色的夕阳，柔和的轮廓。'), '一只猫坐在窗台上, 暖色的夕阳, 柔和的轮廓')
})

check('weights become emphasis words, tags are dropped', () => {
  const converted = tagsToNatural('(masterpiece:1.4), 1girl, <lora:add_detail:0.8>, blue hair')
  assert.match(converted, /masterpiece \(emphasis\)/)
  assert.match(converted, /blue hair/)
  assert.doesNotMatch(converted, /lora/)
})

// ------------------------------------------------------- pass-through: the rule

check('OpenAI natural prompt to an OpenAI model passes through byte for byte', () => {
  const prompt = 'A cat sitting on a windowsill at sunset, warm cinematic light.'
  const resolved = translateRequest({ prompt }, openaiModel())
  assert.equal(resolved.ok, true)
  assert.equal(resolved.passThrough, true)
  assert.equal(resolved.translated, false)
  assert.equal(resolved.reason, 'auto-format-match')
  assert.equal(resolved.sourceFormat, 'natural')
  assert.equal(resolved.targetFormat, 'natural')
  assert.equal(resolved.prompt, prompt, 'the body must not change at all')
})

check('an OpenAI prompt containing commas is still passed through untouched', () => {
  // The heuristic could read this as tags; the match against the target wins.
  const prompt = 'a cat, a windowsill, a sunset'
  const resolved = translateRequest({ prompt }, openaiModel())
  assert.equal(resolved.prompt, prompt)
  assert.equal(resolved.translated, false)
})

check('SD tag prompt with weights to an SD model passes through byte for byte', () => {
  const prompt = '(masterpiece:1.3), 1girl, blue hair, detailed eyes'
  const resolved = translateRequest({ prompt }, sdModel())
  assert.equal(resolved.passThrough, true)
  assert.equal(resolved.translated, false)
  assert.equal(resolved.reason, 'auto-format-match')
  // The body is untouched; the model's own configured negative follows it, and a
  // configured prefix precedes it. Both are the user's settings, not rewriting.
  assert.ok(resolved.prompt.startsWith(`${sdModel().promptPrefix} ${prompt}`), 'the body must be preserved verbatim')
  assert.ok(resolved.prompt.endsWith(`${sdModel().promptNegative}`), 'the configured negative must follow')
})

check('a pass-through body is byte-identical when the model declares no defaults', () => {
  const prompt = 'a cat, a window, a sunset'
  const resolved = translateRequest({ prompt }, openaiModel())
  assert.equal(resolved.prompt, prompt, 'no prefix, no suffix, no whitespace change')
})

check('pass-through still maps size, count and steps to API fields', () => {
  const resolved = translateRequest({ prompt: 'a cat' }, openaiModel({ params: { size: 'square', width: 1536, height: 1024, steps: 20, timeoutMs: 90000 } }))
  assert.equal(resolved.passThrough, true)
  assert.equal(resolved.params.size, '1536x1024')
  assert.equal(resolved.params.steps, 20)
  assert.equal(resolved.params.timeoutMs, 90000)
})

check('SD pass-through maps width, height and steps', () => {
  const resolved = translateRequest({ prompt: '(cat:1.2)' }, sdModel())
  assert.equal(resolved.params.width, 1024)
  assert.equal(resolved.params.height, 1024)
  assert.equal(resolved.params.steps, 28)
})

// --------------------------------------------------- conversion only on mismatch

check('a natural prompt to an SD model is converted to tags', () => {
  const resolved = translateRequest({ prompt: '一只猫坐在窗台上。暖色的夕阳，柔和的轮廓。' }, sdModel())
  assert.equal(resolved.translated, true)
  assert.equal(resolved.reason, 'auto-format-mismatch')
  assert.equal(resolved.sourceFormat, 'natural')
  assert.equal(resolved.targetFormat, 'sd-tags')
  assert.match(resolved.prompt, /一只猫坐在窗台上, 暖色的夕阳, 柔和的轮廓/)
})

check('a tag prompt to an OpenAI model is converted to prose', () => {
  const resolved = translateRequest({ prompt: '(masterpiece:1.2), 1girl, blue hair' }, openaiModel())
  assert.equal(resolved.translated, true)
  assert.match(resolved.prompt, /masterpiece \(emphasis\), 1girl, blue hair\./)
  assert.doesNotMatch(resolved.prompt, /:1\.2/)
})

// --------------------------------------------------------- configured defaults

check('the model prefix is applied when the model declares one', () => {
  const resolved = translateRequest({ prompt: 'cat, window' }, sdModel())
  assert.match(resolved.prompt, /^masterpiece, best quality/)
})

check('the negative default rides SD prompts only', () => {
  const sd = translateRequest({ prompt: '(cat:1.2)' }, sdModel())
  assert.match(sd.prompt, /Negative prompt: worst quality, blurry/)
  const openai = translateRequest({ prompt: 'a cat' }, openaiModel({ promptNegative: 'blurry' }))
  assert.doesNotMatch(openai.prompt, /blurry/)
})

check('a custom template substitutes prompt, prefix and negative', () => {
  const model = openaiModel({
    protocol: 'custom',
    promptFormat: 'custom',
    promptTemplate: 'P:{prefix}|{prompt}|N:{negative}',
  })
  const text = assemblePrompt({ prompt: 'a cat' }, model, 'custom', { prefix: 'HQ ', negative: 'noise' })
  assert.equal(text, 'P:HQ |a cat|N:noise')
})

// ---------------------------------------------------------- optimized prompts

check('a skill prompt holds its text even when the format is wrong', () => {
  const prompt = '一只猫坐在窗台上。暖色的夕阳，柔和的轮廓。'
  const resolved = translateRequest({ prompt, source: 'skill' }, sdModel())
  assert.equal(resolved.passThrough, true)
  assert.equal(resolved.reason, 'auto-optimized-hold')
  assert.equal(resolved.prompt, prompt, 'a skill prompt is never rewritten and gets no defaults')
})

check('a skill prompt gets no default words either', () => {
  const resolved = translateRequest({ prompt: 'cat', source: 'skill' }, sdModel())
  assert.equal(resolved.prompt, 'cat')
  assert.doesNotMatch(resolved.prompt, /masterpiece/)
  assert.doesNotMatch(resolved.prompt, /Negative prompt/)
})

check('an explicit optimized flag holds the prompt for a user source too', () => {
  const resolved = translateRequest({ prompt: 'cat, window', optimized: true }, openaiModel())
  assert.equal(resolved.prompt, 'cat, window')
})

// ------------------------------------------------------------- policy switches

check('force pass-through holds the body, and reports the mismatch', () => {
  const prompt = '一只猫。夕阳。'
  const resolved = translateRequest({ prompt }, sdModel({ promptPassThrough: 'always', promptPrefix: '', promptNegative: '' }))
  assert.equal(resolved.passThrough, true)
  assert.equal(resolved.reason, 'policy-always')
  assert.equal(resolved.prompt, prompt, 'force pass-through changes nothing at all')
})

check('force conversion converts even a matching format', () => {
  const resolved = translateRequest({ prompt: 'a cat, a window' }, openaiModel({ promptPassThrough: 'never' }))
  assert.equal(resolved.passThrough, false)
  assert.equal(resolved.reason, 'policy-never-format-match')
})

check('force conversion on a matching SD prompt rewrites it through the tags path', () => {
  const resolved = translateRequest({ prompt: 'a cat sitting on a windowsill.' }, sdModel({ promptPassThrough: 'never' }))
  assert.equal(resolved.passThrough, false)
  assert.match(resolved.prompt, /a cat sitting on a windowsill/)
})

// ------------------------------------------------------------------- refusals

check('an empty prompt is refused, not sent', () => {
  assert.deepEqual(translateRequest({ prompt: '   ' }, openaiModel()), { ok: false, reason: 'empty-prompt' })
})

check('no configured model is refused with a reason', () => {
  assert.deepEqual(translateRequest({ prompt: 'a cat' }, undefined), { ok: false, reason: 'no-model' })
})

check('an unset size stays unset so the endpoint default applies', () => {
  const params = mapParams({ protocol: 'openai-images', params: { width: 0, height: 0, steps: 0, timeoutMs: 0 } })
  assert.equal(params.size, undefined)
  assert.equal(params.steps, undefined)
  // Generous on purpose: image models routinely take a minute or more, and a
  // premature deadline discards a generation the user already paid for.
  assert.equal(params.timeoutMs, 300000)
})

check('a custom protocol gets no parameter mapping', () => {
  const params = mapParams({ protocol: 'custom', params: { width: 800, height: 600, steps: 10, timeoutMs: 1000 } })
  assert.deepEqual(params, { timeoutMs: 1000 })
})

console.log(failures === 0 ? '\nall translation checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
