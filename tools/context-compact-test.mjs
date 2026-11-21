/* 上下文压缩端到端：本地假 SSE 服务端，验证"水位触发→压缩→摘要进入下一轮"
 *
 * 不依赖任何真实 API：起一个 http 服务充当 OpenAI 兼容端点，
 * 记录每次请求体，最后断言摘要真的被注入到后续请求里。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const useAgent = process.argv.includes('--agent')
const PORT = Number(process.env.CDP_PORT || 9279)
const LLM_PORT = Number(process.env.FAKE_LLM_PORT || 18787)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const ok = (k, cond, detail) => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✓' : '✗'} ${k}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
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
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    return new Conn(ws)
  }
  call(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp timeout ' + method)), 25000)
      this.pending.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error('eval: ' + (ex.exception?.description || ex.text || 'unknown'))
    return r.result?.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/** 假 LLM：普通对话回一段长文本（快速把水位顶上去），压缩请求回摘要 */
const requests = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {}
    requests.push(parsed)
    const text = JSON.stringify(parsed.messages ?? '')
    const isSummary = text.includes('【新增对话】')
    const reply = isSummary
      ? '他在测试上下文压缩。他说了四句话，助手回了四句。正在做的是验证压缩能否自动触发。【关键事实】测试用户 4 轮对话；结论：压缩已生效。'
      : '好'.repeat(600)
    const promptTokens = Math.max(1, Math.round(text.length / 3))
    if (parsed.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: promptTokens } }))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const chunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    chunk({ choices: [{ delta: { content: reply } }] })
    chunk({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 20 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

const TMP = join(ROOT, '.shots', '.tmp-context-compact')
rmSync(TMP, { recursive: true, force: true })
const ud = join(TMP, 'ud')
mkdirSync(ud, { recursive: true })

let app
let ball
let admin
try {
  await new Promise((r) => server.listen(LLM_PORT, '127.0.0.1', r))

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
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(window.bwu && window.bwu.agentTest)')) break
    await sleep(300)
  }

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'context' })
  // 小窗口 + 低档 + 只留 1 轮：两三句话就该到水位
  await admin.update({
    llm: { baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: 'sk-fake', model: 'fake-chat', temperature: 0.2 },
    context: { level: 'low', modelWindow: 9000, keepRecentTurns: 1, timeAwareness: 'current' },
    tts: { enabled: false },
    agent: { enabled: useAgent }
  })
  await sleep(500)

  const bubbleTarget = (await jget('/json')).find((x) => x.type === 'page' && x.url.includes('/bubble/'))
  const bubble = await Conn.open(bubbleTarget.webSocketDebuggerUrl)
  await sleep(300)
  await bubble.eval("window.bwu.settings.update({ bubble: { keepOpen: true } })").catch(() => {})
  await sleep(300)

  // 聊 5 轮，逼出压缩
  for (let i = 1; i <= 5; i++) {
    await bubble.eval(`window.bwu.bubble.submit(${JSON.stringify(`第 ${i} 句话，测试上下文压缩能不能触发`)} )`)
    await sleep(2200)
  }
  await sleep(2500)
  // 压缩发生在上一轮回答之后，这里再问一句，验证摘要真的进入了新请求
  await bubble.eval(`window.bwu.bubble.submit('压缩之后我再说一句')`)
  await sleep(2500)

  const info = await admin.conn.eval('window.bwu.settings.contextInfo()')
  ok('compactTriggered', (info?.compressions ?? 0) >= 1, {
    compressions: info?.compressions,
    used: info?.used,
    budget: info?.budget,
    used: info?.used,
    budget: info?.budget,
    archived: info?.archived,
    summaryChars: info?.summaryChars,
    before: info?.lastBefore,
    after: info?.lastAfter
  })
  ok('summaryHasText', (info?.summaryChars ?? 0) > 0, info?.summaryChars)
  ok('cursorAdvanced', (info?.archived ?? 0) > 0, info?.archived)
  ok('shrank', (info?.lastAfter ?? 0) < (info?.lastBefore ?? 0), {
    before: info?.lastBefore,
    after: info?.lastAfter
  })

  // 压缩之后至少要有一个请求带着摘要块（说明摘要真的被注入了）
  const withSummary = requests.filter((r) => JSON.stringify(r.messages ?? '').includes('【更早的对话摘要】'))
  ok('summaryInjected', withSummary.length > 0, { requests: requests.length, withSummary: withSummary.length })

  // current 模式：历史消息不带时间戳（只有本轮那条带"[现在 …]"），避免每轮重算前缀
  const last = requests.findLast((request) => {
    const text = JSON.stringify(request.messages ?? [])
    return text.includes('压缩之后我再说一句') && !text.includes('【新增对话】')
  })
  const historyText = JSON.stringify(last?.messages ?? [])
  const stamps = (historyText.match(/\[\d\d-\d\d \d\d:\d\d\]/g) ?? []).length
  ok('historyHasNoPerTurnStamp', stamps === 0 && historyText.includes('[现在 '), { stamps, sample: historyText.slice(0, 100) })

  admin.close()
  bubble.close()
  ball.close()
  app.kill()
  await sleep(600)
  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
} catch (e) {
  console.error('✗ fatal', e instanceof Error ? e.message : e)
  try {
    admin?.close()
    ball?.close()
    app?.kill()
  } catch {}
  console.log(`\n通过 ${pass}/${pass + fail}`)
  process.exit(1)
} finally {
  server.close()
  rmSync(TMP, { recursive: true, force: true })
}
