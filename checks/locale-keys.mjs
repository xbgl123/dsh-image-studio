/**
 * Check that every dictionary key the client's `tr(t, '…')` calls can resolve:
 * the English and Chinese sets must hold the same keys, and no literal key may be
 * missing from them. A typo here renders a raw key in the UI instead of copy,
 * which a syntax check cannot catch.
 *
 * Run: node checks/locale-keys.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'client.js'), 'utf8')

const objectBody = (name) => {
  const start = source.indexOf(`const ${name} = {`)
  assert.notEqual(start, -1, `${name} object not found`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  throw new Error(`${name} object is unbalanced`)
}

const keysOf = (body) => new Set([...body.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]))

const en = keysOf(objectBody('en'))
const zh = keysOf(objectBody('zh'))

const missingInZh = [...en].filter((key) => !zh.has(key))
const missingInEn = [...zh].filter((key) => !en.has(key))
assert.deepEqual(missingInZh, [], `keys missing from zh: ${missingInZh.join(', ')}`)
assert.deepEqual(missingInEn, [], `keys missing from en: ${missingInEn.join(', ')}`)

// Every literal key named in a `tr(t, '...')` call.
const used = new Set([...source.matchAll(/tr\(t, '([A-Za-z][A-Za-z0-9]*)'/g)].map((match) => match[1]))
// The ternary forms `tr(t, cond ? 'a' : 'b')` and the label maps.
for (const match of source.matchAll(/tr\(t, [^)]*\? '([A-Za-z]+)' : '([A-Za-z]+)'\)/g)) {
  used.add(match[1])
  used.add(match[2])
}
for (const [key, value] of source.matchAll(/^\s+([a-z-]+): '([a-zA-Z]+)',$/gm)) {
  if (/^[a-z][a-z-]*$/.test(key) && en.has(value)) used.add(value)
}
for (const match of source.matchAll(/PROTOCOL_LABEL\[[^\]]+\] \?\? '([A-Za-z]+)'/g)) used.add(match[1])

const unknown = [...used].filter((key) => !en.has(key)).sort()
assert.deepEqual(unknown, [], `keys used but not defined: ${unknown.join(', ')}`)

console.log(`ok   ${String(en.size)} keys in both dictionaries`)
console.log(`ok   ${String(used.size)} literal keys used by the view all resolve`)
