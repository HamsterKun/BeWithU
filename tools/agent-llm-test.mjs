/* LLM/工具链路端到端测试（不需要真实 API Key）
 *
 * 本地起一个"严格"的假 OpenAI 兼容服务：
 *  - /ok     ：逐个校验 tools[].function.name 是否匹配 ^[a-zA-Z0-9_-]+$
 *              合法就返回 200 + 一句正文，不合法就照 DeepSeek 的原文返回 400
 *  - /reject ：永远返回 400（验证用户能在气泡里看到错误，而不是"没反应"）
 *
 * 覆盖：
 *  1. 工具名合法（不再带点）→ 模型正常回话，气泡显示正文
 *  2. 模型报错时 → 气泡显示可读的错误，而不是空白
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9275)
const API_PORT = 9276
const TMP = join(ROOT, '.tmp-llm-test')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0

const check = (name, cond, detail) => {
  if (cond) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`)
  }
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.url?.includes('/reject')) {
      return json(400, { error: { message: 'mock: forced failure', type: 'invalid_request_error' } })
    }
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      return json(400, { error: { message: 'bad json' } })
    }
    const tools = payload.tools ?? []
    for (const t of tools) {
      const name = t?.function?.name
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        return json(400, {
          error: {
            message: `Invalid 'tools[0].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`
          }
        })
      }
    }
    json(200, {
      choices: [
        {
          message: {
            content: `链路正常，收到 ${tools.length} 个工具`,
            tool_calls: []
          },
          finish_reason: 'stop'
        }
      ]
    })
  })
})

async function waitTarget(match, timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.type === 'page' && x.url.includes(match))
      if (t) return t
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  throw new Error(`等待页面超时：${match}`)
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
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r))

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BWU_AGENT_MOCK
  // BWU_TEST_EXE 指向打包出来的 exe 时，就用安装包里的代码跑（验证打包产物）
  const exe = process.env.BWU_TEST_EXE
  const cmd = exe ?? join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const args = exe
    ? [`--user-data-dir=${TMP}`, `--remote-debugging-port=${PORT}`]
    : ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${TMP}`, `--remote-debugging-port=${PORT}`]
  const proc = spawn(cmd, args, { cwd: ROOT, env, stdio: 'ignore' })

  const ball = await Conn.open((await waitTarget('ball/index.html')).webSocketDebuggerUrl)
  await sleep(1800)

  // 配置假模型 + 打开 Agent
  await ball.eval(
    `window.bwu.settings.update({ llm: { baseUrl: 'http://127.0.0.1:${API_PORT}/ok', model: 'mock-model', apiKey: 'sk-test', preset: 'custom' }, agent: { enabled: true } }).then(s => s.llm.model)`
  )
  await sleep(600)

  // 打开气泡并输入一句话
  const bubbleTarget = async () => {
    await ball.eval(`window.bwu.ball.click(false)`)
    const t = await waitTarget('bubble/index.html', 8000)
    return Conn.open(t.webSocketDebuggerUrl)
  }
  let bubble = await bubbleTarget()
  await sleep(600)
  await bubble.eval(`window.bwu.bubble.submit('你是谁呀')`)
  await sleep(2500)
  let text = await bubble.eval(`document.body.innerText`)
  check('工具名合法时模型能正常回话', /链路正常/.test(text), text.slice(0, 120))

  // 换成必然 400 的服务，验证气泡里看得到错误
  await ball.eval(
    `window.bwu.settings.update({ llm: { baseUrl: 'http://127.0.0.1:${API_PORT}/reject' } }).then(() => 'ok')`
  )
  await sleep(600)
  await bubble.eval(`window.bwu.bubble.submit('再说一句')`)
  await sleep(2500)
  text = await bubble.eval(`document.body.innerText`)
  check(
    '模型报错时气泡有可读提示',
    /模型调用失败|不支持工具调用|鉴权失败/.test(text),
    text.slice(-160)
  )
  bubble.ws.close()
  ball.ws.close()
  proc.kill()
  await sleep(700)
  rmSync(TMP, { recursive: true, force: true })
  server.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  try {
    server.close()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
