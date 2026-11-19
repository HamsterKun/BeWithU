/* B4：本机落盘的隐私口径（真实 Electron + 真实 safeStorage）。
 *
 *  1. 聊一句之后，history.json 必须是密文（BWU1: 前缀），明文里搜不到这句话
 *  2. 默认审计只写元数据：没有 summary / argsPreview，只有工具名、参数字节数、耗时
 *  3. 打开「详细审计」后，同一工具调用会带上脱敏后的摘要与参数片段
 */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9294)
const API = 9293
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '在的，你说。' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
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

const tmp = join(ROOT, '.shots', '.tmp-privacy-at-rest')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const auditDir = join(ud, 'agent', 'runs')
const auditEntries = () => {
  if (!existsSync(auditDir)) return []
  return readdirSync(auditDir)
    .filter((n) => n.endsWith('.jsonl'))
    .flatMap((n) =>
      readFileSync(join(auditDir, n), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    )
}

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
  for (let i = 0; i < 60; i++) {
    if (await ball.eval('Boolean(document.querySelector(".stage"))')) break
    await sleep(200)
  }

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'model' })
  await admin.update({
    llm: { baseUrl: `http://127.0.0.1:${API}/v1`, model: 'mock', apiKey: 'sk-privacy', preset: 'custom' },
    agent: { enabled: false, audit: true, auditDetail: false, files: { dirs: [ud] } }
  })
  await admin.update({ bubble: { keepOpen: true } })
  await sleep(400)

  // 1) 聊一句 → 历史必须是密文
  await admin.bubble.eval("window.bwu.bubble.submit('这是一句会被记进历史的话')")
  await sleep(2500)
  const histPath = join(ud, 'history.json')
  const hist = existsSync(histPath) ? readFileSync(histPath, 'utf8') : ''
  ok('historyEncrypted', hist.startsWith('BWU1:'), hist.slice(0, 12))
  ok('historyNoPlaintext', hist.length > 0 && !hist.includes('这是一句会被记进历史的话'), hist.length)

  // 2) 默认审计：只记元数据
  await ball.eval("window.bwu.agentTest.call('file.list', { dir: " + JSON.stringify(ud) + " })")
  await sleep(600)
  let entries = auditEntries()
  const meta = entries.at(-1)
  ok(
    'auditMetadataOnly',
    Boolean(meta) && meta.toolId === 'file.list' && meta.summary === undefined && meta.argsPreview === undefined,
    meta
  )
  ok('auditHasKeysAndBytes', Boolean(meta?.argsKeys?.includes('dir')) && Number(meta?.argsBytes) > 0, meta?.argsKeys)

  // 3) 打开详细审计 → 有摘要与参数片段
  await admin.update({ agent: { auditDetail: true } })
  await sleep(400)
  await ball.eval("window.bwu.agentTest.call('file.list', { dir: " + JSON.stringify(ud) + " })")
  await sleep(600)
  entries = auditEntries()
  const detail = entries.at(-1)
  ok(
    'auditDetailWritesSummary',
    Boolean(detail) && typeof detail.summary === 'string' && detail.summary.length > 0 && typeof detail.argsPreview === 'string',
    { summary: String(detail?.summary ?? '').slice(0, 40), argsPreview: String(detail?.argsPreview ?? '').slice(0, 80) }
  )
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
  rmSync(tmp, { recursive: true, force: true })
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
