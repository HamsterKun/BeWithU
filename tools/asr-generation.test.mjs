import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../src/main/services/asr-generation.ts' && context.parentURL?.includes('asr-generation.test.mjs')) {
    return { shortCircuit: true, url: new URL('../src/main/services/asr-generation.ts', import.meta.url).href }
  }
  return next(specifier, context)
} })
const { AsrGeneration } = await import('../src/main/services/asr-generation.ts')

test('late ASR startup and finish results belong only to their generation', () => {
  const sessions = new AsrGeneration()
  const first = sessions.begin()
  const second = sessions.begin()
  assert.equal(sessions.current(first), false)
  assert.equal(sessions.current(second), true)
  sessions.invalidate()
  assert.equal(sessions.current(second), false)
})
