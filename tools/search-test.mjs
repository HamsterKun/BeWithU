/* 联网搜索端到端测试（本地假服务，不需要真 Key）
 *
 * 覆盖：
 *  1. 未开启时 web.search 给出"去开启"的引导
 *  2. Tavily 通路：返回标题/链接/摘要
 *  3. DeepSeek Search 通路：返回 title/summary，走 rerank_score
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9277)
const API_PORT = 9278
const TMP = join(ROOT, '.tmp-search-test')
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

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const url = req.url ?? ''
    if (url.startsWith('/tavily/search')) {
      return json(200, {
        results: [
          { title: 'Tavily 结果一号', url: 'https://example.com/a', content: '这是 Tavily 返回的摘要', score: 0.93 }
        ]
      })
    }
    if (url.startsWith('/deepseek/v1/tools/search')) {
      return json(200, {
        results: [
          {
            title: 'DeepSeek 结果一号',
            url: 'https://example.com/b',
            snippet: '短摘要',
            summary: '这是 DeepSeek 的长摘要，适合给模型读',
            content: '正文内容',
            site_name: 'Example',
            rerank_score: 2.4,
            authority: 3
          }
        ]
      })
    }
    json(404, { error: 'not found' })
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

  const env = { ...process.env, BWU_AGENT_TEST: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${TMP}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, stdio: 'ignore' }
  )

  const ball = await Conn.open((await waitTarget('ball/index.html')).webSocketDebuggerUrl)
  await sleep(1800)
  // 搜索设置在「大模型」页；管理调用只能在设置窗发起（1.0.11 的窗口角色收敛）
  const admin = await openSettingsWindow({
    Conn,
    jget: async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(),
    sleep,
    ball,
    tab: 'model'
  })

  // 1) 关闭状态
  let r = JSON.parse(
    await ball.eval(`window.bwu.agentTest.call('web.search', { query: '测试' }).then(r => JSON.stringify(r))`)
  )
  check('未开启时给出引导', r.ok === false && /没有开启/.test(r.summary), r.summary)

  // 2) Tavily
  await admin.update({
    search: {
      enabled: true,
      provider: 'tavily',
      tavilyBaseUrl: `http://127.0.0.1:${API_PORT}/tavily`,
      tavilyApiKey: 'tvly-test'
    }
  })
  await sleep(500)
  r = JSON.parse(
    await ball.eval(`window.bwu.agentTest.call('web.search', { query: '测试' }).then(r => JSON.stringify(r))`)
  )
  check('Tavily 通路可用', r.ok === true && /Tavily 结果一号/.test(r.summary), r.summary.slice(0, 120))

  // 3) DeepSeek
  await admin.update({
    search: {
      provider: 'deepseek',
      deepseekBaseUrl: `http://127.0.0.1:${API_PORT}/deepseek`,
      deepseekApiKey: 'sk-test'
    }
  })
  await sleep(500)
  r = JSON.parse(
    await ball.eval(`window.bwu.agentTest.call('web.search', { query: '测试' }).then(r => JSON.stringify(r))`)
  )
  check('DeepSeek 通路可用', r.ok === true && /DeepSeek 结果一号/.test(r.summary), r.summary.slice(0, 120))
  check('DeepSeek 用量摘要而非短摘要', /长摘要/.test(r.summary), r.summary.slice(0, 160))

  admin.close()
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
