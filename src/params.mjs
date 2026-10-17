/**
 * Parameter extraction and normalization.
 *
 * A user writes "画一张 16:9 的横版插画，两只猫，不要模糊，油画风格" and the
 * provider wants `size: "1344x768"`. A skill emits a structured prompt and the
 * provider wants fields beside it. This module turns whatever was said into the
 * fields the adapters send, and reports every decision so the result can name what
 * it used.
 *
 * Two rules keep it honest:
 *
 * - **Explicit wins.** A value the caller passed directly (a tool argument a skill
 *   set) is never overridden by text parsing.
 * - **Parsed text is removed from the prompt.** "16:9" and "两只" are instructions
 *   about the request, not content for the picture, so the spans that produced a
 *   field are stripped out of the prompt body before it is sent.
 *
 * Anything this module cannot map to a field the target protocol actually accepts
 * is reported as an advisory, never invented into a request field.
 */

/** Named aspect ratios, as `width:height`. */
const RATIOS = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '21:9': 21 / 9,
}

/** How a ratio is spelled in either language, mapped to the canonical pair. */
const RATIO_WORDS = [
  { pattern: /\b(\d{1,2})\s*[:：]\s*(\d{1,2})\b/, pair: (m) => `${m[1]}:${m[2]}` },
  { pattern: /(横版|横向|风景|landscape)/i, pair: () => '16:9' },
  { pattern: /(竖版|竖向|纵向|portrait)/i, pair: () => '9:16' },
  { pattern: /(方图|正方形|方形|square)/i, pair: () => '1:1' },
]

/** Named pixel sizes, in either language. */
const SIZE_WORDS = [
  { pattern: /\b(1024\s*[x×*]\s*1024)\b/i, width: 1024, height: 1024 },
  { pattern: /\b(1344\s*[x×*]\s*768)\b/i, width: 1344, height: 768 },
  { pattern: /\b(768\s*[x×*]\s*1344)\b/i, width: 768, height: 1344 },
  { pattern: /\b(1920\s*[x×*]\s*1080)\b/i, width: 1920, height: 1080 },
  { pattern: /\b(\d{3,4})\s*[x×*]\s*(\d{3,4})\b/i, width: null, height: null, pair: true },
]

/** Counts, in either language. A leading space is part of the span so none is stranded. */
const COUNT_WORDS = [
  { pattern: /\s?(\d+)\s*(?:张|幅|个)/ },
  { pattern: /\s?(\d+)\s*(?:picture|pictures|image|images|variations|versions)\b/i },
  { pattern: /\s?(two|three|four)\s*(?:images|pictures|variations)\b/i },
]

/** Words whose presence is a style request. */
const STYLE_WORDS = [
  { pattern: /(油画|oil painting)/i, style: 'oil painting' },
  { pattern: /(水彩|watercolor|water colour)/i, style: 'watercolor' },
  { pattern: /(水墨|ink wash|ink painting)/i, style: 'ink wash painting' },
  { pattern: /(素描|线稿|sketch|line art)/i, style: 'sketch' },
  { pattern: /(动漫|二次元|anime|manga)/i, style: 'anime' },
  { pattern: /(写实|照片写实|photorealistic|photo[- ]real)/i, style: 'photorealistic' },
  { pattern: /(3[dD]|三维)/, style: '3d render' },
  { pattern: /(像素|pixel art)/i, style: 'pixel art' },
  { pattern: /(扁平|flat design)/i, style: 'flat design' },
  { pattern: /(赛博朋克|cyberpunk)/i, style: 'cyberpunk' },
  { pattern: /(极简|minimalist)/i, style: 'minimalist' },
  { pattern: /(国风|中国风|chinese style)/i, style: 'chinese style' },
]

/** Phrases that introduce a negative prompt. */
const NEGATIVE_LEADS = [
  /(?:负面(?:默认)?词?|负向提示词?|不要|别|避免|排除|去掉)\s*[：:]?\s*([^。；;.!?？\n]+)/,
  /(?:negative prompt|without|avoid|no)\s*[：:]?\s*([^.;!?\n]+)/i,
]

/** Words that mean "no style constraint"; they are stripped, not mapped. */
const NEUTRAL_STYLE = /(不限风格|风格不限|任意风格|any style|no particular style)/i

/**
 * Remove the spans a match consumed, then tidy what they leave behind.
 *
 * A consumed token can strand a particle or a separator: removing "16:9" from
 * "16:9 的横版插画" leaves " 的横版插画", and removing a phrase from between two
 * commas leaves "，，". Both are repaired here so the prompt reads as intended.
 *
 * @param text - the prompt body.
 * @param spans - `{ start, end }` ranges to remove.
 */
function stripSpans(text, spans) {
  if (spans.length === 0) return text
  const ordered = [...spans].sort((left, right) => left.start - right.start)
  let result = ''
  let cursor = 0
  for (const span of ordered) {
    if (span.start < cursor) continue
    result += text.slice(cursor, span.start)
    cursor = span.end
  }
  result += text.slice(cursor)
  return result
    .replace(/\s+([，,、。；;.!?？])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*[，,、]\s*(?=[，,、])/g, '')
    .replace(/^[\s，,、；;:：.。、]+|[\s，,、；;:：]+$/g, '')
    // Stranded particles and articles left by a removed token.
    .replace(/^的\s*/, '')
    // A stranded "的" is only the particle: it may follow a space or a separator,
    // and must not be followed by a word character — or "3 images" would repair
    // into "s".
    .replace(/(?:^|[\s，,、])的(?=[，,、\s]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** The pixel size a ratio implies, snapped onto a multiple of 64 around the model's area. */
export function sizeFromRatio(ratio, width, height) {
  const parts = String(ratio).split(':')
  const numeric = Number(parts[0]) / Number(parts[1])
  const target = Number.isFinite(numeric) && numeric > 0 ? numeric : RATIOS['1:1']
  const area = Math.max(1, (Number(width) || 1024) * (Number(height) || 1024))
  const snap = (value) => Math.max(64, Math.round(value / 64) * 64)
  const computedWidth = snap(Math.sqrt(area * target))
  const computedHeight = snap(Math.sqrt(area / target))
  return { width: computedWidth, height: computedHeight }
}

/** The nearest named ratio for a pixel pair, or undefined when nothing is close. */
export function ratioOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const target = width / height
  let best
  for (const [name, value] of Object.entries(RATIOS)) {
    const distance = Math.abs(value - target)
    if (best === undefined || distance < best.distance) best = { name, distance }
  }
  return best !== undefined && best.distance < 0.02 ? best.name : undefined
}

/**
 * Parse generation parameters out of one instruction text.
 *
 * Extraction must never *damage* the prompt. Only spans that are pure request
 * plumbing are removed:
 *
 * - an explicit pixel pair (`1024x768`) — the numbers are not content;
 * - a negative-prompt clause — it moves to its own field;
 * - a stray "风格/不限风格" left behind by a removed style word.
 *
 * Descriptive words stay: "横版" is read as the 16:9 ratio **and** kept, because it
 * tells the model the same thing; a style word stays because the provider may have
 * no style field at all, and deleting "油画" from "油画风格" would ask for a *worse*
 * picture than the user requested. The detected style is reported as metadata for
 * traceability, and only removed if a caller asks for that explicitly.
 *
 * @param text - the user instruction, intent sentence, or skill output.
 * @param options - `{ width, height }` supply the model's stored size, used as the
 *   area a ratio is resolved around; `consumeStyle: true` removes style words.
 * @returns `{ prompt, width?, height?, ratio?, count?, style?, negative?, notes, matched }`.
 */
export function extractParameters(text, options = {}) {
  const original = String(text ?? '')
  const spans = []
  const notes = []
  const matched = []
  let width
  let height
  let ratio
  let count
  let style
  let negative

  const consume = (match) => {
    spans.push({ start: match.index, end: match.index + match[0].length })
    matched.push(match[0].trim())
  }

  // An explicit pixel pair wins the size decision, so it is read first.
  for (const rule of SIZE_WORDS) {
    const match = rule.pattern.exec(original)
    if (match === null) continue
    if (rule.pair === true) {
      width = Number(match[1])
      height = Number(match[2])
    } else {
      width = rule.width
      height = rule.height
    }
    ratio = ratioOf(width, height)
    // The digits are plumbing; the descriptive word beside them is not.
    consume(match)
    break
  }

  if (width === undefined) {
    for (const rule of RATIO_WORDS) {
      const match = rule.pattern.exec(original)
      if (match === null) continue
      const pair = rule.pair(match)
      ratio = pair
      if (!Object.hasOwn(RATIOS, pair)) {
        notes.push(`aspect ratio "${pair}" is not a named ratio; using it as written`)
      }
      const resolved = sizeFromRatio(ratio, options.width, options.height)
      width = resolved.width
      height = resolved.height
      // A bare `16:9` token is consumed with the particle it may lead into, so the
      // prompt does not keep a stranded "的"; a word like "横版" stays in the prompt.
      if (/^\s*\d/.test(match[0])) {
        const start = match.index + (match[0].length - match[0].trimStart().length)
        const tail = /^\s*的/.exec(original.slice(start + match[0].trimStart().length))
        const end = start + match[0].trimStart().length + (tail === null ? 0 : tail[0].length)
        spans.push({ start, end })
        matched.push(match[0].trim())
      }
      break
    }
  }

  for (const rule of COUNT_WORDS) {
    const match = rule.pattern.exec(original)
    if (match === null) continue
    const digits = String(match[1] ?? '').trim()
    const words = { two: 2, three: 3, four: 4 }
    const value = Number.isFinite(Number(digits)) ? Number(digits) : words[digits.toLowerCase()]
    if (Number.isFinite(value) && value > 0) {
      count = Math.min(4, Math.trunc(value))
      // The match starts at the digit, so the whole span is the count and its unit.
      spans.push({ start: match.index, end: match.index + match[0].length })
      matched.push(match[0].trim())
      break
    }
  }

  for (const rule of STYLE_WORDS) {
    const match = rule.pattern.exec(original)
    if (match === null) continue
    style = rule.style
    matched.push(match[0].trim())
    if (options.consumeStyle === true) consume(match)
    break
  }

  const neutral = NEUTRAL_STYLE.exec(original)
  if (neutral !== null) consume(neutral)

  for (const lead of NEGATIVE_LEADS) {
    const match = lead.exec(original)
    if (match === null) continue
    const captured = String(match[1] ?? '').trim()
    if (captured.length === 0) continue
    negative = captured.replace(/[，,、；;]+$/, '').trim()
    consume(match)
    break
  }

  let prompt = stripSpans(original, spans)
  // A removed style word can leave a dangling "风格"/"style"; tidy it away.
  if (style !== undefined && options.consumeStyle === true) {
    prompt = prompt.replace(/\s*(?:风格|style)\s*$/i, '').replace(/[，,、]\s*(?=[，,、]|$)/g, '').trim()
  }
  if (prompt.replace(/[\s，,、。.!?？；;:：]/g, '').length === 0) {
    // Everything was plumbing: fall back to the original text rather than sending
    // an empty prompt, which every protocol would reject.
    notes.push('every requested parameter was parsed out of the text, so the original text is sent as the prompt')
    prompt = original.trim()
  }

  return {
    prompt,
    width,
    height,
    ratio,
    count,
    style,
    negative,
    notes,
    matched,
  }
}

/**
 * Combine parsed parameters with explicit arguments, explicit first.
 *
 * A caller-supplied ratio is resolved *before* any pixel fallback is considered:
 * otherwise the model's stored size (a fallback) would win over an explicit ratio
 * and silently ignore what was asked for.
 *
 * @param explicit - values the caller passed (tool arguments, skill output).
 * @param parsed - values read out of the text.
 * @param fallback - the model's stored defaults.
 * @returns `{ width?, height?, ratio?, count?, style?, negative?, notes }`.
 */
export function resolveParameters(explicit = {}, parsed = {}, fallback = {}) {
  const notes = [...(parsed.notes ?? [])]
  const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')

  const explicitRatio = typeof explicit.ratio === 'string' && explicit.ratio.length > 0 ? explicit.ratio : undefined
  const explicitSize = Number.isFinite(explicit.width) && Number.isFinite(explicit.height)

  // Explicit size, then an explicit ratio, then whatever the text said, then the
  // model's stored size.
  let width = explicitSize ? explicit.width : pick(parsed.width, fallback.width)
  let height = explicitSize ? explicit.height : pick(parsed.height, fallback.height)
  let ratio = pick(explicitRatio, parsed.ratio)

  if (!explicitSize && explicitRatio !== undefined) {
    const resolved = sizeFromRatio(explicitRatio, fallback.width ?? 1024, fallback.height ?? 1024)
    width = resolved.width
    height = resolved.height
  } else if (ratio === undefined) {
    ratio = ratioOf(width, height)
  }

  const count = pick(explicit.count, parsed.count, fallback.count, 1)
  const negative = pick(explicit.negative, parsed.negative, fallback.negative)
  const style = pick(explicit.style, parsed.style)

  if (style !== undefined) {
    // No protocol this stage speaks accepts a style field, so the style is a
    // prompt-level hint. Saying so is the honest alternative to inventing a field.
    notes.push(`style "${style}" is carried as a prompt hint: none of the supported protocols declares a style field`)
  }
  return { width, height, ratio, count, style, negative, notes }
}
