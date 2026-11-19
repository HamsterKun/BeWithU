/* 端到端交互测试（真实鼠标事件 + CDP 断言）。
 *
 * 用法：
 *   1) 先构建：node node_modules/electron-vite/bin/electron-vite.js build
 *   2) 直接跑：node tools/app-test.mjs
 *   （脚本会自己启动一个独立配置的实例，结束时关掉；不会动你正在用的数据）
 *
 * 覆盖：默认服务商 / 名字可留空 / 气泡与呼吸光弧的间距 / 点球开关气泡 /
 * 气泡固定与去设置按钮 / 气泡里打字发送 / 拖动悬浮球。
 * 说明：窗口显隐状态用 app.log 断言，因为隐藏窗口的 document.visibilityState 不可靠。 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HELP = join(ROOT, 'tools', 'input-helper.ps1')
const PORT = Number(process.env.CDP_PORT || 9235)
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

const ud = join(ROOT, '.shots', '.tmp-ud-verify')
rmSync(ud, { recursive: true, force: true })
mkdirSync(ud, { recursive: true })
const LOG = join(ud, 'logs', 'app.log')
const logText = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
const cnt = (needle) => logText().split(needle).length - 1

const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
})
console.log('app pid=' + child.pid)

let ball, bubble, settings

/* ---------- 工具 ---------- */
const ballGeom = () => ball.eval('({x:window.screenX,y:window.screenY,w:innerWidth,h:innerHeight})')
const clickBallCenter = async () => {
  const g = await ballGeom()
  ps('click', Math.round(g.x + g.w / 2), Math.round(g.y + g.h / 2))
  await sleep(900)
}
const bubbleVisible = () => cnt('bubble: show') > cnt('bubble: hide')
const ensureBubbleVisible = async () => {
  for (let i = 0; i < 3 && !bubbleVisible(); i++) await clickBallCenter()
  return bubbleVisible()
}
/** 点气泡里的按钮：每次重新读几何，点完等待 */
const clickBubbleControl = async (predicate) => {
  const pos = await bubble.eval(
    `(() => {
      const el = Array.from(document.querySelectorAll("button, .composer__input")).find((b) => (${predicate})(b))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`
  )
  if (!pos) return false
  const origin = await bubble.eval('({x:window.screenX,y:window.screenY})')
  ps('click', Math.round(origin.x + pos.x), Math.round(origin.y + pos.y))
  await sleep(700)
  return true
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
  const by = (p) => list.find((x) => x.type === 'page' && x.url.includes(p))
  ball = await Conn.open(by('/ball/').webSocketDebuggerUrl)
  bubble = await Conn.open(by('/bubble/').webSocketDebuggerUrl)
  for (let i = 0; i < 40; i++) {
    if (await ball.eval('Boolean(document.querySelector(".stage"))')) break
    await sleep(300)
  }
  // 关掉自动收起，避免干扰
  await ball.eval('window.bwu.settings.update({ bubble: { keepOpen: true } })')
  await sleep(600)

  /* 1 默认服务商 + 默认皮肤 + 提示已移除 */
  const s0 = await ball.eval('window.bwu.settings.get()')
  ok('defaultPresetDeepseek', s0.llm.preset === 'deepseek' && s0.llm.model === '', {
    preset: s0.llm.preset,
    model: s0.llm.model
  })
  ok('defaultSkinDafiyu', s0.ball.image === 'builtin:dafiyu', { image: s0.ball.image })
  ok('ballHintRemoved', !(await ball.eval("Boolean(document.querySelector('.hint'))")))

  /* 2 名字可留空 */
  await ball.eval("window.bwu.settings.update({ ui: { assistantName: '' } })")
  await sleep(500)
  const s1 = await ball.eval('window.bwu.settings.get()')
  ok('assistantNameCanBeEmpty', s1.ui.assistantName === '', { name: s1.ui.assistantName })
  ok('bubbleShowsTAWhenUnnamed', (await bubble.eval('document.querySelector(".card__name")?.textContent')) === 'TA')

  /* 3 气泡与呼吸光弧间距 */
  const geom = await ball.eval(
    '({x:window.screenX,y:window.screenY,w:innerWidth,h:innerHeight,size:Number(getComputedStyle(document.querySelector(".stage")).getPropertyValue("--size").replace("px",""))})'
  )
  const cx = Math.round(geom.x + geom.w / 2)
  const cy = Math.round(geom.y + geom.h / 2)
  const bg = await bubble.eval(
    '(() => { const r = document.querySelector(".card").getBoundingClientRect(); return {x:window.screenX,left:r.left,right:r.right} })()'
  )
  const cardLeft = bg.x + bg.left
  const cardRight = bg.x + bg.right
  const ringR = (geom.size / 2 + 13) * 1.12
  const gap = cardRight < cx ? cx - cardRight : cardLeft - cx
  ok('bubbleGapBeyondRing', gap >= ringR - 2, { gap: Math.round(gap), ringR: Math.round(ringR) })

  /* 4 点球开关气泡（日志断言） */
  await ensureBubbleVisible()
  const hide0 = cnt('bubble: hide')
  const show0 = cnt('bubble: show')
  await clickBallCenter()
  const hide1 = cnt('bubble: hide')
  const show1 = cnt('bubble: show')
  await clickBallCenter()
  const show2 = cnt('bubble: show')
  const hide2 = cnt('bubble: hide')
  ok(
    'ballClickToggles',
    hide1 === hide0 + 1 && show1 === show0 && show2 === show1 + 1 && hide2 === hide1,
    { hide0, hide1, show0, show1, show2, hide2 }
  )

  /* 5 气泡按钮 + 打字（先确保显示） */
  await ensureBubbleVisible()
  await sleep(400)
  // 诊断：窗口几何 + 穿透日志
  console.log(
    'DIAG windows:',
    JSON.stringify({
      ball: await ball.eval('({x:window.screenX,y:window.screenY})'),
      bubble: await bubble.eval('({x:window.screenX,y:window.screenY,w:innerWidth,h:innerHeight})'),
      card: await bubble.eval('(() => { const r = document.querySelector(".card").getBoundingClientRect(); return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)} })()'),
      log: logText().trim().split('\n').slice(-6)
    })
  )

  const pinActive = () => bubble.eval('document.querySelectorAll(".card__actions .icon-btn")[0].className.includes("active")')
  await clickBubbleControl('b => b.closest(".card__actions")')
  const pinOn = await pinActive()
  await clickBubbleControl('b => b.closest(".card__actions")')
  const pinOff = await pinActive()
  ok('bubblePinToggles', pinOn === true && pinOff === false, { pinOn, pinOff })

  // 去设置
  const clickedSettings = await clickBubbleControl('b => (b.textContent||"").includes("设置")')
  let openedSettings = false
  if (clickedSettings) {
    for (let i = 0; i < 12 && !openedSettings; i++) {
      await sleep(300)
      const l = await jget('/json')
      if (l.some((x) => x.type === 'page' && x.url.includes('/settings/'))) openedSettings = true
    }
  }
  ok('bubbleSettingsButton', openedSettings)

  /* 5b 设置页：4 套内置皮肤 + Breeze 服务商字段 */
  if (openedSettings) {
    for (let i = 0; i < 12 && !settings; i++) {
      const l = await jget('/json')
      const st = l.find((x) => x.type === 'page' && x.url.includes('/settings/'))
      if (st) settings = await Conn.open(st.webSocketDebuggerUrl)
      else await sleep(300)
    }
    if (settings) {
      await settings.eval("window.bwu.settings.open('ball')")
      await sleep(900)
      const skins = await settings.eval(
        'Array.from(document.querySelectorAll(".swatch span")).map((e) => e.textContent)'
      )
      ok(
        'builtinSkinsFour',
        ['大肥鱼', '大小姐', '极其猫', '龙女仆'].every((n) => skins.includes(n)),
        skins
      )
      // 默认皮肤应该排在第一位
      ok('defaultSkinFirst', skins[0] === '大肥鱼', { first: skins[0], skins })

      await settings.eval("window.bwu.settings.update({ tts: { provider: 'breeze' } })")
      await settings.eval("window.bwu.settings.open('voice')")
      await sleep(900)
      const labels = await settings.eval(
        'Array.from(document.querySelectorAll(".field__label")).map((e) => e.textContent)'
      )
      ok(
        'breezeFieldsVisible',
        labels.some((t) => t.includes('音色 ID')) && labels.some((t) => t.includes('模型')),
        labels.filter((t) => /音色|模型|API/.test(t))
      )
      // 还原成火山，避免影响后续手动使用
      await settings.eval("window.bwu.settings.update({ tts: { provider: 'volc' } })")
    }
  }

  /* 6 打字对话 */
  await ensureBubbleVisible()
  await sleep(400)
  const clickedInput = await clickBubbleControl('el => el.classList.contains("composer__input")')
  await sleep(700)
  const active = await bubble.eval('document.activeElement?.className || ""')
  ok('composerFocus', Boolean(clickedInput) && String(active).includes('composer__input'), active)
  if (clickedInput) {
    await bubble.call('Input.insertText', { text: '在吗' })
    await sleep(300)
    for (const type of ['keyDown', 'keyUp']) {
      await bubble.call('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      })
    }
    await sleep(1600)
    const userText = await bubble.eval('document.querySelector(".row--user .row__text")?.textContent || ""')
    const notice = await bubble.eval('document.querySelector(".notice")?.textContent || ""')
    ok('composerSubmitReachesPipeline', userText.includes('在吗') || notice.length > 0, {
      userText,
      notice: notice.slice(0, 26)
    })
  }

  /* 7 试听互斥：连续触发两次试听都要快速返回（后一次打断前一次，不能排队挂住） */
  const tt0 = Date.now()
  const previews = await Promise.all([
    bubble.eval('window.bwu.settings.testTts()'),
    bubble.eval('window.bwu.settings.testTts()')
  ])
  ok(
    'previewCallsDoNotQueue',
    previews.every((r) => r && typeof r.ok === 'boolean') && Date.now() - tt0 < 10000,
    previews
  )

  /* 8 拖动 */
  const before = await ballGeom()
  ps('drag', cx, cy, 100, 50)
  await sleep(900)
  const after = await ballGeom()
  ok('ballDrag', Math.abs(after.x - before.x) > 20 && Math.abs(after.y - before.y) > 10, { before, after })
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  bubble?.close()
  settings?.close()
  try {
    process.kill(child.pid)
  } catch {}
  await sleep(400)
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  } catch {}
  writeFileSync(join(ROOT, '.shots', 'app-test-result.json'), JSON.stringify(results, null, 2))
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
