/**
 * Render the client bundle's section offline, through the same seams the page
 * uses: `window.__ModuleLoader__.load({ id, factory })` is captured, `require` is
 * answered locally, and the injected slot props are faked. React itself comes
 * from the DSH installation (the page's own runtime), and the element tree is
 * walked directly — no `react-dom`, which the deployment does not ship.
 *
 * Run: node checks/render-section.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')
const require = createRequire(import.meta.url)

/** Resolve a package this bundle needs from the DSH installation. */
function fromInstallation(specifier) {
  const appRequire = createRequire(path.join('E:', 'DSH Desktop', 'resources', 'app', 'package.json'))
  return appRequire(specifier)
}

const React = fromInstallation('react')

// ---------------------------------------------------------------- fake React

const dispatcher = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useContext: () => undefined,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useLayoutEffect: () => {},
  useReducer: (reducer, initial) => [initial, () => {}],
  useDebugValue: () => {},
  useId: () => 'test-id',
  useTransition: () => [false, (callback) => callback()],
  useDeferredValue: (value) => value,
  useImperativeHandle: () => {},
  useInsertionEffect: () => {},
}

/** Run one render of a function component with React's dispatcher installed. */
function renderComponent(component, props) {
  const previous = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher
  try {
    return component(props)
  } finally {
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = previous
  }
}

/** Flatten an element tree into `{ type, props }` records and its text. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) })
    return
  }
  if (typeof node.type === 'function') {
    // A component child: render it with the same fake dispatcher.
    walk(renderComponent(node.type, node.props ?? {}), visit)
    return
  }
  visit({ type: node.type, props: node.props ?? {} })
  walk(node.props?.children, visit)
}

const treeOf = (element) => {
  const nodes = []
  walk(element, (record) => nodes.push(record))
  return {
    nodes,
    text: nodes.filter((record) => record.text !== undefined).map((record) => record.text).join(' '),
    hasClass: (name) => nodes.some((record) => typeof record.props?.className === 'string' && record.props.className.split(' ').includes(name)),
    find: (predicate) => nodes.find(predicate),
  }
}

// ------------------------------------------------------------- load the bundle

function loadPlugin() {
  let captured
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        captured = registration
      },
    },
  }
  const localRequire = (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  }
  try {
    // The bundle is plain script text, not an ES module: evaluate it directly.
    new Function('require', fs.readFileSync(path.join(moduleDir, 'client.js'), 'utf8'))(localRequire)
  } finally {
    globalThis.window = previousWindow
  }
  assert.notEqual(captured, undefined, 'the bundle did not call window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-image-studio')
  return captured.factory(localRequire)
}

// --------------------------------------------------------------- fake context

function fakeContext() {
  const registrations = []
  const dictionaries = new Map()
  const scopeState = {
    status: 'ready',
    value: { imageModels: [] },
    base: undefined,
    user: undefined,
    revision: 3,
    writable: true,
    mode: 'host',
    secrets: [],
  }
  const listeners = new Set()
  const scope = {
    getSnapshot: () => scopeState,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: () => Promise.resolve(true),
  }
  /** Move the controller's snapshot and notify, exactly like a Host answer does. */
  const updateScope = (patch) => {
    Object.assign(scopeState, patch)
    for (const listener of [...listeners]) listener()
  }
  const ctx = {
    locale: {
      bind: (ns) => (key, params) => {
        const dict = dictionaries.get(ns)
        const value = dict === undefined ? undefined : dict[key]
        if (typeof value !== 'string') return key
        return params === undefined
          ? value
          : value.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
      },
      register: (ns, dicts) => {
        dictionaries.set(ns, dicts.zh ?? dicts.en)
        return () => dictionaries.delete(ns)
      },
    },
    // The real services split these faces: the per-namespace controller snapshot
    // carries no `secrets` field, while the describe mirror's namespace view does.
    configForms: {
      get: () => scope,
      describe: () => ({
        load: () => Promise.resolve(),
        subscribe: () => () => {},
        getSnapshot: () => ({
          status: 'ready',
          view: {
            writable: scopeState.writable,
            namespaces: [{ ns: 'image-studio', value: scopeState.value, revision: scopeState.revision, secrets: scopeState.secrets ?? [] }],
          },
        }),
      }),
    },
    get: () => undefined,
    effect: (callback) => {
      const disposer = callback()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, updateScope }
}

// --------------------------------------------------------------------- checks

const plugin = loadPlugin()
assert.deepEqual([...plugin.inject].sort(), ['configForms', 'locale', 'remote.settings', 'slots'].sort())

const { ctx, registrations, updateScope } = fakeContext()
plugin.apply(ctx)

assert.equal(registrations.length, 1, `expected exactly one slot registration, got ${String(registrations.length)}`)
const { options, component } = registrations[0]
assert.equal(options.name, 'settings.models.footer')
assert.equal(options.id, 'image-models')
assert.equal(options.locale, 'image-studio')

const injected = options.inject()
const useSnapshot = (selector) => selector(injected.hooks.snapshot.getSnapshot())
const t = ctx.locale.bind('image-studio')
/**
 * Render one state the way the page does: the controller's snapshot changes, the
 * plugin's subscription publishes the card state, then the component renders.
 */
const render = (state) => {
  updateScope(state)
  return treeOf(renderComponent(component, { useSnapshot, operations: injected.operations, t }))
}

const empty = { status: 'ready', value: { imageModels: [] }, revision: 3, writable: true, secrets: [] }

const emptyTree = render(empty)
assert.ok(emptyTree.hasClass('dsh-img-section'), 'the section element is missing')
assert.ok(emptyTree.nodes.some((record) => record.type === 'style'), 'the stylesheet child is missing')
assert.match(emptyTree.text, /图像生成模型接入区/, 'the title is missing')
assert.match(emptyTree.text, /还没有图像生成模型/, 'the empty state is missing')
assert.match(emptyTree.text, /添加图像生成模型/, 'the add control is missing')
const addButton = emptyTree.find((record) => typeof record.props?.className === 'string' && record.props.className.includes('dsh-img-add'))
assert.notEqual(addButton, undefined, 'the add button is missing')
assert.notEqual(addButton.props.disabled, true, 'the add button is disabled on a writable namespace')

const record = (overrides) => ({
  id: 'img-1',
  name: 'Relay',
  protocol: 'openai-images',
  baseUrl: 'https://relay.example/v1',
  apiKey: '',
  model: 'gpt-image-1',
  headers: [{ name: 'X-Tenant', value: 'acme' }],
  promptFormat: 'custom',
  promptPrefix: 'cinematic, ',
  promptNegative: 'blurry',
  promptTemplate: '{prefix}{prompt} --no {negative}',
  params: { size: 'square', width: 1024, height: 1024, steps: 30, timeoutMs: 60000 },
  isDefault: false,
  ...overrides,
})

const loadedTree = render({
  ...empty,
  value: { imageModels: [record({ isDefault: true }), record({ id: 'img-2', name: 'Local SD', protocol: 'stability-sd-webui' })] },
  secrets: [{ path: ['imageModels', '0', 'apiKey'], set: true }],
})
assert.match(loadedTree.text, /Relay/, 'the stored record is missing')
assert.match(loadedTree.text, /默认/, 'the default tag is missing')
assert.match(loadedTree.text, /OpenAI Images 接口/, 'the protocol tag is missing')
assert.match(loadedTree.text, /Local SD/, 'the second record is missing')
assert.match(loadedTree.text, /Stable Diffusion HTTP API/, 'the second protocol tag is missing')
assert.match(loadedTree.text, /设为默认/, 'the set-default action is missing for a non-default record')
// The credential marker is an attribute (role="img" + aria-label), not text.
const keyed = loadedTree.find((record) => record.props?.['aria-label'] === '已保存 API 密钥')
assert.notEqual(keyed, undefined, 'the stored-key marker is missing on the record that has one')
const unkeyed = loadedTree.find((record) => record.props?.['aria-label'] === '未保存 API 密钥')
assert.notEqual(unkeyed, undefined, 'the missing-key marker is missing on the record without one')

const readOnlyTree = render({ ...empty, writable: false })
assert.match(readOnlyTree.text, /只读/)
const readOnlyAdd = readOnlyTree.find((record) => typeof record.props?.className === 'string' && record.props.className.includes('dsh-img-add'))
assert.equal(readOnlyAdd.props.disabled, true, 'the add button is enabled on a read-only namespace')

assert.match(render({ ...empty, status: 'unavailable', writable: false }).text, /无法保存图像生成模型配置/)
const failedTree = render({ ...empty, status: 'error', error: 'boom' })
assert.match(failedTree.text, /图像生成模型配置加载失败/)
assert.match(failedTree.text, /boom/)

console.log('ok   the bundle registers settings.models.footer as image-models')
console.log('ok   the section renders in ready, populated, read-only, unavailable, and error states')
console.log(`ok   the empty-state section carries ${String(emptyTree.nodes.length)} nodes`)
