/**
 * Packaging self-test.
 *
 * Answers one question: would the published tarball work on its own? File presence
 * is not enough — a shipped file that imports a path left out of `files` fails only
 * after installation. So the file set is taken from `files` (what npm actually
 * packs), and every relative import must resolve to another file in that same set.
 *
 * Works on any package root: the source directory, or an extracted tarball.
 *
 * Usage: node checks/package.mjs [package-root]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'))
const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
const yaml = appRequire('js-yaml')

let failures = 0
/** Run one named case, recording failure instead of aborting the suite. */
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

const absolute = (relative) => path.join(root, relative)
const read = (relative) => fs.readFileSync(absolute(relative), 'utf8')
const exists = (relative) => fs.existsSync(absolute(relative))

const manifest = JSON.parse(fs.readFileSync(absolute('package.json'), 'utf8'))

/**
 * Expand one `files` entry against the package root.
 *
 * The entries this package declares are simple by design, so the supported shapes
 * are: an exact path, a directory, `dir/*.ext`, and `dir/**\/*.ext`.
 *
 * @param entry - one `files` pattern.
 * @returns the matching paths, relative to the root.
 */
function expand(entry) {
  const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '')
  if (!normalized.includes('*')) {
    if (!exists(normalized)) return []
    return fs.statSync(absolute(normalized)).isDirectory()
      ? fs.readdirSync(absolute(normalized), { recursive: true }).map((name) => `${normalized}/${String(name).replace(/\\/g, '/')}`).filter((name) => fs.statSync(absolute(name)).isFile())
      : [normalized]
  }
  const [prefix, tail] = normalized.split('**/')
  const extension = path.posix.extname(normalized)
  if (tail === undefined) {
    // `dir/*.ext`
    const dir = path.posix.dirname(normalized)
    if (!exists(dir)) return []
    return fs.readdirSync(absolute(dir)).filter((name) => name.endsWith(extension)).map((name) => `${dir}/${name}`)
  }
  // `dir/**/*.ext`: walk the prefix directory.
  const base = prefix.replace(/\/$/, '') === '' ? '.' : prefix.replace(/\/$/, '')
  if (!exists(base)) return []
  const walk = (dir) => {
    const out = []
    for (const entryDir of fs.readdirSync(absolute(dir), { withFileTypes: true })) {
      const relativePath = path.posix.join(dir.replace(/\\/g, '/'), entryDir.name)
      if (entryDir.isDirectory()) out.push(...walk(relativePath))
      else if (relativePath.endsWith(extension)) out.push(relativePath)
    }
    return out
  }
  return walk(base)
}

// npm always includes these regardless of `files`.
const ALWAYS = ['package.json', 'README.md']
const shipped = new Set([...ALWAYS, ...(manifest.files ?? []).flatMap(expand)])

console.log(`package root: ${root}`)
console.log(`would publish: ${String(shipped.size)} file(s)\n`)

// --------------------------------------------------------------- completeness

await check('every file the Host and client halves need is inside `files`', () => {
  const required = [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
    'src/intent.mjs',
    'src/params.mjs',
    'src/prompt.mjs',
    'src/adapters.mjs',
    'src/router.mjs',
    'src/generate.mjs',
    'src/resilience.mjs',
    'src/tool.mjs',
  ]
  const missingOnDisk = required.filter((relative) => !exists(relative))
  assert.deepEqual(missingOnDisk, [], `missing on disk: ${missingOnDisk.join(', ')}`)
  const notPacked = required.filter((relative) => !shipped.has(relative))
  assert.deepEqual(notPacked, [], `exists but would NOT be published: ${notPacked.join(', ')}`)
})

await check('every relative import resolves to another published file', () => {
  const broken = []
  for (const file of shipped) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue
    for (const [index, line] of read(file).split('\n').entries()) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      for (const match of line.matchAll(/(?:from\s+|import\s*\(\s*|\brequire\(\s*)['"](\.[^'"]+)['"]/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]))
        if (!shipped.has(target)) broken.push(`${file}:${String(index + 1)} → ${match[1]} (${exists(target) ? 'on disk but not published' : 'missing'})`)
      }
    }
  }
  assert.deepEqual(broken, [], broken.join('; '))
})

await check('no published file imports a package that only exists in the installation', () => {
  // Such an import makes the bundle unloadable inside a profile.
  const forbidden = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-client-ui-settings']
  const hits = []
  for (const file of shipped) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue
    const source = read(file)
    for (const name of forbidden) {
      // A complete specifier, so quoting it after `from` is exact.
      if (source.includes(`from '${name}'`) || source.includes(`from "${name}"`)) hits.push(`${file} → ${name}`)
    }
  }
  assert.deepEqual(hits, [], `forbidden imports: ${hits.join('; ')}`)
})

await check('every bare import is declared, a peer, or provider-supplied', () => {
  // Anything else would resolve only by luck inside someone's tree. `react` comes
  // from the page runtime named in `dsh.client.inject`, not from this package.
  const allowed = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    'react',
    'react-dom',
  ])
  const bare = new Map()
  for (const file of shipped) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue
    for (const [index, line] of read(file).split('\n').entries()) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      for (const match of line.matchAll(/((?:from\s+|import\s*\(\s*|\brequire\(\s*))['"]([^'"]+)['"]/g)) {
        const specifier = match[2]
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
        const parts = specifier.split('/')
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
        if (!bare.has(name)) bare.set(name, `${file}:${String(index + 1)}`)
      }
    }
  }
  const undeclared = [...bare].filter(([name]) => !allowed.has(name))
  assert.deepEqual(undeclared.map(([name, where]) => `${name} (${where})`), [], 'undeclared bare imports')
  console.log(`     bare imports: ${[...bare.keys()].sort().join(', ')}`)
})

await check('the declared exports and manifest fields point at published files', () => {
  assert.ok(Object.keys(manifest.exports ?? {}).length > 0, 'exports must be declared')
  for (const [name, target] of Object.entries(manifest.exports)) {
    const relative = target.replace(/^\.\//, '')
    if (relative.includes('*')) {
      assert.ok([...shipped].some((file) => file.startsWith(path.posix.dirname(relative))), `export ${name} matched nothing published`)
      continue
    }
    assert.ok(shipped.has(relative), `export ${name} → ${target} is not published`)
  }
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject ?? [], [
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-api-remotes',
  ])
})

// ------------------------------------------------------------------ loadability

await check('the Host half imports and its Config validates a full record', async () => {
  const host = await import(pathToFileURL(absolute('index.js')).href)
  assert.equal(typeof host.apply, 'function', 'apply must be exported')
  const validated = host.Config({
    imageModels: [
      {
        id: 'img-1',
        name: 'Packaged Model',
        protocol: 'openai-images',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'sk-secret-in-package',
        model: 'gpt-image-1',
        headers: [{ name: 'X-Test', value: '1' }],
        params: { width: 1344, height: 768 },
      },
    ],
  })
  // The volatile field validates into a live reference; unwrap it before reading.
  const section = JSON.parse(JSON.stringify(validated.imageModels.get()))
  assert.equal(section[0].name, 'Packaged Model')
  assert.equal(section[0].params.width, 1344)
  assert.equal(section[0].params.timeoutMs, 300000, 'schema defaults must travel with the package')
  assert.equal(validated.autoGenerate.get(), true)
})

await check('every src module imports on its own', async () => {
  for (const module of ['intent', 'params', 'prompt', 'adapters', 'router', 'generate', 'resilience', 'tool']) {
    const loaded = await import(pathToFileURL(absolute(`src/${module}.mjs`)).href)
    assert.ok(Object.keys(loaded).length > 0, `${module}.mjs exported nothing`)
  }
})

await check('the client bundle registers the settings slot', () => {
  let captured
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
  globalThis.document = { createElement: () => ({ style: {} }) }
  const localRequire = (name) => appRequire(name)
  try {
    // The bundle is plain script text, not an ES module.
    new Function('require', read('client.js'))(localRequire)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
  assert.notEqual(captured, undefined, 'the bundle did not call window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-image-studio')
  const exported = captured.factory(localRequire)
  assert.equal(typeof exported.apply, 'function', 'the client half must export apply')
})

await check('the locale files carry the plugin card title and description', () => {
  for (const locale of ['en', 'zh']) {
    const dict = JSON.parse(read(`locale/${locale}.json`))
    assert.equal(typeof dict.title, 'string', `${locale}.json has no title`)
    assert.ok(dict.title.length > 0)
    assert.equal(typeof dict.description, 'string', `${locale}.json has no description`)
  }
})

await check('the bundle patch inserts this plugin under its package name', () => {
  const patches = yaml.load(read('cordis.patch.yml'))
  assert.ok(Array.isArray(patches), 'the patch must be a list')
  const insert = patches.find((row) => Array.isArray(row?.insert))
  assert.notEqual(insert, undefined, 'the patch must carry an insert list')
  const row = insert.insert.find((candidate) => candidate.id === 'image-studio')
  assert.notEqual(row, undefined, 'the insert must name the image-studio row')
  assert.equal(row.name, 'dsh-image-studio', 'the row must resolve to this package')
})

console.log(failures === 0 ? '\nall packaging checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
