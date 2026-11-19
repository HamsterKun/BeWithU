/* 思考模式端到端：请求参数、思考内容展示、服务端不支持时的自动降级 */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9286)
const API = 9287
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}
const jget = async (p) => (await fetch(BASE + p)).json()

const seen = []
const sse = (res, chunks) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    seen.push({ url: req.url, body })
    const reject = req.url?.includes('reject') && body.reasoning_effort !== undefined
    if (reject) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } }))
      return
    }
    const reason = '先想一想：用户在打招呼，正常回应即可。'
    if (body.stream) {
      sse(res, [
        { choices: [{ delta: { reasoning_content: reason } }] },
        { choices: [{ delta: { content: '你好呀，今天想聊点什么？' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ])
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '记事本已经帮你打开了。',
              reasoning_content: reason,
              tool_calls: []
            },
            finish_reason: 'stop'
          }
        ]
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

async function launch(tag, basePath, port) {
  const tmp = join(ROOT, '.shots', `.tmp-think-${tag}`)
  rmSync(tmp, { recursive: true, force: true })
  const ud = join(tmp, 'ud')
  mkdirSync(ud, { recursive: true })
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  })
  let list = null
  for (let i = 0; i < 80 && !list; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    } catch {
      await sleep(400)
    }
  }
  const ball = await Conn.open(list.find((x) => x.type === 'page' && x.url.includes('/ball/')).webSocketDebuggerUrl)
  await sleep(800)
  const jget = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json()
  // 1.0.11 起设置类调用只能在设置窗发起：走气泡 → 设置页
  const admin = await openSettingsWindow({ Conn, jget, sleep, ball })
  await admin.update({
    llm: {
      baseUrl: `http://127.0.0.1:${API}${basePath}`,
      model: 'mock-model',
      apiKey: 'sk-think',
      preset: 'custom',
      thinking: { enabled: true, effort: 'high' }
    }
  })
  await sleep(600)
  return { app, ball, port, tmp, jget, admin, bubble: admin.bubble }
}

let a
let b
try {
  await new Promise((r) => server.listen(API, '127.0.0.1', r))

  // ---------- 1) 聊天：带思考参数 + 折叠展示 ----------
  a = await launch('a', '/v1', PORT)
  let bubble = a.bubble
  await bubble.eval("window.bwu.bubble.submit('你好')")
  await sleep(2500)
  const reqChat = seen.find((x) => x.body?.stream === true)
  ok('chatSendsReasoningEffort', reqChat?.body?.reasoning_effort === 'high', reqChat?.body?.reasoning_effort)

  const thinkText = await bubble.eval("document.querySelector('.think__body')?.textContent || ''")
  const thinkHead = await bubble.eval("document.querySelector('.think__head')?.textContent || ''")
  // 默认折叠，先点开再读
  if (!thinkText) await bubble.eval("document.querySelector('.think__head')?.click()")
  await sleep(300)
  const thinkText2 = await bubble.eval("document.querySelector('.think__body')?.textContent || ''")
  const answer = await bubble.eval("document.querySelector('.row__text--ai')?.textContent || ''")
  ok('thinkBlockShown', /思考过程/.test(thinkHead) && /先想一想/.test(thinkText2), { head: thinkHead, body: thinkText2.slice(0, 40) })
  ok('chatAnswerKept', /你好呀/.test(answer), answer.slice(0, 40))

  // ---------- 2) Agent：非流式也带参数并展示思考 ----------
  await a.admin.update({ agent: { enabled: true } })
  await sleep(600)
  await bubble.eval("window.bwu.bubble.submit('帮我打开记事本')")
  await sleep(2500)
  const reqAgent = seen.find((x) => x.body?.stream === false)
  ok('agentSendsReasoningEffort', reqAgent?.body?.reasoning_effort === 'high', reqAgent?.body?.reasoning_effort)
  const agentAnswer = await bubble.eval("document.querySelector('.row__text--ai')?.textContent || ''")
  ok('agentAnswerKept', /记事本已经帮你打开了/.test(agentAnswer), agentAnswer.slice(0, 40))
  bubble.close()
  try {
    execFileSync('taskkill', ['/PID', String(a.app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}

  // ---------- 3) 服务端不支持时：去掉参数重试，不报错 ----------
  await sleep(1500)
  b = await launch('b', '/reject', PORT + 2)
  const bubble2 = b.bubble
  const before = seen.length
  await bubble2.eval("window.bwu.bubble.submit('你好')")
  await sleep(3000)
  const attempts = seen.slice(before)
  const rejected = attempts.some((x) => x.body?.reasoning_effort !== undefined)
  const retried = attempts.some((x) => x.body?.reasoning_effort === undefined && x.body?.stream === true)
  const answer2 = await bubble2.eval("document.querySelector('.row__text--ai')?.textContent || ''")
  ok('fallsBackWhenRejected', rejected && retried && /你好呀/.test(answer2), {
    rejected,
    retried,
    answer: answer2.slice(0, 40)
  })
  bubble2.close()
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  a?.ball?.close()
  b?.ball?.close()
  for (const inst of [a, b]) {
    if (!inst) continue
    try {
      process.kill(inst.app.pid)
    } catch {}
    await sleep(300)
    try {
      execFileSync('taskkill', ['/PID', String(inst.app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
    } catch {}
  }
  server.close()
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
