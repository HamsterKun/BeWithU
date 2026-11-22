/* 提示词页：四条内置提示词都可见、可改、可恢复默认；Agent 请求真的用上自定义内容 */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9292)
const API = 9293
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}
const jget = async (p) => (await fetch(BASE + p)).json()

const seen = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    seen.push(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '收到，这是测试回复。', tool_calls: [] }, finish_reason: 'stop' }]
      })
    )
  })
})

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

const tmp = join(ROOT, '.shots', '.tmp-prompts')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })

let app
let ball
let settings
let admin
try {
  await new Promise((r) => server.listen(API, '127.0.0.1', r))
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BWU_AGENT_TEST: '1' }
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
  await sleep(1000)
  // 管理调用只允许设置窗发起：点球出气泡，再从气泡打开设置页的提示词标签
  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'prompt' })
  settings = admin.conn
  await admin.update({
    llm: { baseUrl: `http://127.0.0.1:${API}/v1`, model: 'mock', apiKey: 'sk-p' },
    agent: { enabled: true }
  })
  await sleep(600)

  const cfg0 = await ball.eval('window.bwu.settings.get()')
  ok(
    'promptDefaultsPresent',
    Boolean(cfg0?.prompts?.agent?.includes('{{shell_rule}}')) &&
      !cfg0.prompts.agent.includes('{{max_steps}}') &&
      Boolean(cfg0?.prompts?.closing) &&
      Boolean(cfg0?.prompts?.summary) &&
      Boolean(cfg0?.prompts?.visionNote),
    Object.keys(cfg0?.prompts ?? {})
  )

  // 打开提示词页，确认四个区块都在
  const areas = await settings.eval("document.querySelectorAll('.main__body textarea').length")
  const headings = await settings.eval(
    "Array.from(document.querySelectorAll('.section__head h3')).map(e => e.textContent).join('|')"
  )
  ok('promptSectionsVisible', areas >= 5 && /Agent 提示词/.test(headings) && /上下文压缩提示词/.test(headings), {
    areas,
    headings
  })

  // 改 Agent 提示词 → 触发一次对话 → 请求里的 system 应包含自定义内容
  const marker = '【自定义规则-XYZ】'
  await settings.eval(`(() => {
    const areas = [...document.querySelectorAll('.main__body textarea')]
    const agent = areas[1]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(agent, ${JSON.stringify('你是一个自定义助手。' + marker + ' 最多 {{max_steps}} 步。')})
    agent.dispatchEvent(new Event('input', { bubbles: true }))
    agent.blur()
  })()`)
  await sleep(1200)
  const cfg1 = await ball.eval('window.bwu.settings.get()')
  ok('agentPromptPersisted', String(cfg1?.prompts?.agent).includes(marker), cfg1?.prompts?.agent?.slice(0, 40))

  await admin.bubble.eval("window.bwu.bubble.submit('你好')")
  await sleep(2500)
  const taskRequest = seen.find((body) => body.stream === false && Array.isArray(body.messages))
  const sys = String(taskRequest?.messages?.[0]?.content ?? '')
  ok('agentPromptUsed', sys.includes(marker) && sys.includes('按任务需要调用工具') &&
    !sys.includes('{{max_steps}}'), sys.slice(0, 120))
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  settings?.close()
  admin?.bubble.close()
  try {
    app && process.kill(app.pid)
  } catch {}
  await sleep(300)
  try {
    app && execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  server.close()
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
