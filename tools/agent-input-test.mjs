/* 端到端测试：koffi 键鼠注入（M1）
 *
 * 原理：注入走真实的 user32!SendInput，目标窗口是我们自己的气泡窗口
 * （可稳定取得前台，避免 Windows 前台锁导致的测试不确定性；外部程序的
 *  切换用 tools/input-harness.ps1 手动验证）。
 *
 * 用法：先 build，再 node tools/agent-input-test.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9267)
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
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('cdp timeout ' + method))
      }, 20000)
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

const tmp = join(ROOT, '.shots', '.tmp-agent-input')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const LOG = join(ud, 'logs', 'app.log')
const logText = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
const cnt = (n) => logText().split(n).length - 1

let app
let ball
let bubble
try {
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

  // 占位 Key：避免首次运行引导气泡抢焦点
  await ball.eval("window.bwu.settings.update({ llm: { apiKey: 'sk-agent-input-test' }, bubble: { keepOpen: true } })")
  await sleep(800)

  const call = (id, args) => ball.eval(`window.bwu.agentTest.call(${JSON.stringify(id)}, ${JSON.stringify(args ?? {})})`)

  // 1) 工具注册
  const tools = await ball.eval('window.bwu.agentTest.list()')
  const ids = (tools || []).map((t) => t.id)
  ok(
    'toolsRegistered',
    ['input.type', 'input.key', 'input.click', 'window.focus', 'input.cursor'].every((i) => ids.includes(i)),
    ids
  )

  // 2) 打开气泡，拿到输入框和固定按钮的屏幕坐标
  await ball.eval('window.bwu.ball.toggleBubble()')
  await sleep(1200)
  const l2 = await jget('/json')
  const bubbleTarget = l2.find((x) => x.type === 'page' && x.url.includes('/bubble/'))
  bubble = await Conn.open(bubbleTarget.webSocketDebuggerUrl)
  await sleep(400)
  const geo = await bubble.eval(`(() => {
    const input = document.querySelector('.composer__input')
    const pin = document.querySelector('.card__actions .icon-btn')
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: window.screenX + Math.round(r.x + r.width/2), y: window.screenY + Math.round(r.y + r.height/2) } }
    return { input: rect(input), pin: rect(pin) }
  })()`)
  ok('bubbleGeometry', Boolean(geo?.input && geo?.pin), geo)

  // 预热一次工作进程
  await call('window.foreground', {})
  await sleep(800)

  // 2.5) 鼠标注入自检（连续 3 次采样，重试以避开用户同时操作鼠标）
  let selfTest = null
  for (let i = 0; i < 3; i++) {
    selfTest = await call('input.self_test', { x: 900, y: 500 })
    if (selfTest?.ok) break
    await sleep(400)
  }
  ok('sendInputPath', selfTest?.ok === true, selfTest)

  // 3) 真实鼠标点击输入框 → 应该聚焦输入框（重试几次，避开用户同时在用电脑的干扰）
  let focused = ''
  let clickInput = null
  for (let i = 0; i < 3; i++) {
    clickInput = await call('input.click', { x: geo.input.x, y: geo.input.y })
    await sleep(700)
    focused = await bubble.eval("document.activeElement?.className || ''")
    if (String(focused).includes('composer__input')) break
  }
  ok('mouseClickFocusesInput', clickInput?.ok === true && String(focused).includes('composer__input'), {
    click: clickInput?.summary,
    active: focused
  })

  // 4) 真实键盘输入中文/英文（气泡窗口由我们自己聚焦，避免前台锁）
  await bubble.eval('window.bwu.bubble.requestFocus()')
  await sleep(400)
  let typed = null
  let value = ''
  for (let i = 0; i < 3; i++) {
    await bubble.eval("document.querySelector('.composer__input')?.focus()")
    await sleep(200)
    typed = await call('input.type', { text: '你好 BeWithU 123' })
    await sleep(500)
    value = await bubble.eval("document.querySelector('.composer__input')?.value || ''")
    if (value.includes('你好 BeWithU 123')) break
  }
  const fg = await call('window.foreground', {})
  ok('keyboardType', typed?.ok === true && value.includes('你好 BeWithU 123'), {
    foreground: fg?.data?.title,
    typed: typed?.summary,
    value
  })

  // 5) 组合键：ctrl+a 全选后输入 X
  const sel = await call('input.key', { keys: 'ctrl+a', expectTitle: 'BeWithU Bubble' })
  await call('input.type', { text: 'X', expectTitle: 'BeWithU Bubble' })
  await sleep(500)
  const value2 = await bubble.eval("document.querySelector('.composer__input')?.value || ''")
  ok('keyboardCombo', sel?.ok === true && value2 === 'X', { key: sel?.summary, value: value2 })

  // 6) 鼠标点击固定按钮 → 状态变化
  const pinActive = () => bubble.eval('document.querySelectorAll(".card__actions .icon-btn")[0].className.includes("active")')
  const before = await pinActive()
  const clickPin = await call('input.click', { x: geo.pin.x, y: geo.pin.y })
  await sleep(800)
  const after = await pinActive()
  ok('mouseClickButton', clickPin?.ok === true && before !== after, { before, after, click: clickPin?.summary })

  // 7) 目标窗口校验必须生效
  const guard = await call('input.type', { text: 'should-not-appear', expectTitle: 'NoSuchWindowTitle' })
  ok('expectTitleGuard', guard?.ok === false, guard?.summary)

  // 8) 鼠标位置 / 屏幕信息
  const cur = await call('input.cursor', {})
  const info = await call('input.screen_info', {})
  ok(
    'screenInfo',
    cur?.ok === true && Math.abs(cur.data.x - geo.pin.x) < 60 && info?.ok === true && info.data.width > 0,
    { cursor: cur?.data, virtual: info?.data }
  )

  // 9) 参数校验
  const bad = await call('input.key', { keys: 'nonsense+key+++' })
  ok('invalidKeyRejected', bad?.ok === false, bad?.summary)
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  bubble?.close()
  try {
    app && process.kill(app.pid)
  } catch {}
  await sleep(400)
  try {
    app && execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  } catch {}
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
