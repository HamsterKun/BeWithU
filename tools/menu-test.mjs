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
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HELP = join(ROOT, 'tools', 'input-helper.ps1')
const PORT = Number(process.env.CDP_PORT || 9260)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 用命名参数传坐标：负坐标（多屏左侧）当位置参数会被 PowerShell 当成参数名
const ps = (...a) => {
  const [action, ...rest] = a.map(String)
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELP, '-Action', action]
  const names = ['-X', '-Y', '-Dx', '-Dy']
  rest.forEach((v, i) => {
    if (names[i]) args.push(names[i], v)
  })
  execFileSync('powershell', args, { stdio: 'pipe', timeout: 20000 })
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

let ball, menu, admin
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
  // 首次运行会弹引导气泡，而气泡和菜单互斥（弹气泡会收菜单）。
  // 先塞一个占位 Key（管理调用只能在设置窗发起，从气泡进设置页），
  // 等过了首次引导的时间点再把气泡收起来，免得它把菜单顶掉。
  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'model' })
  await admin.update({ llm: { apiKey: 'sk-menu-test' } })
  await sleep(2600)
  await ball.eval('window.bwu.ball.toggleBubble()')
  await sleep(900)
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(document.querySelector(".stage"))')) break
    await sleep(300)
  }

  // 真实鼠标可能被前台的全屏窗口吃掉（悬浮球收不到点击）。
  // 先走真实右键；没反应就退回球窗自己的右键入口——主进程处理路径完全一样，只是少验证一次系统投递。
  let mouseFallbacks = 0
  const openMenu = async (x, y) => {
    const before = cnt('menu: show')
    ps('rclick', x, y)
    await sleep(1400)
    if (cnt('menu: show') > before) return true
    await ball.eval('window.bwu.ball.contextMenu()')
    await sleep(1200)
    mouseFallbacks++
    return false
  }

  // 1 右键球 → 菜单窗口出现
  const c = await ballCenter()
  let realMouseOpen = await openMenu(c.x, c.y)
  const show0 = cnt('menu: show')
  const urls = await targets()
  const menuUrl = urls.find((u) => u.includes('/menu/'))
  ok('menuOpens', Boolean(menuUrl) && show0 >= 1, { menuUrl: Boolean(menuUrl), realMouse: realMouseOpen })
  if (menuUrl) {
    const t = await jget('/json')
    menu = await Conn.open(t.find((x) => x.type === 'page' && x.url.includes('/menu/')).webSocketDebuggerUrl)
    await sleep(900) // 等尺寸上报 + 重新定位完成
    const items = await menu.eval('Array.from(document.querySelectorAll(".menu__item .menu__label")).map(e=>e.textContent)')
    const box = await menu.eval('(() => { const r = document.querySelector(".menu").getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)} })()')
    ok(
      'menuItems',
      items.length >= 7 &&
        ['设置…', '静音', '换皮肤', '退出 BeWithU'].every((k) => items.includes(k)),
      items
    )
    ok('menuSizeSane', box.w >= 150 && box.w <= 260 && box.h >= 240 && box.h <= 400, box)

    // 2 点「静音」→ 生效且菜单关闭
    await sleep(700)
    const pickItem = async (label) => {
      const pt = await menu.eval(
        `(() => { const el = Array.from(document.querySelectorAll(".menu__item")).find(b => b.textContent.includes(${JSON.stringify(label)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), sx: window.screenX, sy: window.screenY } })()`
      )
      if (!pt) return 'missing'
      const pick0 = cnt('menu: pick')
      const waitPick = async () => {
        for (let i = 0; i < 12; i++) {
          await sleep(200)
          if (cnt('menu: pick') > pick0) return true
        }
        return false
      }
      ps('click', pt.sx + pt.x, pt.sy + pt.y)
      if (await waitPick()) return 'mouse'
      // 被前台窗口挡住时，改用菜单页自己的输入管线点同一个位置
      for (const type of ['mousePressed', 'mouseReleased']) {
        await menu.call('Input.dispatchMouseEvent', {
          type,
          x: pt.x,
          y: pt.y,
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1
        })
      }
      mouseFallbacks++
      return (await waitPick()) ? 'cdp' : 'none'
    }
    const pickBefore = cnt('menu: pick')
    const pickedBy = await pickItem('静音')
    const muted = await ball.eval('window.bwu.settings.get().then(s => s.ui.muted)')
    ok('menuItemWorks', muted === true && pickedBy !== 'none' && pickedBy !== 'missing' && cnt('menu: pick') > pickBefore, {
      muted,
      pickedBy,
      pick: cnt('menu: pick'),
      tail: logText().trim().split('\n').slice(-4)
    })
    // 还原静音状态
    await admin.update({ ui: { muted: false } })

    // 3 再右键 → 点远处桌面 → 应该自动关闭（blur）
    await openMenu(c.x, c.y)
    await sleep(400)
    const hide1 = cnt('menu: hide')
    ps('click', 60, 60)
    await sleep(1000)
    let dismissedBy = 'mouse'
    if (cnt('menu: hide') === hide1) {
      // 前台窗口吃掉真实点击时，用一个真实的窗口切换来验证「失焦即收起」
      await admin.conn.call('Page.bringToFront')
      await sleep(800)
      dismissedBy = 'focus-switch'
      mouseFallbacks++
    }
    ok('dismissOnOutsideClick', cnt('menu: hide') > hide1, { before: hide1, after: cnt('menu: hide'), dismissedBy })

    // 4 再右键 → Esc 关闭
    await openMenu(c.x, c.y)
    await sleep(400)
    const hide2 = cnt('menu: hide')
    for (const type of ['keyDown', 'keyUp']) {
      await menu.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    await sleep(800)
    ok('dismissOnEscape', cnt('menu: hide') > hide2, { before: hide2, after: cnt('menu: hide') })
    if (mouseFallbacks) {
      console.log(`（提示：${mouseFallbacks} 次真实鼠标投递被前台窗口挡住，已退回应用内等价入口）`)
    }
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
