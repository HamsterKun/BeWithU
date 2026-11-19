/* Shell 输出编码：中文输出/中文报错不能变成"锟斤拷" */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9285)
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

const tmp = join(ROOT, '.shots', '.tmp-shell-enc')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const mockFile = join(tmp, 'mock.json')
writeFileSync(mockFile, JSON.stringify({ responses: [{ text: 'ok' }] }))

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
  await ball.eval("window.bwu.settings.update({ llm: { apiKey: 'sk-enc' }, agent: { enabled: true, shellEnabled: true } })")
  await sleep(600)

  const call = (id, args) => ball.eval(`window.bwu.agentTest.call(${JSON.stringify(id)}, ${JSON.stringify(args ?? {})})`)

  // 1) 中文 stdout
  const out = await call('shell.ps', { script: 'Write-Output "你好，世界 123"' })
  const outText = String(out?.summary || '')
  ok(
    'stdoutChinese',
    out?.ok === true && outText.includes('你好，世界 123') && !outText.includes('\uFFFD'),
    outText.slice(0, 120)
  )

  // 2) 中文 stderr + 非 0 退出码
  const err = await call('shell.ps', { script: 'Write-Error "出错了：文件不存在"; exit 1' })
  const errText = String(err?.summary || '')
  ok(
    'stderrChinese',
    err?.ok === false && errText.includes('出错了') && !errText.includes('\uFFFD'),
    errText.slice(0, 160)
  )

  // 3) 中文路径/文件名
  const file = join(tmp, '中文文件.txt')
  writeFileSync(file, '内容', 'utf8')
  const ls = await call('shell.ps', { script: `Get-ChildItem "${tmp}" | Where-Object { $_.Name -like '*.txt' } | ForEach-Object { $_.Name }` })
  const lsText = String(ls?.summary || '')
  ok('filenameChinese', lsText.includes('中文文件.txt') && !lsText.includes('\uFFFD'), lsText.slice(0, 120))
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
