/* 1.0.3 改动截图：亮色 Agent 页对比度 + 徽标两态 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9283)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jget = async (p) => (await fetch(BASE + p)).json()

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
    await new Promise((res) => ws.addEventListener('open', res, { once: true }))
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
    return r.result?.result?.value
  }
  async shot(file, clip) {
    const r = await this.call('Page.captureScreenshot', { format: 'png', fromSurface: true, ...(clip ? { clip } : {}) })
    if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const tmp = join(ROOT, '.shots', '.tmp-v103-shot')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })

const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BWU_AGENT_TEST: '1' }
})

let ball, settings
try {
  let list = null
  for (let i = 0; i < 80 && !list; i++) {
    try {
      list = await jget('/json')
    } catch {
      await sleep(400)
    }
  }
  ball = await Conn.open(list.find((x) => x.type === 'page' && x.url.includes('/ball/')).webSocketDebuggerUrl)
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(window.bwu && window.bwu.agentTest)')) break
    await sleep(300)
  }
  await ball.eval("window.bwu.settings.update({ llm: { apiKey: 'sk-shot' }, ui: { theme: 'light' } })")
  await sleep(800)
  await ball.eval("window.bwu.settings.open('agent')")
  await sleep(2000)

  const list2 = await jget('/json')
  settings = await Conn.open(list2.find((x) => x.type === 'page' && x.url.includes('/settings/')).webSocketDebuggerUrl)
  await sleep(800)
  // 滚到工具区
  await settings.eval("document.querySelector('.main__body').scrollTop = 520")
  await sleep(400)
  await settings.shot(join(ROOT, '.shots', 'settings-agent-light.png'))

  // 徽标两态
  await ball.eval("window.bwu.agentTest.progress({ active: true, mode: 'thinking', step: 1, total: 10 })")
  await sleep(500)
  await ball.shot(join(ROOT, '.shots', 'badge-thinking.png'))
  await ball.eval("window.bwu.agentTest.progress({ active: true, mode: 'working', step: 3, total: 10 })")
  await sleep(500)
  await ball.shot(join(ROOT, '.shots', 'badge-working.png'))
  console.log('shots ok')
} finally {
  ball?.close()
  settings?.close()
  try {
    process.kill(app.pid)
  } catch {}
  await sleep(300)
  try {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
