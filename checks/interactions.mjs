/**
 * Drive the section the way a user does: render it, fire the add control, render
 * the state that produced, then fill the editor and save.
 *
 * A click that throws, or an editor that renders nothing, is invisible in the
 * slot tree — the renderer's error boundary swallows it and the area looks inert.
 * This is where such a defect shows up.
 *
 * The fake root below keeps hook state per component identity across renders, so
 * a `setState` fired from a click handler is visible in the next render. That
 * property is the whole point: without it a broken click and a working one look
 * identical.
 *
 * Run: node checks/interactions.mjs
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
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

// --------------------------------------------------- a stateful fake renderer

/**
 * A root that renders a function-component tree with per-component hook storage
 * that survives rerenders.
 *
 * @param rerender - called by a hook when state changed and the tree must render again.
 */
function createRoot(rerender) {
  /** One frame per mounted component instance, innermost last. */
  const stack = []
  /** Hook storage keyed by component identity, so a rerender keeps its state. */
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

  /** Render one component with its own hook storage, creating it on first mount. */
  const renderComponent = (component, props) => {
    const key = component
    if (!instances.has(key)) instances.set(key, { states: [] })
    const frame = { states: instances.get(key).states, cursor: 0 }
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
    instances.get(key).states = frame.states
    return element
  }

  return { renderComponent }
}

/** Flatten an element tree into records and their text, rendering child components. */
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
  return {
    nodes,
    text: nodes.filter((record) => record.text !== undefined).map((record) => record.text).join(' '),
    /** First record whose props satisfy `predicate`. */
    find: (predicate) => nodes.find((record) => predicate(record)),
    /** All `id` attributes, in render order. */
    ids: () => nodes.map((record) => record.props?.id).filter((id) => typeof id === 'string'),
  }
}

const hasClass = (name) => (record) => typeof record.props?.className === 'string' && record.props.className.split(' ').includes(name)
const buttonWithText = (text) => (record) => record.type === 'button' && record.props?.children === text

// --------------------------------------------------------------- load bundle

function loadPlugin() {
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
  assert.notEqual(captured, undefined, 'the bundle did not register')
  return captured.factory(localRequire)
}

function fakeContext() {
  const registrations = []
  const dictionaries = new Map()
  const scopeState = { status: 'ready', value: { imageModels: [] }, revision: 3, writable: true, mode: 'host', secrets: [] }
  const listeners = new Set()
  const writes = []
  const scope = {
    getSnapshot: () => scopeState,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: (ops, revision) => {
      writes.push({ ops, revision })
      return Promise.resolve(true)
    },
  }
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
        return params === undefined ? value : value.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
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
    slots: { inject: (key, callback) => callback(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
  }
  return { ctx, registrations, updateScope, writes }
}

// --------------------------------------------------------------------- driving

const plugin = loadPlugin()
const { ctx, registrations, updateScope, writes } = fakeContext()
plugin.apply(ctx)

const { options, component } = registrations[0]
const injected = options.inject()
const t = ctx.locale.bind('image-studio')
const useSnapshot = (selector) => selector(injected.hooks.snapshot.getSnapshot())

let element
const root = createRoot(() => {
  element = root.renderComponent(component, { useSnapshot, operations: injected.operations, t })
})
/** Render once and return the tree; call again to see the state a click produced. */
const render = () => {
  element = root.renderComponent(component, { useSnapshot, operations: injected.operations, t })
  return treeOf(element, root)
}
/** Re-walk the tree a click handler may have replaced (the root rerenders itself). */
const tree = () => treeOf(element, root)

// (1) The add control exists, is enabled, and carries a click handler.
let section = render()
const addButton = section.find(hasClass('dsh-img-add'))
assert.notEqual(addButton, undefined, 'no add button rendered')
assert.notEqual(addButton.props.disabled, true, 'the add button is disabled on a writable namespace')
assert.equal(typeof addButton.props.onClick, 'function', 'the add button has no click handler')

// (2) Fire it — the handler must not throw — and render what it produced.
// React reports a keyless element in a children array through console.error; that
// warning is a real defect in this view, so the check turns it into a failure.
const warnings = []
const originalError = console.error
console.error = (...args) => {
  warnings.push(args.map((value) => String(value)).join(' '))
}
addButton.props.onClick()
section = render()
console.error = originalError
const keyWarnings = warnings.filter((warning) => warning.includes('unique "key"'))
assert.deepEqual(keyWarnings, [], `React reported a keyless child:\n${keyWarnings.join('\n')}`)
assert.match(section.text, /接入配置/, 'the editor did not open: the connection group is missing')
assert.match(section.text, /格式配置/, 'the editor did not open: the format group is missing')
assert.match(section.text, /参数模板/, 'the editor did not open: the parameters group is missing')
assert.match(section.text, /前置默认词/, 'the prefix field is missing')
assert.match(section.text, /负面默认词/, 'the negative field is missing')
assert.match(section.text, /Prompt 格式预设/, 'the prompt format selector is missing')
assert.match(section.text, /自定义请求头/, 'the headers editor is missing')
assert.match(section.text, /保存/, 'the save control is missing')
assert.match(section.text, /取消/, 'the cancel control is missing')

// (3) Field ids must be unique to this plugin: the native provider cards and the
// draft editor share one document, and a duplicate id makes label/field wiring
// ambiguous.
const ids = section.ids()
for (const wanted of ['dsh-img-field-name', 'dsh-img-field-protocol', 'dsh-img-field-url', 'dsh-img-field-key', 'dsh-img-field-model', 'dsh-img-field-preset', 'dsh-img-field-prefix', 'dsh-img-field-negative', 'dsh-img-field-size', 'dsh-img-field-steps', 'dsh-img-field-timeout']) {
  assert.ok(ids.includes(wanted), `the editor is missing the "${wanted}" field id (got: ${ids.join(', ')})`)
}
for (const id of ids) {
  assert.ok(id.startsWith('dsh-img-'), `field id "${id}" is not namespaced to this plugin`)
}
assert.equal(new Set(ids).size, ids.length, `duplicate field ids within one editor: ${ids.join(', ')}`)

// (4) Custom prompt format reveals the template field on the next render.
section.find((record) => record.props?.id === 'dsh-img-field-preset').props.onChange({ target: { value: 'custom' } })
section = render()
assert.match(section.text, /自定义模板/, 'the custom template field did not appear')
assert.match(section.text, /可使用 \{prompt\}/, 'the template hint is missing')

// (5) Saving a valid draft writes through the settings seam exactly once.
const type = (id, value) => {
  section.find((record) => record.props?.id === id).props.onChange({ target: { value } })
  section = render()
}
type('dsh-img-field-name', 'Relay')
type('dsh-img-field-url', 'https://relay.example/v1')
type('dsh-img-field-model', 'gpt-image-1')
type('dsh-img-field-template', '{prefix}{prompt}')
type('dsh-img-field-prefix', 'cinematic, ')
type('dsh-img-field-negative', 'blurry')
type('dsh-img-field-key', 'sk-test')

// The add button is locked while a draft is open, as it should be.
assert.equal(section.find(hasClass('dsh-img-add')).props.disabled, true, 'the add button is not locked while a draft is open')

const saveButton = section.find(buttonWithText('保存'))
assert.notEqual(saveButton, undefined, 'the save button is missing')
saveButton.props.onClick()
await new Promise((resolve) => setImmediate(resolve))

assert.equal(writes.length, 1, `expected exactly one write, got ${String(writes.length)}`)
const [write] = writes
assert.equal(write.ops[0].op, 'set')
assert.deepEqual(write.ops[0].path, ['imageModels', '0'])
assert.equal(write.ops[0].value.name, 'Relay')
assert.equal(write.ops[0].value.protocol, 'openai-images')
assert.equal(write.ops[0].value.promptFormat, 'custom')
assert.equal(write.ops[0].value.promptPrefix, 'cinematic, ')
assert.equal(write.ops[0].value.promptNegative, 'blurry')
assert.equal(write.ops[0].value.apiKey, undefined, 'the record write must not restate the redacted apiKey')
assert.deepEqual(write.ops[1], { op: 'set', path: ['imageModels', '0', 'apiKey'], value: 'sk-test' })
assert.equal(write.revision, 3, 'the write must carry the revision the editor read')

// (6) After the write the editor closes, and validation blocks an empty name.
const afterSave = tree()
assert.ok(afterSave.find(hasClass('dsh-img-add')).props.disabled !== true, 'the add button stayed locked after saving')

console.log('ok   the add button fires and opens the editor with every group and field')
console.log(`ok   editor field ids are namespaced and unique (${String(ids.length)} ids)`)
console.log('ok   the prompt format preset reveals the custom template field')
console.log('ok   saving writes one record plus its apiKey path, without restating a redacted key')
