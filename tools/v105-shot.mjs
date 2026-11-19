/* 1.0.5 截图：大模型页（亮色默认 + 思考开关 + 模型名空） */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9291)
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
  async shot(file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
    if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const tmp = join(ROOT, '.shots', '.tmp-shot105')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
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
  await sleep(800)
  await ball.eval("window.bwu.settings.update({ llm: { apiKey: 'sk-shot' } })")
  await sleep(600)
  await ball.eval("window.bwu.settings.open('model')")
  await sleep(1800)
  const list2 = await jget('/json')
  settings = await Conn.open(list2.find((x) => x.type === 'page' && x.url.includes('/settings/')).webSocketDebuggerUrl)
  await sleep(800)
  await settings.eval("document.querySelector('.main__body').scrollTop = 260")
  await sleep(300)
  await settings.shot(join(ROOT, '.shots', 'settings-model-thinking.png'))
  console.log('shot ok')
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
