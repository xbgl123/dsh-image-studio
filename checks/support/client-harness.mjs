/**
 * Shared client-side harness for the checks that render the settings section.
 *
 * The real services have a shape worth reproducing exactly, because one real
 * defect came from mistaking it:
 *
 * - `ctx.configForms.get(ns)` returns a `ConfigFormController` whose snapshot
 *   carries `status`, `value`, `revision`, `writable`, `base`, `user` and `mode` —
 *   and **not** `secrets`, because the controller does not copy that field.
 * - `ctx.configForms.describe()` returns the shared describe mirror, whose
 *   namespace view carries the Host's `secrets` array (which positions are filled).
 *
 * Keeping that split in the fakes is what lets `checks/secret-indicator.mjs` fail
 * if the page ever goes back to reading secrets from the controller.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
export const React = appRequire('react')
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

/** A renderer with per-component hook storage that survives rerenders. */
export function createRoot() {
  const stack = []
  const instances = new Map()
  const noop = () => {}
  const dispatcher = {
    useState: (initial) => {
      const frame = stack[stack.length - 1]
      const index = frame.cursor++
      if (frame.states.length <= index) frame.states[index] = typeof initial === 'function' ? initial() : initial
      return [
        frame.states[index],
        (next) => {
          frame.states[index] = typeof next === 'function' ? next(frame.states[index]) : next
        },
      ]
    },
    useRef: (initial) => {
      const frame = stack[stack.length - 1]
      const index = frame.cursor++
      if (frame.states.length <= index) frame.states[index] = { current: initial }
      return frame.states[index]
    },
    useEffect: noop,
    useLayoutEffect: noop,
    useInsertionEffect: noop,
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useContext: () => undefined,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useReducer: (_reducer, initial) => [initial, noop],
    useDebugValue: noop,
    useId: () => 'test-id',
    useTransition: () => [false, (callback) => callback()],
    useDeferredValue: (value) => value,
    useImperativeHandle: noop,
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

/** Flatten an element tree into records, rendering child components. */
export function treeOf(element, root) {
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
    /** Every `id` attribute, in render order. */
    ids: () => nodes.map((record) => record.props?.id).filter((id) => typeof id === 'string'),
    /** First record whose props satisfy `predicate`. */
    find: (predicate) => nodes.find((record) => predicate(record)),
    /** All records whose props satisfy `predicate`. */
    all: (predicate) => nodes.filter((record) => predicate(record)),
  }
}

export const hasClass = (name) => (record) =>
  typeof record.props?.className === 'string' && record.props.className.split(' ').includes(name)
export const buttonWithText = (text) => (record) => record.type === 'button' && record.props?.children === text

/** Load the client bundle the way the page does and return the plugin it exports. */
export function loadClientPlugin() {
  const moduleDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  let captured
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(registration) { captured = registration } } }
  const localRequire = (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  }
  try {
    new Function('require', fs.readFileSync(path.join(moduleDir, '..', 'client.js'), 'utf8'))(localRequire)
  } finally {
    globalThis.window = previousWindow
  }
  if (captured === undefined) throw new Error('the client bundle did not register')
  return captured.factory(localRequire)
}

/**
 * A fake client context whose service shapes match the real ones.
 *
 * @param options - `{ initialValue, secrets, revision, writable, status, mirror }`.
 *   `mirror` is the describe mirror; omit it to use one derived from `secrets`.
 */
export function fakeClientContext(options = {}) {
  const registrations = []
  const dictionaries = new Map()
  const writes = []
  const value = options.initialValue ?? { imageModels: [] }
  const revision = options.revision ?? 3
  const writable = options.writable !== false
  const status = options.status ?? 'ready'
  const secrets = options.secrets ?? []

  // The controller snapshot: no `secrets` field, exactly like the real one.
  const controllerSnapshot = { status, value, revision, writable, mode: 'host', error: options.error ?? null }
  const scopeListeners = new Set()
  const scope = {
    getSnapshot: () => controllerSnapshot,
    subscribe: (listener) => {
      scopeListeners.add(listener)
      return () => scopeListeners.delete(listener)
    },
    mutate: (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision })
      return options.mutate === undefined ? Promise.resolve(true) : options.mutate(ops, expectedRevision)
    },
  }

  const mirror =
    options.mirror ??
    {
      getSnapshot: () => ({
        status: 'ready',
        view: { writable, namespaces: [{ ns: 'image-studio', value, revision, secrets }] },
        error: null,
      }),
      subscribe: () => () => {},
      load: () => Promise.resolve(),
    }

  const bind = (ns) => (key, params) => {
    const dict = dictionaries.get(ns)
    const translated = dict === undefined ? undefined : dict[key]
    if (typeof translated !== 'string') return key
    return params === undefined
      ? translated
      : translated.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
  }
  const ctx = {
    locale: {
      bind,
      register: (ns, dicts) => {
        dictionaries.set(ns, dicts.zh ?? dicts.en)
        return () => dictionaries.delete(ns)
      },
    },
    configForms: { get: () => scope, describe: () => mirror },
    get: () => undefined,
    effect: (callback) => {
      const disposed = callback()
      return typeof disposed === 'function' ? disposed : () => {}
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (registration, component) => {
        registrations.push({ options: registration, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, writes, bind, scope, mirror }
}

/**
 * Mount the section and return a rerender entry point.
 *
 * @param options - as {@link fakeClientContext}.
 */
export function mountSection(options = {}) {
  const plugin = loadClientPlugin()
  const harness = fakeClientContext(options)
  plugin.apply(harness.ctx)
  const registration = harness.registrations[0]
  if (registration === undefined) throw new Error('the section did not register')
  const injected = registration.options.inject()
  const props = {
    useSnapshot: (selector) => selector(injected.hooks.snapshot.getSnapshot()),
    operations: injected.operations,
    t: harness.bind('image-studio'),
  }
  const root = createRoot()
  let element
  const rerender = () => treeOf((element = root.renderComponent(registration.component, props)), root)
  return { ...harness, plugin, registration, injected, props, tree: rerender(), rerender }
}
