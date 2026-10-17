/**
 * Detection rules: what counts as an image request, and what must not.
 *
 * Run: node checks/intent.mjs
 */
import assert from 'node:assert/strict'

import { detectImageIntent, isOptimizedPrompt } from '../src/intent.mjs'

let checks = 0
let failures = 0
/** Assert one detection outcome. */
function check(text, wanted, note, options) {
  checks += 1
  const result = detectImageIntent(text, options)
  if (result.wanted !== wanted) {
    failures += 1
    console.log(`FAIL ${JSON.stringify(text)} -> wanted=${String(wanted)} got=${String(result.wanted)} (${result.reason})`)
    return
  }
  if (note !== undefined && result.reason !== note) {
    failures += 1
    console.log(`FAIL ${JSON.stringify(text)} -> reason wanted=${note} got=${result.reason}`)
  }
}

// ------------------------------------------------------------- must be a request

check('帮我生成一张猫咪的图片', true, 'imperative')
check('生成图片：一只在雨中的猫', true, 'imperative')
check('画一张赛博朋克风格的城市夜景', true, 'imperative')
check('帮我画一只穿西装的柴犬', true, 'imperative')
check('给我画个 logo，简洁一点', true, 'imperative')
check('作图：一张产品宣传海报', true, 'imperative')
check('绘制一幅水墨山水插画', true, 'imperative')
check('做一张图，背景是星空', true, 'imperative')
check('设计一张海报，主题是环保', true, 'imperative')
check('把这段描述变成图片', true, 'verb+noun')
check('我想要一张日落海滩的图片', true, 'want')
check('给我来一张小猫的照片', true, 'want')
check('请生成这个场景的配图', true, 'imperative')
check('generate an image of a cat in the rain', true, 'imperative')
check('draw me a cyberpunk city at night', true, 'imperative')
check('create a picture of a robot reading a book', true, 'imperative')
check('i want an image of a mountain at sunrise', true, 'want')
check('illustrate a diagram of the auth flow', true, 'imperative')
check('make a picture of a blue circle', true, 'imperative')
// Verb plus noun, phrased in a way no phrase list enumerates.
check('用这个数据生成一张趋势示意图', true, 'verb+noun')
check('根据需求画个流程图', true, 'imperative')

// -------------------------------------------------- must NOT be a request

check('', false, 'empty')
check('这段代码为什么报错？', false, 'no-signal')
check('帮我把图片上传功能写完', false, 'no-signal')
check('图片格式有哪些？', false, 'capability-question')
check('这张图里有什么？', false, 'no-signal')
check('你能生成图片吗', false, 'capability-question')
check('能不能画图', false, 'capability-question')
check('do you support image generation', false, 'capability-question')
check('can you generate images', false, 'capability-question')
check('不要画图，只给我文字描述', false, 'negated')
check("don't draw anything, just describe it", false, 'negated')
check('画图功能怎么配置？', false, 'capability-question')

// A picture mentioned without any production verb is not a request.
check('我看到一张很漂亮的图片', false, 'no-signal')
check('the image failed to load', false, 'no-signal')

// ------------------------------------------------------------------- hint path

check('anything at all', true, 'hint', { hint: true })
check('', true, 'hint', { hint: true })

// ------------------------------------------------------- optimized-prompt rule

assert.equal(isOptimizedPrompt('skill', undefined), true, 'a skill source is optimized by default')
assert.equal(isOptimizedPrompt('user', undefined), false, 'a user source is not optimized')
assert.equal(isOptimizedPrompt('user', true), true, 'an explicit flag forces optimized')
assert.equal(isOptimizedPrompt('skill', false), false, 'an explicit false overrides the skill default')
assert.equal(isOptimizedPrompt('agent', undefined), false, 'an agent source is not optimized')

console.log(failures === 0 ? `ok   ${String(checks)} detection cases` : `${String(failures)} of ${String(checks)} detection cases failed`)
process.exitCode = failures === 0 ? 0 : 1
