import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../src/main/services/retry-policy.ts' && context.parentURL?.includes('retry-policy.test.mjs')) {
    return { shortCircuit: true, url: new URL('../src/main/services/retry-policy.ts', import.meta.url).href }
  }
  if (specifier === './http-error' && context.parentURL?.endsWith('/retry-policy.ts')) {
    return { shortCircuit: true, url: new URL('../src/main/services/http-error.ts', import.meta.url).href }
  }
  return next(specifier, context)
} })
const { shouldRetryWithoutImage, shouldRetryBreeze429 } = await import('../src/main/services/retry-policy.ts')
const { HttpStatusError } = await import('../src/main/services/http-error.ts')

test('vision fallback recognizes structured LLM HTTP 400 without exposing body text', () => {
  assert.equal(shouldRetryWithoutImage(new HttpStatusError('请求失败，请稍后再试', 400, 'llm')), true)
  assert.equal(shouldRetryWithoutImage(new HttpStatusError('请求失败', 401, 'llm')), false)
  assert.equal(shouldRetryWithoutImage(new HttpStatusError('失败', 400, 'breeze')), false)
  assert.equal(shouldRetryWithoutImage(new Error('model does not support image input')), true)
})

test('Breeze backoff retries only structured Breeze 429 errors', () => {
  assert.equal(shouldRetryBreeze429(new HttpStatusError('请求过于频繁', 429, 'breeze')), true)
  assert.equal(shouldRetryBreeze429(new HttpStatusError('请求过于频繁', 429, 'llm')), false)
  assert.equal(shouldRetryBreeze429(new Error('HTTP 429')), false)
  assert.equal(shouldRetryBreeze429(new Error('并发请求过多')), false)
})
