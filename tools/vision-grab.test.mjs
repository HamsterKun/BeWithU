import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

let sent
const mock = 'data:text/javascript,export const getBallWindow = () => ({webContents:{send:globalThis.__bwuTestSend}}); export const log = () => {};'
globalThis.__bwuTestSend = (_channel, request) => { sent = request }
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/vision-grab.ts')) {
    if (['./windows', './logger'].includes(specifier)) return { shortCircuit: true, url: mock }
    if (specifier === '../shared/ipc') return next('../shared/ipc.ts', context)
  }
  return next(specifier, context)
} })
const { grabViaWgc, getPendingWgcPermission, consumeWgcPermission, resolveGrab } = await import('../src/main/vision-grab.ts')

test('capture keeps its display and ignores unrelated responses', async () => {
  const waiting = grabViaWgc('42', 300)
  const request = sent
  assert.equal(request.displayId, '42')
  assert.equal(await grabViaWgc('7'), null)
  const permission = getPendingWgcPermission()
  assert.equal(permission.displayId, '42')
  consumeWgcPermission()
  assert.equal(getPendingWgcPermission(), null)
  resolveGrab({ requestId: 'old', ok: false })
  assert.equal(permission.isActive(), true)
  resolveGrab({ requestId: request.requestId, ok: false })
  assert.equal((await waiting).requestId, request.requestId)
  assert.equal(permission.isActive(), false)
})
