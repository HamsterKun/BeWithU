/* 便携版的更新分支：只检查 + 提示去下载，不下载不安装 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9283)
const API_PORT = Number(process.env.API_PORT || 18789)
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
      const t = setTimeout(() => reject(new Error('cdp timeout ' + method)), 20000)
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

const TMP = join(ROOT, '.shots', '.tmp-update-portable')
rmSync(TMP, { recursive: true, force: true })
const ud = join(TMP, 'ud')
mkdirSync(ud, { recursive: true })

const hits = []
const server = createServer((req, res) => {
  hits.push(String(req.url))
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/HamsterKun/BeWithU/releases' }))
})

let app
let ball
let admin
try {
  await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r))

  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      BWU_AGENT_TEST: '1',
      // 模拟便携版：electron-builder 的 portable 目标会注入这个变量
      PORTABLE_EXECUTABLE_DIR: join(TMP, 'portable'),
      BWU_UPDATE_API: `http://127.0.0.1:${API_PORT}/releases/latest`,
      BWU_UPDATE_DELAY: '800'
    }
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

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'about' })
  const ui = admin.conn

  let banner = null
  for (let i = 0; i < 40; i++) {
    banner = await ui.eval(
      "(() => { const b = document.querySelector('.upd-banner'); return b ? { text: b.innerText, cls: b.className } : null })()"
    )
    if (banner && banner.text.includes('9.9.9')) break
    await sleep(500)
  }
  ok('portableBannerShown', Boolean(banner && banner.text.includes('9.9.9')), banner)
  ok('portableUsesDownloadWording', Boolean(banner && banner.text.includes('点此下载')), banner?.text)

  const status = await ui.eval('window.bwu.update.get()')
  ok('portableFlag', status?.portable === true && status?.kind === 'available', status)
  // 便携版不能下载：接口被保护住，不会误触发安装流程
  const noDownload = await ui.eval("window.bwu.update.download().then(s => s.kind)")
  ok('portableCannotDownload', noDownload === 'available', noDownload)
  ok('apiHit', hits.some((u) => u.includes('/releases/latest')), hits)

  admin.close()
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
