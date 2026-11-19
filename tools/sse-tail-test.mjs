/* C8：SSE 尾帧。
 *
 * 服务端如果最后一条 `data:` 之后没有换行符（合法 SSE，很多实现会这么收尾），
 * 旧解析在循环结束时把残余缓冲丢掉，回答/音频尾段就没了。
 * 这里用本地假服务发两种"不带尾换行"的响应（LF 与 CRLF 各一次），
 * 断言气泡里能看到最后那段文字。
 */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9297)
const API = 9298
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

let seen = 0
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    seen++
    const crlf = seen === 2
    const eol = crlf ? '\r\n' : '\n'
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const head = seen === 1 ? '第一段' : '第二段'
    const tail = seen === 1 ? '尾段也在。' : 'CRLF 尾段也在。'
    // 正常事件（带分隔空行）
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: head } }] })}${eol}${eol}`)
    // 关键：最后一条事件不带任何换行，直接结束响应
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tail }, finish_reason: 'stop' }] })}`)
    res.end()
  })
})

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

const tmp = join(ROOT, '.shots', '.tmp-sse-tail')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })

let app
let ball
let admin
try {
  await new Promise((r) => server.listen(API, '127.0.0.1', r))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BWU_AGENT_MOCK
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
  await sleep(800)

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'model' })
  await admin.update({
    llm: { baseUrl: `http://127.0.0.1:${API}/v1`, model: 'sse-tail', apiKey: 'sk-sse', preset: 'custom' },
    agent: { enabled: false }
  })
  await admin.update({ bubble: { keepOpen: true } })
  await sleep(400)

  const bubble = admin.bubble
  const lastAnswer = () =>
    bubble.eval(
      "(() => { const rows = [...document.querySelectorAll('.row__text--ai')]; return rows.length ? rows[rows.length - 1].textContent : '' })()"
    )

  await bubble.eval("window.bwu.bubble.submit('第一条')")
  await sleep(2500)
  const first = String(await lastAnswer())
  ok('lfTailKept', first.includes('第一段') && first.includes('尾段也在。'), first.slice(-40))

  await bubble.eval("window.bwu.bubble.submit('第二条')")
  await sleep(2500)
  const second = String(await lastAnswer())
  ok('crlfTailKept', second.includes('第二段') && second.includes('CRLF 尾段也在。'), second.slice(-40))
  ok('noErrorNotice', !/失败|错误|异常/.test(second), second.slice(0, 80))
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  admin?.close()
  try {
    app && process.kill(app.pid)
  } catch {}
  await sleep(400)
  try {
    app && execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  } catch {}
  server.close()
  if (!process.env.BWU_KEEP_SMOKE) rmSync(tmp, { recursive: true, force: true })
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
