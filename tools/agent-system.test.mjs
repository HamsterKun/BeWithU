import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'bwu-system-tools-'))
after(() => rmSync(root, { recursive: true, force: true }))
const fixture = globalThis.__bwuSystem = { root, tools: new Map(), notification: 'show' }
const stub = (src) => ({ shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(src) })
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (specifier === 'electron') {
      return stub(`
        import { EventEmitter } from 'node:events'
        export const app = { getPath: () => globalThis.__bwuSystem.root }
        export const shell = {}
        export const safeStorage = { isEncryptionAvailable: () => false }
        export class Notification extends EventEmitter {
          static isSupported() { return globalThis.__bwuSystem.notification !== 'unsupported' }
          constructor(options) { super(); this.options = options }
          show() {
            const fixture = globalThis.__bwuSystem
            this.emit(fixture.notification, {}, 'native fixture')
            fixture.notified?.(this.options)
          }
          close() {}
        }
      `)
    }
    if (specifier === '../registry') return stub('export const registerTool = (tool) => globalThis.__bwuSystem.tools.set(tool.id, tool)')
    if (specifier === '../logger') return stub('export const log = () => {}')
    if (specifier === 'node:child_process' && parent.endsWith('/tools/system.ts')) {
      return stub('export const spawn = (executable, args, options) => globalThis.__bwuSystem.spawn(executable, args, options)')
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context)
    return next(specifier, context)
  }
})
const { ReminderStore, showNotification } = await import('../src/main/agent/reminders.ts')
const { registerSystemTools } = await import('../src/main/agent/tools/system.ts')
registerSystemTools()
const call = (id, args, signal = new AbortController().signal) => fixture.tools.get(id).run(args, { signal })

test('launch waits for the spawn outcome and never uses a shell fallback', async () => {
  fixture.spawn = (exe, args, options) => {
    const child = new EventEmitter()
    child.unref = () => {}
    assert.notEqual(options.shell, true)
    queueMicrotask(() => {
      if (exe === 'notepad.exe') { child.pid = 1234; child.emit('spawn') }
      else child.emit('error', new Error('ENOENT'))
    })
    return child
  }
  assert.deepEqual((await call('app.launch', { name: 'notepad' })).data, { pid: 1234 })
  const failed = await call('app.launch', { name: 'missing.exe' })
  assert.equal(failed.ok, false)
  assert.match(failed.summary, /ENOENT/)
})

test('native notification failure or unsupported platform does not report success', async () => {
  fixture.notification = 'unsupported'
  await assert.rejects(call('notify', { title: 'fixture' }), /不支持/)
  fixture.notification = 'failed'
  await assert.rejects(showNotification('fixture', ''), /native fixture/)
  fixture.notification = 'show'
  assert.equal((await call('notify', { title: 'fixture' })).ok, true)
})

test('reminders survive restart, then can be listed and cancelled by ID', async () => {
  const reminder = (await call('remind', { minutes: 5, text: 'fixture' })).data
  const file = join(root, 'agent', 'reminders.json')
  assert.deepEqual(new ReminderStore(file).list(), [reminder])
  const records = (await call('remind', { action: 'list' })).data.reminders
  assert.equal(records[0].id, reminder.id)
  assert.equal((await call('remind', { action: 'cancel', id: reminder.id })).ok, true)
  assert.deepEqual(new ReminderStore(file).list(), [])
  assert.equal((await call('remind', { action: 'cancel', id: reminder.id })).ok, false)
})

test('expired persisted reminder is delivered on startup and then removed', async () => {
  const file = join(root, 'overdue.json')
  writeFileSync(file, JSON.stringify([{ id: 'overdue', dueAt: Date.now() - 1000, text: '补发' }]))
  const shown = Promise.withResolvers()
  fixture.notified = shown.resolve
  const store = new ReminderStore(file)
  const keepAlive = setTimeout(() => shown.reject(new Error('reminder not delivered')), 1500)
  try {
    assert.deepEqual(await shown.promise, { title: '提醒', body: '补发' })
    await new Promise(setImmediate)
    assert.deepEqual(store.list(), [])
    assert.deepEqual(new ReminderStore(file).list(), [])
  } finally {
    fixture.notified = undefined
    clearTimeout(keepAlive)
  }
})
