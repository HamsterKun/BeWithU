/* 端到端测试：悬浮球右键菜单（自绘窗口）
 *
 * 用法：先 build，再 node tools/menu-test.mjs
 * 覆盖：能弹出 / 菜单项数量与文案 / 窗口尺寸合理 / 点菜单项生效并关闭 /
 *       点别处自动关闭 / Esc 关闭。
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HELP = join(ROOT, 'tools', 'input-helper.ps1')
const PORT = Number(process.env.CDP_PORT || 9260)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ps = (...a) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELP, ...a.map(String)], {
    stdio: 'pipe',
    timeout: 20000
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
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('cdp timeout ' + method))
      }, 5000)
      this.pending.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
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

const results = {}
const ok = (k, cond, detail) => {
  results[k] = { pass: Boolean(cond), detail }
  console.log(`${cond ? '✓' : '✗'} ${k} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

const ud = join(ROOT, '.shots', '.tmp-ud-menu')
rmSync(ud, { recursive: true, force: true })
mkdirSync(ud, { recursive: true })
const LOG = join(ud, 'logs', 'app.log')
const logText = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
const cnt = (n) => logText().split(n).length - 1

const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
})

let ball, menu
const ballCenter = async () => {
  const g = await ball.eval('({x:window.screenX,y:window.screenY,w:innerWidth,h:innerHeight})')
  return { x: Math.round(g.x + g.w / 2), y: Math.round(g.y + g.h / 2) }
}
const targets = async () => {
  const l = await jget('/json')
  return l.filter((x) => x.type === 'page').map((x) => x.url)
}

try {
  let list = null
  for (let i = 0; i < 60 && !list; i++) {
    try {
      list = await jget('/json')
    } catch {
      await sleep(400)
    }
  }
  ball = await Conn.open(list.find((x) => x.type === 'page' && x.url.includes('/ball/')).webSocketDebuggerUrl)
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(document.querySelector(".stage"))')) break
    await sleep(300)
  }

  // 1 右键球 → 菜单窗口出现
  const c = await ballCenter()
  const show0 = cnt('menu: show')
  ps('rclick', c.x, c.y)
  await sleep(1200)
  const urls = await targets()
  const menuUrl = urls.find((u) => u.includes('/menu/'))
  ok('menuOpens', Boolean(menuUrl) && cnt('menu: show') === show0 + 1, { menuUrl: Boolean(menuUrl) })
  if (menuUrl) {
    const t = await jget('/json')
    menu = await Conn.open(t.find((x) => x.type === 'page' && x.url.includes('/menu/')).webSocketDebuggerUrl)
    await sleep(900) // 等尺寸上报 + 重新定位完成
    const items = await menu.eval('Array.from(document.querySelectorAll(".menu__item .menu__label")).map(e=>e.textContent)')
    const box = await menu.eval('(() => { const r = document.querySelector(".menu").getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)} })()')
    ok('menuItems', items.length === 7 && items.includes('设置…') && items.includes('静音'), items)
    ok('menuSizeSane', box.w >= 150 && box.w <= 260 && box.h >= 240 && box.h <= 400, box)

    // 2 点「静音」→ 生效且菜单关闭
    await sleep(700)
    const hit = await menu.eval(
      '(() => { const el = Array.from(document.querySelectorAll(".menu__item")).find(b => b.textContent.includes("静音")); const r = el.getBoundingClientRect(); return {x: window.screenX + Math.round(r.x + r.width/2), y: window.screenY + Math.round(r.y + r.height/2)} })()'
    )
    const hide0 = cnt('menu: hide')
    ps('click', hit.x, hit.y)
    await sleep(900)
    const muted = await ball.eval('window.bwu.settings.get().then(s => s.ui.muted)')
    ok('menuItemWorks', muted === true && cnt('menu: hide') > hide0, {
      muted,
      hit,
      pick: cnt('menu: pick'),
      tail: logText().trim().split('\n').slice(-4)
    })
    // 还原静音状态
    await ball.eval('window.bwu.settings.update({ ui: { muted: false } })')

    // 3 再右键 → 点远处桌面 → 应该自动关闭（blur）
    ps('rclick', c.x, c.y)
    await sleep(1000)
    const hide1 = cnt('menu: hide')
    ps('click', 60, 60)
    await sleep(1000)
    ok('dismissOnOutsideClick', cnt('menu: hide') > hide1, { before: hide1, after: cnt('menu: hide') })

    // 4 再右键 → Esc 关闭
    ps('rclick', c.x, c.y)
    await sleep(1000)
    const hide2 = cnt('menu: hide')
    for (const type of ['keyDown', 'keyUp']) {
      await menu.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    await sleep(800)
    ok('dismissOnEscape', cnt('menu: hide') > hide2, { before: hide2, after: cnt('menu: hide') })
  }
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  menu?.close()
  try {
    process.kill(child.pid)
  } catch {}
  await sleep(400)
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  } catch {}
  console.log('--- 日志尾部 ---' + String.fromCharCode(10) + logText().trim().split(String.fromCharCode(10)).slice(-12).join(String.fromCharCode(10)))
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
