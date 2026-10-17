/**
 * Parameter extraction and normalization.
 *
 * The governing rule is that extraction must never damage the prompt: reading
 * "16:9" out of a sentence may remove the digits, but it must not remove the words
 * that tell the model what to draw, and it must not leave punctuation debris behind.
 *
 * Run: node checks/params.mjs
 */
import assert from 'node:assert/strict'

import { extractParameters, ratioOf, resolveParameters, sizeFromRatio } from '../src/params.mjs'

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

const stored = { width: 1024, height: 1024 }
/** Parse and resolve in one step, the way the scheduler does. */
const parse = (text, explicit = {}) => resolveParameters(explicit, extractParameters(text, stored), stored)

check('an explicit pixel pair sets the size and leaves the words alone', () => {
  const result = parse('draw a cat at 1024x768 in a garden')
  assert.equal(result.width, 1024)
  assert.equal(result.height, 768)
  assert.equal(result.ratio, '4:3')
})

check('a ratio word resolves around the stored area and stays in the prompt', () => {
  const extracted = extractParameters('画一张 16:9 的横版插画，两只猫在窗台上', stored)
  const result = resolveParameters({}, extracted, stored)
  assert.equal(result.ratio, '16:9')
  assert.equal(result.width, 1344)
  assert.equal(result.height, 768)
  // The descriptive word must survive: it tells the model the same thing.
  assert.match(extracted.prompt, /横版插画/)
  assert.match(extracted.prompt, /两只猫在窗台上/)
  assert.doesNotMatch(extracted.prompt, /16:9/, 'the digits themselves are plumbing')
})

check('a consumed token leaves no debris', () => {
  for (const text of [
    '画一张 16:9 的横版插画，两只猫在窗台上，不要模糊',
    '生成 2 张图，1:1，水彩风格，不要文字',
    'draw 3 images of a cat, 1024x768, avoid blur',
  ]) {
    const { prompt } = extractParameters(text, stored)
    assert.doesNotMatch(prompt, /\s{2,}/, `double space in ${JSON.stringify(prompt)}`)
    assert.doesNotMatch(prompt, /[，,]\s*[，,]/, `doubled separator in ${JSON.stringify(prompt)}`)
    assert.doesNotMatch(prompt, /^\s*[的,，.]/, `leading debris in ${JSON.stringify(prompt)}`)
    assert.doesNotMatch(prompt, /[的s]\s*$/, `trailing debris in ${JSON.stringify(prompt)}`)
  }
})

check('a style word stays in the prompt and is reported separately', () => {
  const extracted = extractParameters('生成一张方图，油画风格', stored)
  assert.match(extracted.prompt, /油画风格/, 'removing the style word would ask for a different picture')
  assert.equal(extracted.style, 'oil painting')
  const notes = resolveParameters({}, extracted, stored).notes
  assert.ok(notes.some((note) => note.includes('style')), 'the style decision must be reported')
})

check('a negative clause moves to its own field', () => {
  const result = parse('竖版海报，极简风格，负面词：杂乱, 文字')
  assert.equal(result.negative, '杂乱, 文字')
  assert.equal(result.ratio, '9:16')
})

check('an English negative lead is recognised', () => {
  assert.equal(parse('draw 3 images of a cat, 1024x768, avoid blur').negative, 'blur')
})

check('counts are read from both languages and clamped', () => {
  assert.equal(parse('生成 2 张图，1:1').count, 2)
  assert.equal(parse('draw 3 images of a cat').count, 3)
  const many = resolveParameters({ count: 99 }, { count: 99 }, stored)
  assert.equal(many.count, 99, 'resolution preserves the value; clamping is the caller\'s step')
})

check('an explicit caller value wins over the text', () => {
  const result = resolveParameters({ width: 512, height: 512, count: 1 }, extractParameters('16:9, 3 张图', stored), stored)
  assert.equal(result.width, 512)
  assert.equal(result.height, 512)
  assert.equal(result.count, 1)
})

check('a caller ratio resolves when no size is given', () => {
  const result = resolveParameters({ ratio: '9:16' }, extractParameters('a cat', stored), stored)
  assert.equal(result.ratio, '9:16')
  assert.equal(result.width, 768)
  assert.equal(result.height, 1344)
})

check('text with no parameters is returned untouched', () => {
  const text = '一只猫坐在窗台上。暖色的夕阳'
  const extracted = extractParameters(text, stored)
  assert.equal(extracted.prompt, text)
  assert.deepEqual(extracted.matched, [])
})

check('text that is only parameters falls back to the original', () => {
  const extracted = extractParameters('1024x1024', stored)
  assert.equal(extracted.prompt, '1024x1024', 'an empty prompt would be rejected by every protocol')
  assert.ok(extracted.notes.some((note) => note.includes('original text is sent')), 'the fallback must be reported')
})

check('ratio maths snaps to sensible defaults', () => {
  assert.deepEqual(sizeFromRatio('1:1', 1024, 1024), { width: 1024, height: 1024 })
  assert.equal(ratioOf(1024, 1024), '1:1')
  assert.equal(ratioOf(1920, 1080), '16:9')
  // 1000x1050 is 0.95, which is not within tolerance of any named ratio.
  assert.equal(ratioOf(1000, 1050), undefined, 'a near-square is not a named ratio')
})

check('an odd ratio is reported but still usable', () => {
  const extracted = extractParameters('画一张 7:5 的图', stored)
  assert.equal(extracted.ratio, '7:5')
  assert.ok(extracted.notes.some((note) => note.includes('7:5')), 'the unusual ratio must be reported')
})

check('a full-width colon is accepted', () => {
  const extracted = extractParameters('画一张 16：9 的图', stored)
  assert.equal(extracted.ratio, '16:9')
})

console.log(failures === 0 ? '\nall parameter checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
