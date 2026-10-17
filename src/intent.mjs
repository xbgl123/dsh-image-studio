/**
 * Image-request detection: does this text ask for a picture to be produced?
 *
 * Detection runs on three text sources — the user's own words, a tool call the
 * model issued, and a skill's instruction — and answers with the reason it
 * fired, so the caller can log or explain a decision instead of guessing.
 *
 * The rules are deliberately conservative in one direction: a *question about*
 * image generation ("can you generate images?") is not a request. Only an
 * imperative or a stated want counts, because a false positive spends the user's
 * money on an API call while a false negative costs one more sentence.
 */

/** Ways a request can be phrased, strongest first. */
const IMPERATIVE = [
  // Simplified Chinese
  '生成图片', '生成一张图', '生成图像', '生成插画', '生成海报', '生成示意图', '生成配图', '生成封面',
  '画一张', '画个', '画一个', '画幅', '画张', '画一下', '帮我画', '请画', '给我画', '给我生成', '帮我生成',
  '再画', '继续画', '再生成', '再来一张', '换一张',
  '作图', '绘图', '绘制', '配图', '出图', '做一张图', '做张图', '来一张图', '来张图', '做个封面', '设计一张海报',
  // English
  'generate an image', 'generate a picture', 'generate image', 'generate a photo',
  'create an image', 'create a picture', 'draw me', 'draw a', 'draw an', 'paint a', 'paint an',
  'make an image', 'make a picture', 'render an image', 'illustrate', 'produce an image',
]

/** Soft wants: weaker than an imperative, but still a request for output. */
const WANT = [
  '我想要一张', '我想要个', '我需要一张', '给我来一张', '帮我出', '想要一张图', '要一张图', '需要一张图',
  'i want an image', 'i want a picture', 'i need an image', 'i need a picture', 'i would like an image',
]

/** Nouns that make a bare verb about pictures. */
const IMAGE_NOUNS = [
  '图片', '图像', '插画', '海报', '示意图', '配图', '封面', '照片', '画作', '图标', 'logo', '壁纸', '头像', '表情包', '漫画',
  'image', 'picture', 'illustration', 'poster', 'diagram', 'photo', 'wallpaper', 'avatar', 'icon', 'logo', 'artwork', 'comic',
]

/** Verbs that produce a picture; a noun does not make a request on its own. */
const IMAGE_VERBS = [
  '生成', '画', '绘制', '作图', '绘图', '设计', '制作', '创建', '出图', '渲染',
  'generate', 'draw', 'paint', 'render', 'create', 'make', 'design', 'produce', 'illustrate',
]

/**
 * Interrogative words and capacity auxiliaries. A question about the feature
 * needs one of these; a bare question mark proves nothing in Chinese, where
 * "生成图片？" is a terse request and "图片格式有哪些？" is a question.
 */
const QUESTION_MARKERS = [
  '能不能', '可不可以', '可以吗', '行不行', '会不会', '支持吗', '支持不支持', '是否',
  '吗', '呢', '怎么', '如何', '为什么', '什么', '哪些', '哪个',
  'can you', 'could you', 'are you able', 'do you support', 'is it possible', 'would you be able',
  'how do', 'how can', 'how to', 'what is', 'which', 'where',
]

/** Topics whose mention turns a verb into a question about a feature. */
const FEATURE_NOUNS = ['功能', '能力', 'feature', 'capability', 'support']

/** Verbs that mean "produce a picture", including the "turn it into" phrasings. */
const PRODUCE_VERBS = [
  '生成', '画', '绘制', '作图', '绘图', '出图', '渲染', '变成', '转为', '转成', '做成',
  'generate', 'draw', 'paint', 'render', 'illustrate', 'turn into', 'convert into', 'turn this into',
]

/** Explicit negative: the user is telling the agent not to draw. */
const NEGATIONS = ['不要画', '别画', '不用画', '别生成', '不要生成', "don't draw", 'do not draw', 'no image', '不要图']

/**
 * Normalize text for matching: lowercase, collapse whitespace, keep CJK intact.
 * @param text - raw text.
 */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether `text` contains `needle` (both assumed normalized). */
function has(text, needle) {
  return text.includes(needle)
}

/**
 * Whether the text asks *about* image generation rather than requesting it.
 *
 * A question must be about this feature (an image noun or a feature word) **and**
 * carry a question word or a capacity auxiliary. Both halves matter: "不要画图"
 * is about the feature but is not a question, "这段代码为什么报错" is a question but
 * is not about drawing, and "生成图片：" has neither and stays a request.
 *
 * A bare question mark proves nothing in Chinese — "图片格式有哪些？" is a question
 * while "生成图片？" is a terse request — so it is not used as the signal.
 *
 * @param text - normalized text.
 */
function asksAboutImageCapability(text) {
  const aboutFeature =
    IMAGE_NOUNS.some((noun) => text.includes(noun)) ||
    FEATURE_NOUNS.some((noun) => text.includes(noun)) ||
    PRODUCE_VERBS.some((verb) => text.includes(verb))
  if (!aboutFeature) return false
  return QUESTION_MARKERS.some((marker) => text.includes(marker))
}

/**
 * Detect an image-generation request.
 *
 * @param input - the text under inspection.
 * @param options - `source` marks where the text came from; `hint` is trusted
 *   metadata that already decided (a tool call, a skill's own flag).
 * @returns `{ wanted, strength, reason, matches }`; `strength` is `'explicit'`
 *   for an imperative, `'soft'` for a stated want, and `'none'` otherwise.
 */
export function detectImageIntent(input, options = {}) {
  const text = normalize(input)
  const matches = []

  // A tool call or a skill flag is a decision, not a sentence to parse.
  if (options.hint === true) {
    return { wanted: true, strength: 'explicit', reason: 'hint', matches: [] }
  }
  if (text.length === 0) {
    return { wanted: false, strength: 'none', reason: 'empty', matches: [] }
  }

  for (const phrase of NEGATIONS) {
    if (has(text, phrase)) {
      return { wanted: false, strength: 'none', reason: 'negated', matches: [phrase] }
    }
  }

  if (asksAboutImageCapability(text)) {
    return { wanted: false, strength: 'none', reason: 'capability-question', matches: [] }
  }

  for (const phrase of IMPERATIVE) {
    if (has(text, phrase)) matches.push(phrase)
  }
  if (matches.length > 0) {
    return { wanted: true, strength: 'explicit', reason: 'imperative', matches }
  }

  for (const phrase of WANT) {
    if (has(text, phrase)) matches.push(phrase)
  }
  if (matches.length > 0) {
    return { wanted: true, strength: 'soft', reason: 'want', matches }
  }

  // A production verb plus an image noun, in either order. This is what catches
  // phrasing no phrase list enumerates ("把这段描述变成图片") without firing on any
  // bare mention of a picture ("我看到一张很漂亮的图片").
  const producer = PRODUCE_VERBS.find((candidate) => has(text, candidate))
  const noun = IMAGE_NOUNS.find((candidate) => has(text, candidate))
  if (producer !== undefined && noun !== undefined) {
    return { wanted: true, strength: 'soft', reason: 'verb+noun', matches: [producer, noun] }
  }

  return { wanted: false, strength: 'none', reason: 'no-signal', matches: [] }
}

/**
 * Mark a request as already optimized by its author.
 *
 * A prompt that arrived from a skill (or that the caller flagged) is treated as
 * final: the plugin's default-word completion and style enhancement stay off, so
 * the skill's own prompt reaches the model verbatim.
 *
 * @param source - provenance of the prompt.
 * @param flagged - explicit caller override, `true` forces optimized.
 * @returns whether enhancement must be suppressed.
 */
export function isOptimizedPrompt(source, flagged) {
  if (flagged === true) return true
  if (flagged === false) return false
  return source === 'skill'
}
