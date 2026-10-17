/**
 * The API-key indicator, against the shape the real client services publish.
 *
 * This is the regression for a real defect: `ConfigFormController.derive()` copies
 * `revision`, `base`, `user`, `writable` and the decoded `value` from the describe
 * mirror, but **not** `secrets`. A page that reads `snapshot.secrets` from the
 * per-namespace controller therefore sees `undefined` forever and reports "no API
 * key stored" while the key is on disk. The `secrets` array lives on the mirror's
 * namespace view instead, which is where the page must read it.
 *
 * The harness here reproduces exactly that split, so the check fails if the page
 * ever goes back to reading the field from the controller snapshot.
 *
 * Run: node checks/secret-indicator.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const moduleDir = path.join(here, '..')
const appRequire = createRequire('E:/DSH Desktop/resources/app/package.json')
const React = appRequire('react')
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

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

/** A dispatcher with per-component hook storage and working setters. */
function createRoot(rerender) {
  const stack = []
  const instances = new Map()
  const dispatcher = {
    useState: (initial) => {
      const frame = stack[stack.length - 1]
      const index = frame.cursor++
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
      const index = frame.cursor++
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
  return { nodes, text: nodes.filter((record) => record.text !== undefined).map((record) => record.text).join(' ') }
}

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

/**
 * Mount the section over services shaped like the real ones, and return both the
 * rendered tree and a rerender entry point so a click can be driven.
 *
 * @param secrets - the secret positions the Host would report.
 */
function mountMountable(secrets) {
  const registrations = []
  const dictionaries = new Map()
  const value = {
    imageModels: [
      { id: 'img-1', name: 'GLM-Image', protocol: 'openai-images', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-image', params: {} },
    ],
  }
  const controllerSnapshot = { status: 'ready', value, revision: 4, writable: true, mode: 'host' }
  const listeners = new Set()
  const scope = {
    getSnapshot: () => controllerSnapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: () => Promise.resolve(true),
  }
  const mirror = {
    getSnapshot: () => ({ status: 'ready', view: { writable: true, namespaces: [{ ns: 'image-studio', value, revision: 4, secrets }] } }),
    subscribe: () => () => {},
    load: () => Promise.resolve(),
  }
  const ctx = {
    locale: {
      bind: (ns) => (key) => {
        const dict = dictionaries.get(ns)
        const translated = dict === undefined ? undefined : dict[key]
        return typeof translated === 'string' ? translated : key
      },
      register: (ns, dicts) => {
        dictionaries.set(ns, dicts.zh ?? dicts.en)
        return () => {}
      },
    },
    configForms: { get: () => scope, describe: () => mirror },
    get: () => undefined,
    effect: (callback) => {
      callback()
      return () => {}
    },
    slots: { inject: (key, callback) => callback(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
  }
  const plugin = loadClientPlugin()
  plugin.apply(ctx)
  const { options, component } = registrations[0]
  const injected = options.inject()
  const props = {
    useSnapshot: (selector) => selector(injected.hooks.snapshot.getSnapshot()),
    operations: injected.operations,
    t: ctx.locale.bind('image-studio'),
  }
  let element
  const root = createRoot(() => {
    element = root.renderComponent(component, props)
  })
  const rerender = () => treeOf((element = root.renderComponent(component, props)), root)
  return { tree: rerender(), rerender }
}

/** The rendered tree alone, for a check that does not need to click. */
const mount = (secrets) => mountMountable(secrets).tree

await check('a stored key reads as saved when the Host reports the position', () => {
  const tree = mount([{ path: ['imageModels', '0', 'apiKey'], set: true }])
  const marked = tree.nodes.some((record) => record.props?.['aria-label'] === '已保存 API 密钥')
  assert.equal(marked, true, `the row must report a stored key; rendered text was: ${tree.text}`)
})

await check('an unstored key reads as not saved', () => {
  const tree = mount([])
  const marked = tree.nodes.some((record) => record.props?.['aria-label'] === '未保存 API 密钥')
  assert.equal(marked, true, 'a row without a key must report that')
})

await check('the editor hint follows the reported position too', () => {
  // The hint lives in the editor, so open it the way a user does.
  const surface = mountMountable([{ path: ['imageModels', '0', 'apiKey'], set: true }])
  const edit = surface.tree.nodes.find((record) => record.type === 'button' && record.props?.children === '编辑')
  assert.notEqual(edit, undefined, 'the edit control must be present')
  edit.props.onClick()
  const opened = surface.rerender()
  const copy = opened.text.replace(/^[\s\S]*?\.dsh-img-checkbox-row\{[^}]*\}\s*/, '')
  assert.match(copy, /已保存 API 密钥/, `the editor must not claim the key is missing; editor copy was: ${copy.slice(0, 300)}`)
  assert.doesNotMatch(copy, /未保存 API 密钥/, 'the editor must not claim the key is missing')
})

console.log(failures === 0 ? '\nall secret-indicator checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
