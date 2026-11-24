import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/services/dsh.ts')) {
      if (specifier === './sse') return next('./sse.ts', context)
      if (specifier === 'electron') {
        return { shortCircuit: true, url: 'data:text/javascript,' +
          encodeURIComponent('export const app = { isPackaged: false, getAppPath: () => process.cwd() }') }
      }
    }
    return next(specifier, context)
  }
})
const { installDshBridge, updateDshPatch, listDshSessions, runDsh } = await import('../src/main/services/dsh.ts')

test('install patch appends one bridge entry and preserves existing desktop configuration', () => {
  const existing = '# user patch\n- id: other\n  config:\n    value: 17\n'
  const installed = updateDshPatch(existing, 'C:\\Users\\例子\\bewithu-bridge.mjs')
  assert.ok(installed.startsWith(existing))
  assert.match(installed, /"C:\/Users\/例子\/bewithu-bridge\.mjs"/)
  assert.equal(updateDshPatch(installed, 'C:\\Users\\例子\\bewithu-bridge.mjs'), installed)
  assert.doesNotMatch(updateDshPatch('[]\n', '/bridge.mjs'), /\[\]/)
  assert.throws(() => updateDshPatch('foo: bar\n', '/bridge.mjs'), /YAML 列表/)
})

test('the running bridge lists conversations, delivers to the selection and cancels only its active turn', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bwu-dsh-route-'))
  const profile = join(home, 'profiles', 'desktop')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const bus = new EventEmitter()
  const on = (name, listener) => {
    bus.on(name, listener)
    return () => bus.off(name, listener)
  }
  t.after(async () => {
    bus.emit('dispose')
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{}')
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: keep-this\n')
  assert.equal(installDshBridge().ok, true)
  assert.match(await readFile(join(profile, 'cordis.patch.yml.before-bewithu'), 'utf8'), /keep-this/)

  const calls = []
  const makeAgent = (id) => ({
    session: { id },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    cancel(cause, options) { calls.push(['cancel', id, cause.kind, options.keepInbox]); this.end.resolve() },
    async whenIdle() { await this.end.promise; this.status = 'idle' }
  })
  const agents = new Map(['session-one', 'session-two'].map((id) => [id, makeAgent(id)]))
  let createdSessions = 0
  const clock = { accepted: Promise.withResolvers(), stopped: Promise.withResolvers() }
  const { apply } = await import(pathToFileURL(join(profile, 'bewithu-bridge.mjs')).href)
  apply({
    on,
    logger: { error(error) { assert.fail(String(error)) } },
    sessionController: {
      list: async () => ({ items: [
        { sessionId: 'session-one', title: '另一条', cwd: 'other' },
        { sessionId: 'session-two', title: '我的对话', cwd: 'workspace' },
        { sessionId: 'worker', origin: 'subagent' }
      ] }),
      resolveAgent: async (id) => agents.has(id) ? { agent: agents.get(id) } : { error: 'missing' },
      async create() {
        createdSessions += 1
        const id = 'session-dedicated'
        agents.set(id, makeAgent(id))
        return { sessionId: id }
      },
      async prompt(request) {
        calls.push(['prompt', request.sessionId, request.content[0].text])
        const agent = agents.get(request.sessionId)
        agent.status = 'running'
        agent.end = Promise.withResolvers()
        const fire = (type, data) => bus.emit('session/event', agent.session, { type, data })
        fire('agent/inbox/spliced', { inserted: [{ source: { rpcId: request.requestId } }] })
        fire('tool/call', {})
        if (request.content[0].text === 'hold') {
          clock.accepted.resolve()
          agent.end.promise.then(clock.stopped.resolve)
          return
        }
        fire('tool/result', {})
        fire('assistant/message', { message: { content: [{ type: 'text', text: '结果' }] } })
        fire('turn/end', { reason: { kind: 'completed' } })
        agent.end.resolve()
      }
    }
  })
  let connection
  for (let i = 0; i < 60 && !connection?.ok; i++) {
    connection = await listDshSessions()
    if (!connection.ok) await sleep(20)
  }
  assert.equal(connection.ok, true, connection.message)
  assert.deepEqual(connection.sessions.map((session) => session.id), ['session-one', 'session-two'])
  const modes = []
  assert.equal(await runDsh('你好', 'session-two', AbortSignal.timeout(3500), (status) => modes.push(status.mode)), '结果')
  assert.deepEqual(calls, [['prompt', 'session-two', '你好']])
  assert.deepEqual(modes, ['thinking', 'working', 'thinking'])
  const controller = new AbortController()
  const running = runDsh('hold', 'session-two', controller.signal, () => {})
  await clock.accepted.promise
  controller.abort()
  await assert.rejects(running, /abort/i)
  await Promise.race([clock.stopped.promise, sleep(1500).then(() => assert.fail('DSH did not receive cancellation'))])
  assert.deepEqual(calls.at(-1), ['cancel', 'session-two', 'user', true])
  await assert.rejects(runDsh('never rerouted', 'missing', AbortSignal.timeout(3500), () => {}), /所选 DSH 对话已不可用/)

  assert.equal(await runDsh('第一次专用对话', '', AbortSignal.timeout(3500), () => {}), '结果')
  assert.equal(createdSessions, 1)
  assert.equal((await readFile(join(profile, 'bewithu-session.txt'), 'utf8')).trim(), 'session-dedicated')
  assert.equal(await runDsh('第二次专用对话', '', AbortSignal.timeout(3500), () => {}), '结果')
  assert.equal(createdSessions, 1)
})
