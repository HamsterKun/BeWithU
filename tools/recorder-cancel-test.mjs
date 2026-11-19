/* C1：麦克风启动的取消与清理。
 *
 * 用注入的假 getUserMedia / AudioContext / AudioWorkletNode 驱动真实的 Recorder：
 *  1. 启动途中松开（worklet 还没加载完）→ 已拿到的流和上下文必须释放，且不该报"麦克风打不开"
 *  2. getUserMedia 失败 → 上报一次错误，不留下任何上下文
 *  3. worklet 加载失败 → 流与上下文都要释放，并上报错误
 *  4. 失败之后还能正常再启动（没有卡在坏状态里）
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9296)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

async function jget(p) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), 3000)
  try {
    return await (await fetch(BASE + p, { signal: c.signal })).json()
  } finally {
    clearTimeout(t)
  }
}

class Conn {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      const cb = this.pending.get(m.id)
      if (cb) {
        this.pending.delete(m.id)
        cb(m)
      }
    })
  }
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    return new Conn(ws)
  }
  call(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error('eval: ' + r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const tmp = join(ROOT, '.shots', '.tmp-recorder')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const LOG = join(ud, 'logs', 'app.log')
const logText = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')

let app
let ball
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, stdio: 'ignore', env: { ...env, BWU_AGENT_TEST: '1' } }
  )

  let list = null
  for (let i = 0; i < 80 && !list; i++) {
    try {
      list = await jget('/json')
    } catch {
      await sleep(400)
    }
  }
  ball = await Conn.open(list.find((x) => x.type === 'page' && x.url.includes('/ball/')).webSocketDebuggerUrl)
  // 等 React 挂载完成：onRecStart 监听器是挂载时才注册的（preload 桥接更早就有）
  for (let i = 0; i < 60; i++) {
    if (await ball.eval('Boolean(document.querySelector(".stage"))')) break
    await sleep(200)
  }
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(window.bwu && window.bwu.agentTest)')) break
    await sleep(300)
  }

  const injected = await ball.eval(`(() => {
    window.__rec = { gum: 0, ctxs: 0, closed: 0, stopped: 0, live: 0, modules: 0 }
    window.__recCtl = {
      gumFail: null,
      moduleDelay: 0,
      moduleFail: null,
      reset(delay = 0, fail = null, gumFail = null) {
        this.moduleDelay = delay
        this.moduleFail = fail
        this.gumFail = gumFail
      }
    }
    class FakeTrack {
      kind = 'audio'
      stop() { window.__rec.stopped++ }
    }
    class FakeStream {
      getTracks() { return [new FakeTrack()] }
    }
    class FakeAnalyser {
      fftSize = 256
      connect() {}
      disconnect() {}
      getByteTimeDomainData() {}
    }
    class FakeCtx {
      constructor() {
        window.__rec.ctxs++
        window.__rec.live++
        this.state = 'running'
        this.closed = false
        this.audioWorklet = {
          addModule: async () => {
            window.__rec.modules++
            if (window.__recCtl.moduleDelay) await new Promise((r) => setTimeout(r, window.__recCtl.moduleDelay))
            if (window.__recCtl.moduleFail) throw new Error(window.__recCtl.moduleFail)
          }
        }
      }
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createAnalyser() { return new FakeAnalyser() }
      async resume() { this.state = 'running' }
      async close() {
        if (!this.closed) { this.closed = true; window.__rec.closed++; window.__rec.live-- }
      }
    }
    class FakeNode {
      constructor() {
        this.connected = false
        this.port = { postMessage() {}, onmessage: null }
      }
      connect() {}
      disconnect() {}
    }
    class FakeSource {
      connect() {}
      disconnect() {}
    }
    const originalCtx = window.AudioContext
    const originalNode = window.AudioWorkletNode
    window.AudioContext = FakeCtx
    window.AudioWorkletNode = FakeNode
    window.__recRestore = () => {
      window.AudioContext = originalCtx
      window.AudioWorkletNode = originalNode
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.__rec.gum++
          if (window.__recCtl.gumFail) throw new Error(window.__recCtl.gumFail)
          return new FakeStream()
        }
      }
    })
    return true
  })()`)
  ok('fakesInjected', injected === true)

  const snap = () => ball.eval('({...window.__rec})')
  const rec = (action) => ball.eval(`window.bwu.agentTest.rec('${action}')`)

  // 1) 启动途中松开：worklet 还没加载完就 stop
  await ball.eval('window.__recCtl.reset(400, null, null)')
  let before = await snap()
  await rec('start')
  await sleep(80)
  await rec('stop')
  await sleep(900)
  let after = await snap()
  ok(
    'cancelDuringStartReleasesStream',
    after.stopped - before.stopped === 1 && after.closed - before.closed === 1 && after.live === 0,
    { before, after }
  )
  ok('cancelDuringStartIsSilent', !/采集失败/.test(logText()), logText().split('\n').slice(-3))

  // 2) getUserMedia 失败：上报一次，不留上下文
  await ball.eval("window.__recCtl.reset(0, null, 'Permission denied')")
  before = await snap()
  await rec('start')
  await sleep(700)
  after = await snap()
  ok(
    'gumFailureReported',
    /采集失败/.test(logText()) && /Permission denied/.test(logText()) && after.ctxs - before.ctxs === 0,
    logText().split('\n').slice(-2)
  )

  // 3) worklet 加载失败：流和上下文都要释放
  await ball.eval("window.__recCtl.reset(0, 'worklet load failed', null)")
  before = await snap()
  await rec('start')
  await sleep(800)
  after = await snap()
  ok(
    'workletFailureReleasesResources',
    after.stopped - before.stopped === 1 && after.closed - before.closed === 1 && after.live === 0,
    { before, after }
  )
  ok('workletFailureReported', /worklet load failed/.test(logText()))

  // 4) 失败之后还能正常启动、正常停止
  await ball.eval('window.__recCtl.reset(0, null, null)')
  before = await snap()
  await rec('start')
  await sleep(700)
  const started = await snap()
  ok('recoversAfterFailures', started.live === 1 && started.stopped - before.stopped === 0, started)
  await rec('stop')
  await sleep(600)
  after = await snap()
  ok('stopReleasesEverything', after.live === 0 && after.stopped - before.stopped === 1, after)
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  try {
    app && process.kill(app.pid)
  } catch {}
  await sleep(400)
  try {
    app && execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
