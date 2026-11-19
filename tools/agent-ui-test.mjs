/* Agent 交互端到端测试（mock LLM）
 *
 * 覆盖：
 *  - 提交任务后气泡自动收起；确认时临时出现；确认后再次收起；任务结束弹回
 *  - 球徽标两态：思考中（绿）⇄ 工作中（金）
 *  - 确认卡 / 步骤行 / 落盘 / 结束回 idle
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9272)
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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    return r.result?.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const tmp = join(ROOT, '.shots', '.tmp-agent-ui')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
const work = join(tmp, 'work')
mkdirSync(ud, { recursive: true })
mkdirSync(work, { recursive: true })
const target = join(work, 'ui-note.txt')
const mockFile = join(tmp, 'mock.json')
const LOG = join(ud, 'logs', 'app.log')

writeFileSync(
  mockFile,
  JSON.stringify({
    scenarios: {
      写: [
        {
          text: '好的，我来写。',
          toolCalls: [{ name: 'file_write', args: { path: target, content: 'UI 测试写入的内容' } }]
        },
        { text: '已完成：note 写好了。' }
      ]
    }
  })
)

let app
let ball
let bubble
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

  // 管理调用只能在设置窗发起：点球出气泡 → 气泡打开设置页 → 设置窗写入
  const admin = await openSettingsWindow({ Conn, jget, sleep, ball })
  await admin.update({
    llm: { apiKey: 'sk-mock' },
    ui: { muted: true },
    tts: { enabled: false },
    agent: { enabled: true, files: { dirs: [work] } }
  })
  await sleep(800)
  const call = (id, args) => ball.eval(`window.bwu.agentTest.call(${JSON.stringify(id)}, ${JSON.stringify(args ?? {})})`)
  const bubbleVisible = () => ball.eval('window.bwu.agentTest.bubbleVisible()')

  // 气泡就是设置页的入口窗口，确认它现在还看得见
  bubble = admin.bubble
  if (!(await bubbleVisible())) {
    await ball.eval('window.bwu.ball.toggleBubble()')
    await sleep(1200)
  }
  await sleep(300)

  // 提交任务
  await bubble.eval("window.bwu.bubble.submit('帮我写个文件')")

  // 1) 模型开始调工具时气泡收起（有确认卡时会立刻弹回，所以用日志确认确实收过）
  let hid = false
  for (let i = 0; i < 30; i++) {
    const logText = readFileSync(LOG, 'utf8')
    if ((logText.match(/bubble: hide/g) || []).length >= 1) {
      hid = true
      break
    }
    await sleep(120)
  }
  ok('bubbleAutoHidden', hid)

  // 2) 确认卡出现（气泡临时回来）
  let approveVisible = false
  let detail = ''
  for (let i = 0; i < 40; i++) {
    approveVisible = await bubble.eval("Boolean(document.querySelector('.approve'))")
    detail = await bubble.eval("document.querySelector('.approve__detail')?.textContent || ''")
    if (approveVisible) break
    await sleep(150)
  }
  ok('approveCardShown', approveVisible && detail.includes('ui-note.txt'), detail.slice(0, 80))
  ok('bubbleShownForApprove', (await bubbleVisible()) === true)

  // 3) 步骤行
  const stepText = await bubble.eval("document.querySelector('.card__step-text')?.textContent || ''")
  ok('stepLineShown', /写入/.test(stepText), stepText.trim())

  // 3.5) 新布局：思考/步骤在带上下分割线的 proc 区块里，且左右有缩进
  const layoutInfo = await bubble.eval(`(() => {
    const card = document.querySelector('.card')?.getBoundingClientRect()
    const proc = document.querySelector('.proc')
    const step = document.querySelector('.card__step')?.getBoundingClientRect()
    if (!card || !proc || !step) return null
    const cs = getComputedStyle(proc)
    return {
      top: cs.borderTopWidth,
      bottom: cs.borderBottomWidth,
      insetLeft: Math.round(step.left - card.left),
      insetRight: Math.round(card.right - step.right),
      procWidth: Math.round(proc.getBoundingClientRect().width),
      cardWidth: Math.round(card.width)
    }
  })()`)
  // proc 应该固定在头部下方，不随消息区滚动
  const scrollInfo = await bubble.eval(`(() => {
    const proc = document.querySelector('.proc')
    const body = document.querySelector('.card__body')
    if (!proc || !body) return null
    const before = Math.round(proc.getBoundingClientRect().top)
    body.scrollTop = 9999
    const after = Math.round(proc.getBoundingClientRect().top)
    const scrolled = body.scrollTop > 0
    body.scrollTop = 0
    return { before, after, scrolled }
  })()`)
  // 方案 A：思考/步骤在滚动容器内（跟随消息一起滚）
  const procInBody = await bubble.eval("Boolean(document.querySelector('.proc')?.closest('.card__body'))")
  ok('procInScrollBody', procInBody === true, { procInBody })
  ok('bodyStillScrollable', scrollInfo && scrollInfo.scrolled === true, scrollInfo)

  // 审批卡与上方分割线要有间距
  const gapInfo = await bubble.eval(`(() => {
    const proc = document.querySelector('.proc')?.getBoundingClientRect()
    const card = document.querySelector('.approve')?.getBoundingClientRect()
    if (!proc || !card) return null
    return { gap: Math.round(card.top - proc.bottom) }
  })()`)
  ok('approveSpacing', gapInfo && gapInfo.gap >= 8, gapInfo)

  // 展开思考：卡片高度不超过上限（由消息区压缩承担）
  const thinkOpen = await bubble.eval(`(() => {
    const head = document.querySelector('.think__head')
    head?.click()
    const card = document.querySelector('.card')?.getBoundingClientRect()
    return { h: card ? Math.round(card.height) : 0 }
  })()`)
  await sleep(300)
  const cardH = await bubble.eval("Math.round(document.querySelector('.card')?.getBoundingClientRect().height || 0)")
  ok('thinkExpandNoGrow', cardH <= 520, { cardH, atOpen: thinkOpen })

  const headerLine = await bubble.eval(`(() => {
    const card = document.querySelector('.card')?.getBoundingClientRect()
    const head = document.querySelector('.card__head')
    const step = document.querySelector('.card__step')?.getBoundingClientRect()
    if (!card || !head || !step) return null
    return {
      headBorder: getComputedStyle(head).borderBottomWidth,
      insetLeft: Math.round(step.left - card.left),
      insetRight: Math.round(card.right - step.right)
    }
  })()`)
  ok(
    'headerDividerAndInset',
    headerLine && headerLine.headBorder === '1px' && headerLine.insetLeft >= 10,
    headerLine
  )

  // 4) 徽标：working（金）→ 注入 thinking 看是否变绿
  const badgeClass = await ball.eval("document.querySelector('.work-badge')?.className || ''")
  ok('badgeWorking', /work-badge/.test(badgeClass) && !/is-think/.test(badgeClass), badgeClass)

  await ball.eval("window.bwu.agentTest.progress({ active: true, mode: 'thinking', step: 1, total: 10 })")
  await sleep(400)
  const thinkInfo = await ball.eval(`(() => {
    const el = document.querySelector('.work-badge')
    if (!el) return null
    const text = el.querySelector('.work-badge__text')
    return { cls: el.className, color: text ? getComputedStyle(text).color : '', label: text?.textContent || '' }
  })()`)
  ok(
    'badgeThinkingGreen',
    thinkInfo && /is-think/.test(thinkInfo.cls) && /110, 231, 183/.test(thinkInfo.color) && /思考中/.test(thinkInfo.label),
    thinkInfo
  )

  await ball.eval("window.bwu.agentTest.progress({ active: true, mode: 'working', step: 1, total: 10 })")
  await sleep(400)
  const workInfo = await ball.eval(`(() => {
    const el = document.querySelector('.work-badge')
    if (!el) return null
    const text = el.querySelector('.work-badge__text')
    return { cls: el.className, color: text ? getComputedStyle(text).color : '', label: text?.textContent || '' }
  })()`)
  ok(
    'badgeWorkingGold',
    workInfo && !/is-think/.test(workInfo.cls) && /253, 230, 138/.test(workInfo.color) && /工作中/.test(workInfo.label),
    workInfo
  )

  // 5) 点允许 → 文件写入 + 气泡再次收起
  await bubble.eval("document.querySelector('.approve__ok')?.click()")
  let written = ''
  for (let i = 0; i < 30; i++) {
    written = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (written.includes('UI 测试写入的内容')) break
    await sleep(200)
  }
  ok('approvedAndWritten', written.includes('UI 测试写入的内容'), written.slice(0, 40))
  // mock 的第二轮是瞬时的，气泡可能立刻又弹回来；用日志确认"确认后确实又收了一次"
  const hideCount = (readFileSync(LOG, 'utf8').match(/bubble: hide/g) || []).length
  ok('bubbleHiddenAfterApprove', hideCount >= 2, { hideCount })

  // 6) 结束：气泡弹回来、徽标消失、回到 idle
  let finalPhase = 'acting'
  for (let i = 0; i < 40; i++) {
    finalPhase = await ball.eval("document.querySelector('.stage')?.dataset.phase || ''")
    if (finalPhase === 'idle') break
    await sleep(250)
  }
  const badgeGone = await ball.eval("!document.querySelector('.work-badge')")
  const aiText = await bubble.eval("document.querySelector('.row__text--ai')?.textContent || ''")
  ok('backToIdle', finalPhase === 'idle' && badgeGone, { finalPhase, badgeGone })
  // 任务结束会弹回气泡，但 show 是异步的：轮询几次，避免刚调用就断言
  let shownAfterTask = false
  for (let i = 0; i < 20; i++) {
    if ((await bubbleVisible()) === true) {
      shownAfterTask = true
      break
    }
    await sleep(150)
  }
  ok('bubbleShownAfterTask', shownAfterTask)
  ok('finalReport', /已完成/.test(aiText), aiText.slice(0, 60))

  // 6.5) 置顶看门狗：故意取消置顶，1.5s 内应被拉回
  const dropped = await ball.eval("window.bwu.agentTest.ballTop('drop')")
  let topBack = false
  for (let i = 0; i < 30; i++) {
    await sleep(300)
    if (await ball.eval("window.bwu.agentTest.ballTop('check')")) {
      topBack = true
      break
    }
  }
  ok('ballTopWatchdog', dropped === false && topBack === true, { dropped, topBack })

  // 7) 日志里的 progress 顺序：thinking → working → thinking
  const logText = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  const modes = [...logText.matchAll(/agent: progress (thinking|working)/g)].map((m) => m[1])
  const seq = modes.join('>')
  ok('progressAlternates', /thinking>working>thinking/.test(seq), modes.slice(0, 8).join('>'))
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
