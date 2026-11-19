import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const stub = 'data:text/javascript,export const log = () => {}; export const sendBubble = () => {};'
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/approval.ts') && ['../logger', '../windows'].includes(specifier)) {
    return { shortCircuit: true, url: stub }
  }
  return next(specifier, context)
} })
const { requestApproval, cancelApprovalsForTurn, pendingApproval, resolveApproval, resolvePendingByText, interpretApprovalReply } = await import('../src/main/agent/approval.ts')
const req = { toolId: 'fixture', title: 'Fixture', detail: 'Test only' }

test('approval accepts a whole affirmative, not a question or qualified reply', () => {
  assert.equal(interpretApprovalReply(' 可以。 '), true)
  assert.equal(interpretApprovalReply('可以，但是先等等'), null)
  assert.equal(interpretApprovalReply('可以？'), null)
  assert.equal(interpretApprovalReply('取消。'), false)
})

test('aborting dismisses approval and invalidates a late button click', async () => {
  const controller = new AbortController()
  const result = requestApproval(req, 1, controller.signal)
  const id = pendingApproval().id
  controller.abort()
  assert.equal(await result, false)
  assert.equal(resolveApproval(id, true), false)
  assert.equal(pendingApproval(), null)
})

test('text only confirms the selected round', async () => {
  const signal = new AbortController().signal
  const result = requestApproval(req, 2, signal)
  assert.equal(resolvePendingByText('同意', 3), null)
  assert.equal(resolvePendingByText('同意', 2), true)
  assert.equal(await result, true)
  const cancelled = requestApproval(req, 2, signal)
  cancelApprovalsForTurn(2)
  assert.equal(await cancelled, false)
})
