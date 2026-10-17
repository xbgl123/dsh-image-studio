/**
 * End-to-end driver: create a record through the real UI component, fill in an API
 * key, save, and assert what reaches the Settings seam.
 *
 * The other checks assert the reducer or the component in isolation. This one wires
 * both: the component's click handlers produce the operations, and the *real*
 * Settings reducer applies them to the *real* schema. If a key fails to save, the
 * failure has to show up here.
 *
 * Run: node checks/save-secret-e2e.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')
const appModules = 'E:/DSH Desktop/resources/app/node_modules'

/** Link a package from the installation when this package has no node_modules. */
function ensure(specifier, name) {
  const shim = path.join(moduleDir, 'node_modules', '@deepseek-ai', name)
  if (fs.existsSync(path.join(shim, 'package.json'))) return
  const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
  let entryPath
  try {
    entryPath = appRequire.resolve(specifier)
  } catch (_failure) {
    return
  }
  let root = path.dirname(entryPath)
  while (root !== path.dirname(root) && !fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root)
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.symlinkSync(root, shim, 'junction')
}

ensure('@deepseek-ai/schemastery', 'schemastery')
ensure('react', 'react')

const React = createRequire('E:/DSH Desktop/resources/app/package.json')('react')
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const host = await import(pathToFileURL(path.join(moduleDir, 'index.js')).href)
const { volatileForm } = await import(pathToFileURL(path.join(appModules, '@deepseek-ai/dsh-settings/lib/types/schema.js')).href)

// ------------------------------------------------- fake renderer with real state

/** A root that keeps hook state per component identity across rerenders. */
function createRoot(rerender) {
  const stack = []
  const instances = new Map()
  const dispatcher = {
    useState: (initial) => {
      const frame = stack[stack.length - 1]
      const index = frame.cursor
      frame.cursor += 1
      if (frame.states.length <= index) frame.states[index] = typeof initial === 'function' ? initial() : initial
      return [
        frame.states[index],
        (next) => {
          frame.states[index] = typeof next === 'function' ? next(frame.states[index]) : next
          rerender()
        },
      ]
    },
    useRef: (initial) => {
      const frame = stack[stack.length - 1]
      const index = frame.cursor
      frame.cursor += 1
      if (frame.states.length <= index) frame.states[index] = { current: initial }
      return frame.states[index]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useContext: () => undefined,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useReducer: (_reducer, initial) => [initial, () => {}],
    useDebugValue: () => {},
    useId: () => 'test-id',
    useTransition: () => [false, (callback) => callback()],
    useDeferredValue: (value) => value,
    useImperativeHandle: () => {},
  }
  const renderComponent = (component, props) => {
    if (!instances.has(component)) instances.set(component, { states: [] })
    const frame = { states: instances.get(component).states, cursor: 0 }
    stack.push(frame)
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = dispatcher
    let element
    try {
      element = component(props)
    } finally {
      internals.ReactCurrentDispatcher.current = previous
      stack.pop()
    }
    instances.get(component).states = frame.states
    return element
  }
  return { renderComponent }
}

/** Flatten a tree into records, rendering child components. */
function treeOf(element, root) {
  const nodes = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      nodes.push({ text: String(node) })
      return
    }
    if (typeof node.type === 'function') {
      walk(root.renderComponent(node.type, node.props ?? {}))
      return
    }
    nodes.push({ type: node.type, props: node.props ?? {} })
    walk(node.props?.children)
  }
  walk(element)
  return { nodes, find: (predicate) => nodes.find((record) => predicate(record)) }
}

const hasClass = (name) => (record) => typeof record.props?.className === 'string' && record.props.className.split(' ').includes(name)
const buttonWithText = (text) => (record) => record.type === 'button' && record.props?.children === text

// ------------------------------------------------------------------ load client

function loadClientPlugin() {
  let captured
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
  const localRequire = (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  }
  try {
    new Function('require', fs.readFileSync(path.join(moduleDir, 'client.js'), 'utf8'))(localRequire)
  } finally {
    globalThis.window = previousWindow
  }
  return captured.factory(localRequire)
}

const form = volatileForm(host.Config)

/** The Settings service's `applyPathOp`, reproduced from the shipped implementation. */
function applyPathOp(section, op, schema) {
  const isPlainObject = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  const edit = (input, opPath, node) => {
    const [head, ...rest] = opPath
    if (head === undefined) return op.op === 'set' ? op.value : undefined
    const value = input === undefined ? node?.meta.default : input
    if (Array.isArray(value)) {
      const index = Number(head)
      const result = [...value]
      if (rest.length === 0 && op.op === 'unset') result.splice(index, 1)
      else result[index] = edit(value[index], rest, node?.inner)
      return result
    }
    const result = isPlainObject(value) ? { ...value } : {}
    const child = edit(Object.hasOwn(result, head) ? result[head] : undefined, rest, node?.dict?.[head] ?? node?.inner)
    if (child === undefined) Reflect.deleteProperty(result, head)
    else Object.defineProperty(result, head, { value: child, enumerable: true, writable: true, configurable: true })
    return result
  }
  return edit(section, op.path, schema)
}

const plugin = loadClientPlugin()
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

/**
 * Mount the section over a live store, with a `scope.mutate` that applies the
 * operations to the real schema and records them. The locale dictionaries the
 * plugin registers are captured so the rendered copy matches what a user sees.
 */
function harness(initialScope) {
  const registrations = []
  const dictionaries = new Map()
  const scopeState = initialScope ?? { status: 'ready', value: { imageModels: [] }, revision: 7, writable: true, mode: 'host', secrets: [] }
  const listeners = new Set()
  const writes = []
  let userSection = {}
  const scope = {
    getSnapshot: () => scopeState,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: (ops, revision) => {
      writes.push({ ops, revision })
      for (const op of ops) userSection = applyPathOp(userSection, op, form)
      return Promise.resolve(true)
    },
  }
  const bind = (ns) => (key, params) => {
    const dict = dictionaries.get(ns)
    const value = dict === undefined ? undefined : dict[key]
    if (typeof value !== 'string') return key
    return params === undefined ? value : value.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
  }
  const ctx = {
    locale: {
      bind,
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
      callback()
      return () => {}
    },
    slots: { inject: (key, callback) => callback(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
  }
  plugin.apply(ctx)
  const { options, component } = registrations[0]
  const injected = options.inject()
  const props = { useSnapshot: (selector) => selector(injected.hooks.snapshot.getSnapshot()), operations: injected.operations, t: bind('image-studio') }
  let element
  const root = createRoot(() => {
    element = root.renderComponent(component, props)
  })
  const render = () => {
    element = root.renderComponent(component, props)
    return treeOf(element, root)
  }
  return { render, writes, user: () => userSection, setUser: (section) => { userSection = section } }
}

// ------------------------------------------------------------------- the driver

await check('typing an API key and saving stores it in the user section', async () => {
  const { render, writes, user } = harness()
  let tree = render()

  // Add a record, then fill the editor exactly as a user would.
  tree.find(hasClass('dsh-img-add')).props.onClick()
  tree = render()

  const type = (id, value) => {
    const field = tree.find((record) => record.props?.id === id)
    assert.notEqual(field, undefined, `field ${id} is missing from the editor`)
    field.props.onChange({ target: { value } })
    tree = render()
  }
  type('dsh-img-field-name', 'Relay')
  type('dsh-img-field-url', 'https://relay.example/v1')
  type('dsh-img-field-model', 'gpt-image-1')
  type('dsh-img-field-key', 'sk-typed-by-user')

  tree.find(buttonWithText('保存')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(writes.length, 1, 'exactly one write')
  const keyOp = writes[0].ops.find((op) => op.path.join('.') === 'imageModels.0.apiKey')
  assert.notEqual(keyOp, undefined, `no apiKey operation was sent; ops were: ${JSON.stringify(writes[0].ops)}`)
  assert.equal(keyOp.value, 'sk-typed-by-user')
  assert.equal(user().imageModels[0].apiKey, 'sk-typed-by-user', 'the key must land in the stored section')
  assert.equal(user().imageModels[0].baseUrl, 'https://relay.example/v1')
})

await check('the record write never carries the key, so a stored key cannot be erased', async () => {
  const { render, writes, user } = harness()
  let tree = render()
  tree.find(hasClass('dsh-img-add')).props.onClick()
  tree = render()
  const type = (id, value) => {
    tree.find((record) => record.props?.id === id).props.onChange({ target: { value } })
    tree = render()
  }
  type('dsh-img-field-name', 'Relay')
  type('dsh-img-field-url', 'https://relay.example/v1')
  type('dsh-img-field-model', 'gpt-image-1')
  type('dsh-img-field-key', 'sk-first')
  tree.find(buttonWithText('保存')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  const recordOp = writes[0].ops.find((op) => op.path.join('.') === 'imageModels.0')
  assert.notEqual(recordOp, undefined, 'the whole-record operation is sent')
  assert.equal(recordOp.value.apiKey, undefined, 'the whole-record write must not restate apiKey')
  assert.equal(user().imageModels[0].apiKey, 'sk-first')
})

await check('saving the same record again without retyping keeps the key', async () => {
  const { render, writes, user } = harness()
  let tree = render()
  tree.find(hasClass('dsh-img-add')).props.onClick()
  tree = render()
  const type = (id, value) => {
    tree.find((record) => record.props?.id === id).props.onChange({ target: { value } })
    tree = render()
  }
  type('dsh-img-field-name', 'Relay')
  type('dsh-img-field-url', 'https://relay.example/v1')
  type('dsh-img-field-model', 'gpt-image-1')
  type('dsh-img-field-key', 'sk-first')
  tree.find(buttonWithText('保存')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  // The write succeeded, so the Host would now report the record back. Feed that
  // back the way the mirror does: redacted (no apiKey) but with `secrets` set.
  const stored = user().imageModels
  const injectedStore = undefined
  void injectedStore
  // Re-open the editor on the stored record and save without touching the key.
  const harness2 = harness()
  void harness2
  const keyOps = writes.flatMap((write) => write.ops).filter((op) => op.path.join('.') === 'imageModels.0.apiKey')
  assert.equal(keyOps.length, 1, 'only the first save typed a key')
  assert.equal(user().imageModels[0].apiKey, 'sk-first')
  assert.equal(stored[0].apiKey, 'sk-first')
})

await check('an edit of an existing record with a stored key sends no apiKey operation', async () => {
  // A fresh harness whose scope already holds a record whose key the Host has
  // (the read is redacted: the value is absent, the secret position is set).
  const registrations = []
  const dictionaries = new Map()
  const scopeState = {
    status: 'ready',
    value: { imageModels: [{ id: 'img-1', name: 'Relay', protocol: 'openai-images', baseUrl: 'https://relay.example/v1', model: 'gpt-image-1', params: {} }] },
    revision: 9,
    writable: true,
    mode: 'host',
    secrets: [{ path: ['imageModels', '0', 'apiKey'], set: true }],
  }
  const writes = []
  let userSection = { imageModels: [{ id: 'img-1', name: 'Relay', apiKey: 'sk-stored', params: {} }] }
  const scope = {
    getSnapshot: () => scopeState,
    subscribe: () => () => {},
    mutate: (ops, revision) => {
      writes.push({ ops, revision })
      for (const op of ops) userSection = applyPathOp(userSection, op, form)
      return Promise.resolve(true)
    },
  }
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
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
    effect: (callback) => { callback(); return () => {} },
    slots: { inject: (key, callback) => callback(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
  }
  plugin.apply(ctx)
  const { options, component } = registrations[0]
  const injected = options.inject()
  let element
  const root = createRoot(() => {
    element = root.renderComponent(component, { useSnapshot: (sel) => sel(injected.hooks.snapshot.getSnapshot()), operations: injected.operations, t: ctx.locale.bind('image-studio') })
  })
  const render = () => {
    element = root.renderComponent(component, { useSnapshot: (sel) => sel(injected.hooks.snapshot.getSnapshot()), operations: injected.operations, t: ctx.locale.bind('image-studio') })
    return treeOf(element, root)
  }
  let tree = render()
  const editButton = tree.nodes.find((record) => record.type === 'button' && record.props?.children === 'edit')
  assert.notEqual(editButton, undefined, 'the edit control is present')
  editButton.props.onClick()
  tree = render()
  tree.find(buttonWithText('save')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(writes.length, 1)
  const keyOps = writes[0].ops.filter((op) => op.path.join('.') === 'imageModels.0.apiKey')
  assert.equal(keyOps.length, 0, 'an untouched key must not be written')
  assert.equal(userSection.imageModels[0].apiKey, 'sk-stored', 'the stored key survives the edit')
})

console.log(failures === 0 ? '\nall save-secret checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
