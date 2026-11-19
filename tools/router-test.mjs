/* 意图路由单测：Agent 总开关打开后，"聊天"和"干活"要能分开 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9281)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}
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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const tmp = join(ROOT, '.shots', '.tmp-router')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const mockFile = join(tmp, 'mock.json')
writeFileSync(mockFile, JSON.stringify({ responses: [{ text: 'ok' }] }))

const cases = [
  // [用户说, 期望]
  ['今天好累啊，陪我说说话', 'chat'],
  ['你是谁呀', 'chat'],
  ['谢谢你', 'chat'],
  ['讲个笑话', 'chat'],
  ['晚安', 'chat'],
  ['你觉得我今天状态怎么样', 'chat'],
  ['我有点烦，不想干活', 'chat'],
  ['帮我打开记事本', 'task'],
  ['把桌面上的周报汇总成一个表格', 'task'],
  ['查一下明天的天气', 'task'],
  ['十分钟后提醒我喝水', 'task'],
  ['把 D:\\docs\\报告.docx 里的小王改成小李', 'task'],
  ['搜一下 Electron 45 的更新内容', 'task'],
  ['截图看看我现在在干什么', 'task'],
  ['帮我把微信里的文件下载下来', 'task'],
  ['在浏览器里打开 github.com', 'task'],
  ['给这个文件夹里的图片批量重命名', 'task'],
  ['把我刚才写的那段代码保存成 js 文件', 'task']
]

let app
let ball
try {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BWU_AGENT_TEST: '1', BWU_AGENT_MOCK: mockFile }
  })
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

  const wrong = []
  for (const [text, want] of cases) {
    const got = await ball.eval(`window.bwu.agentTest.classify(${JSON.stringify(text)})`)
    if (got?.route !== want) wrong.push({ text, want, got })
  }
  ok('intentRouting', wrong.length === 0, wrong.length ? wrong : `${cases.length} 条全对`)
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  try {
    app && process.kill(app.pid)
  } catch {}
  await sleep(300)
  try {
    app && execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
