/* 隔离冒烟测试：用全新的 userData 启动一份构建产物，确认能起来、四个窗口能加载、没有异常日志。
 *
 * 用法：
 *   node tools/smoke-test.mjs                    # 冒烟 out/（先 electron-vite build）
 *   BWU_TEST_EXE=release\win-unpacked\BeWithU.exe node tools/smoke-test.mjs   # 冒烟打包产物
 *
 * 判定：启动日志出现 boot: 就绪（且版本匹配）、渲染页面能连上 CDP、设置页能从气泡打开、
 * 日志里没有 uncaughtException / unhandledRejection / 渲染进程崩溃。结束后删掉临时 userData。
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9299)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

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

const tmp = join(ROOT, '.shots', '.tmp-smoke')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const LOG = join(ud, 'logs', 'app.log')
const logText = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')

const expected = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.BWU_AGENT_MOCK
delete env.BWU_DEMO
env.BWU_AGENT_TEST = '1'

const packaged = process.env.BWU_TEST_EXE
const exe = packaged ?? join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const args = packaged
  ? [`--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`]
  : ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`]

let app
let ball
let admin
try {
  app = spawn(exe, args, { cwd: ROOT, stdio: 'ignore', env })

  let list = null
  for (let i = 0; i < 80 && !list; i++) {
    try {
      list = await jget('/json')
    } catch {
      await sleep(400)
    }
  }
  ok('instanceStarts', Array.isArray(list) && list.length > 0, { pages: (list || []).length, packaged: Boolean(packaged) })

  const log = logText()
  const boot = /boot: 就绪 (.+)$/m.exec(log)
  let bootInfo = null
  try {
    bootInfo = boot ? JSON.parse(boot[1]) : null
  } catch {}
  ok('bootReady', Boolean(bootInfo), bootInfo)
  ok('versionMatches', bootInfo?.version === expected, { expected, actual: bootInfo?.version })

  const urls = (list || []).filter((x) => x.type === 'page').map((x) => x.url)
  ok(
    'renderersLoaded',
    ['/ball/', '/bubble/'].every((p) => urls.some((u) => u.includes(p))),
    urls.map((u) => u.replace(/^.*\/renderer\//, ''))
  )

  ball = await Conn.open(list.find((x) => x.type === 'page' && x.url.includes('/ball/')).webSocketDebuggerUrl)
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(document.querySelector(".stage"))')) break
    await sleep(300)
  }
  ok('ballRendered', await ball.eval('Boolean(document.querySelector(".ball"))'))

  // 从气泡打开设置页：验证按窗口角色的 preload 真的能拿到设置接口
  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'about' })
  const aboutInfo = await admin.conn.eval('window.bwu.settings.appInfo()')
  ok(
    'settingsReachableFromBubble',
    aboutInfo?.version === expected,
    { version: aboutInfo?.version, hotkey: aboutInfo?.hotkeyActive }
  )
  const title = await admin.conn.eval("document.querySelector('.main__head h1')?.textContent || ''")
  ok('settingsPaneRendered', title.length > 0, title)

  const errs = logText()
    .split('\n')
    .filter((l) => /uncaughtException|unhandledRejection|render-process-gone|crash/i.test(l))
  ok('noCrashInLog', errs.length === 0, errs.slice(0, 3))
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  admin?.close()
  try {
    app && process.kill(app.pid)
  } catch {}
  await sleep(500)
  try {
    app && execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  } catch {}
  if (!process.env.BWU_KEEP_SMOKE) rmSync(tmp, { recursive: true, force: true })
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
