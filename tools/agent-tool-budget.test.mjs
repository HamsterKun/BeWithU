import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../src/main/agent/tool-budget.ts' && context.parentURL?.includes('agent-tool-budget.test.mjs')) {
    return { shortCircuit: true, url: new URL('../src/main/agent/tool-budget.ts', import.meta.url).href }
  }
  return next(specifier, context)
} })
const { planToolCalls } = await import('../src/main/agent/tool-budget.ts')

test('a model response cannot exceed the remaining per-task tool budget', () => {
  const calls = ['one', 'two', 'three', 'four']
  assert.deepEqual(planToolCalls(2, calls), { allowed: ['one', 'two'], skipped: ['three', 'four'] })
  assert.deepEqual(planToolCalls(0, calls), { allowed: [], skipped: calls })
  assert.deepEqual(planToolCalls(-1, calls), { allowed: [], skipped: calls })
  assert.deepEqual(planToolCalls(5, calls), { allowed: calls, skipped: [] })
})
