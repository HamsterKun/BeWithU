import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const calls = []
const port = new EventEmitter()
Object.defineProperty(process, 'parentPort', { value: port })
port.postMessage = (data) => port.emit('output', data)
globalThis.__bwuInput = { send: null }
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== 'koffi') return next(specifier, context)
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(`
        export default { load: () => ({ func(signature) {
          const name = signature.split(' ')[1].split('(')[0]
          if (name === 'SendInput') return (count, buffer, size) => globalThis.__bwuInput.send(count, buffer, size)
          if (name === 'OpenInputDesktop') return () => 1
          if (name === 'GetForegroundWindow') return () => 17
          if (name === 'GetSystemMetrics') return (metric) => metric > 77 ? 1920 : 0
          return () => 0
        } }) }
      `)
    }
  }
})
await import('../src/main/input-worker.ts')

function request(id, cmd, args) {
  return new Promise((resolve) => {
    const listener = (reply) => {
      if (reply.id !== id) return
      port.off('output', listener)
      resolve(reply)
    }
    port.on('output', listener)
    port.emit('message', { data: { id, cmd, args } })
  })
}
const cancel = (id) => port.emit('message', { data: { cancelId: id } })
function record(count, buffer, size) {
  for (let i = 0; i < count; i++) calls.push(buffer.subarray(i * size, (i + 1) * size))
  return count
}

test('LF, CRLF and CR each inject one Enter along with Unicode text', async () => {
  globalThis.__bwuInput.send = record
  const result = await request(1, 'type', { text: 'A\n中\r\nB\r😀' })
  assert.equal(result.ok, true)
  const enters = calls.filter((event) => event.readUInt32LE(0) === 1 && event.readUInt16LE(8) === 13)
  assert.equal(enters.length, 6)
  assert.deepEqual(enters.map((event) => event.readUInt32LE(12)), [0, 2, 0, 2, 0, 2])
})

test('cancellation stops subsequent keyboard batches and removes pending commands', async () => {
  calls.length = 0
  globalThis.__bwuInput.send = (...args) => {
    cancel(2)
    cancel(3)
    return record(...args)
  }
  const typing = request(2, 'type', { text: 'x'.repeat(512) })
  const click = request(3, 'click', {})
  assert.equal((await typing).ok, false)
  assert.equal((await click).ok, false)
  assert.equal(calls.length, 64)
  assert.equal((await request(4, 'ping')).result, 'pong')
})

test('stopping an in-progress drag releases the mouse button', async () => {
  calls.length = 0
  globalThis.__bwuInput.send = (count, buffer, size) => {
    if (buffer.readUInt32LE(20) === 2) cancel(5)
    return record(count, buffer, size)
  }
  const result = await request(5, 'drag', { from: { x: 5, y: 10 }, to: { x: 70, y: 90 } })
  assert.equal(result.ok, false)
  assert.deepEqual(calls.slice(1).map((event) => event.readUInt32LE(20)), [2, 4])
})
