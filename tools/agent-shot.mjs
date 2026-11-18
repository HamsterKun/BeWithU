/* 截两张图：球「工作中」徽标 / 气泡审批卡 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9275
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

const tmp = join(ROOT, '.shots', '.tmp-agent-shot')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
const work = join(tmp, 'work')
mkdirSync(ud, { recursive: true })
mkdirSync(work, { recursive: true })
const mockFile = join(tmp, 'mock.json')
writeFileSync(
  mockFile,
  JSON.stringify({
    scenarios: {
      报表: [
        {
          text: '好的，我把汇总写进报表文件。',
          toolCalls: [{ name: 'file.write', args: { path: join(work, '周报汇总.txt'), content: '本周完成：Agent 能力 M2' } }]
        },
        { text: '已完成：周报汇总写好了。' }
      ]
    }
  })
)

const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BWU_AGENT_TEST: '1', BWU_AGENT_MOCK: mockFile }
})

let ball, bubble
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
  await ball.eval(
    `window.bwu.settings.update({ llm:{apiKey:'sk-mock'}, ui:{muted:true}, tts:{enabled:false}, agent:{enabled:true, files:{dirs:${JSON.stringify([work])}}} })`
  )
  await sleep(600)
  await ball.eval('window.bwu.ball.toggleBubble()')
  await sleep(1200)
  const l2 = await jget('/json')
  bubble = await Conn.open(l2.find((x) => x.type === 'page' && x.url.includes('/bubble/')).webSocketDebuggerUrl)
  await sleep(300)
  await bubble.eval("window.bwu.bubble.submit('帮我把本周报表汇总一下')")
  await sleep(2200)
  await bubble.shot(join(ROOT, '.shots', 'agent-approve.png'))
  await ball.shot(join(ROOT, '.shots', 'agent-ball-working.png'))
  console.log('shots saved')
} finally {
  ball?.close()
  bubble?.close()
  try {
    process.kill(app.pid)
  } catch {}
  await sleep(300)
  try {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
