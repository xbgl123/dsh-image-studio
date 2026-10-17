/**
 * Routing rules: native capability, the configured default, and the guidance the
 * user gets when neither can serve a request.
 *
 * Run: node checks/router.mjs
 */
import assert from 'node:assert/strict'

import { conversationModelGeneratesImages, defaultModel, isServable, readModels, routeRequest } from '../src/router.mjs'

let failures = 0
/** Run one named case, recording failure instead of aborting the suite. */
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

const section = {
  imageModels: [
    {
      id: 'img-1',
      name: 'Relay',
      protocol: 'openai-images',
      baseUrl: 'https://relay.example/v1',
      model: 'gpt-image-1',
      params: { width: 1024, height: 1024 },
      isDefault: true,
    },
    {
      id: 'img-2',
      name: 'Local SD',
      protocol: 'stability-sd-webui',
      baseUrl: 'http://127.0.0.1:7860',
      model: 'sd_xl',
      params: { width: 768, height: 768 },
      isDefault: false,
    },
    {
      id: 'img-3',
      name: 'Future protocol',
      protocol: 'custom',
      baseUrl: 'https://future.example/api',
      model: 'x',
      isDefault: false,
    },
  ],
}

// ------------------------------------------------------------------- reading

check('the stored section projects into model records', () => {
  const models = readModels(section)
  assert.equal(models.length, 3)
  assert.equal(models[0].promptPassThrough, 'auto', 'an absent new field defaults to auto')
  assert.equal(models[1].protocol, 'stability-sd-webui')
})

check('a malformed section yields an empty list, never a throw', () => {
  assert.deepEqual(readModels(undefined), [])
  assert.deepEqual(readModels(null), [])
  assert.deepEqual(readModels({ imageModels: 'nope' }), [])
  assert.deepEqual(readModels({}), [])
})

check('the default is the one flagged record', () => {
  assert.equal(defaultModel(readModels(section)).id, 'img-1')
  assert.equal(defaultModel([]), undefined)
})

check('servability needs a supported protocol and a real endpoint', () => {
  const models = readModels(section)
  assert.equal(isServable(models[0]), true)
  assert.equal(isServable(models[1]), true)
  assert.equal(isServable(models[2]), false, 'custom has no adapter yet')
})

// ------------------------------------------------------------------- routing

check('a native-capable conversation model is left alone', () => {
  const route = routeRequest({
    models: readModels(section),
    nativeRoutes: ['deepseek-account/dall-e-3'],
    provider: 'deepseek-account',
    model: 'dall-e-3',
  })
  assert.equal(route.kind, 'native')
  assert.equal(route.reason, 'conversation-model-is-image-capable')
})

check('a declared provider alone also counts as native', () => {
  const route = routeRequest({ models: readModels(section), nativeRoutes: ['image-provider'], provider: 'image-provider', model: 'whatever' })
  assert.equal(route.kind, 'native')
})

check('a non-native conversation model routes to the default image model', () => {
  const route = routeRequest({ models: readModels(section), nativeRoutes: [], provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(route.kind, 'configured')
  assert.equal(route.reason, 'default-model')
  assert.equal(route.model.id, 'img-1')
})

check('an explicit model id wins over the default', () => {
  const route = routeRequest({ models: readModels(section), nativeRoutes: [], provider: 'p', model: 'm', requestedModelId: 'img-2' })
  assert.equal(route.kind, 'configured')
  assert.equal(route.reason, 'explicit-model-requested')
  assert.equal(route.model.id, 'img-2')
})

check('an explicit model that cannot be served is reported as unusable, not called', () => {
  const route = routeRequest({ models: readModels(section), nativeRoutes: [], provider: 'p', model: 'm', requestedModelId: 'img-3' })
  assert.equal(route.kind, 'unusable')
  assert.equal(route.reason, 'explicit-model-not-servable')
})

check('no configured model produces guidance that names the settings page', () => {
  const route = routeRequest({ models: [], nativeRoutes: [], provider: 'p', model: 'm' })
  assert.equal(route.kind, 'unconfigured')
  assert.equal(route.reason, 'no-image-model-configured')
  assert.match(route.guide, /Settings/)
  assert.match(route.guide, /Image generation models/)
})

check('configured models without a default produce their own guidance', () => {
  const models = readModels(section).map((model) => ({ ...model, isDefault: false }))
  const route = routeRequest({ models, nativeRoutes: [], provider: 'p', model: 'm' })
  assert.equal(route.kind, 'unconfigured')
  assert.equal(route.reason, 'no-default-image-model')
  assert.match(route.guide, /Set as default/)
})

check('a default that cannot be served is reported instead of silently skipped', () => {
  const models = readModels(section).map((model) => (model.id === 'img-1' ? { ...model, baseUrl: '' } : model))
  const route = routeRequest({ models, nativeRoutes: [], provider: 'p', model: 'm' })
  assert.equal(route.kind, 'unusable')
  assert.equal(route.reason, 'default-model-not-servable')
})

check('the capability predicate matches the routing decision', () => {
  assert.equal(conversationModelGeneratesImages({ nativeRoutes: ['p/m'], provider: 'p', model: 'm' }), true)
  assert.equal(conversationModelGeneratesImages({ nativeRoutes: ['p/other'], provider: 'p', model: 'm' }), false)
  assert.equal(conversationModelGeneratesImages({ nativeRoutes: [], provider: 'p', model: 'm' }), false)
})

console.log(failures === 0 ? '\nall routing checks passed' : `\n${String(failures)} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
