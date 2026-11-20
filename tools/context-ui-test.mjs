/* 上下文设置页端到端：三挡切换、时间感知、保留轮数、立即压缩、无摘要正文 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9277)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const ok = (k, cond, detail) => {
  cond ? pass++ : fail++
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

const TMP = join(ROOT, '.shots', '.tmp-context-ui')
rmSync(TMP, { recursive: true, force: true })
const ud = join(TMP, 'ud')
mkdirSync(ud, { recursive: true })

let app
let ball
let admin
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

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'context' })
  const ui = admin.conn

  // 设置窗可能还停在上一个标签：等它切过来，没切就再从气泡发一次 focus
  let title = ''
  for (let i = 0; i < 20; i++) {
    title = await ui.eval("document.querySelector('.main__head h1')?.textContent || ''")
    if (title.includes('上下文')) break
    await admin.bubble.eval("window.bwu.settings.open('context')")
    await sleep(400)
  }
  ok('contextTabOpen', title.includes('上下文'), title)

  // 页面结构：两个 Segmented（档位 / 时间感知）+ 一个占用条
  const shape = await ui.eval(`(() => ({
    segments: document.querySelectorAll('.main__body .segmented').length,
    meter: Boolean(document.querySelector('.main__body .ctx-meter')),
    labels: Array.from(document.querySelectorAll('.main__body .segmented')[0]?.querySelectorAll('button') || []).map(b => b.textContent.trim()),
    inputs: document.querySelectorAll('.main__body .input--num').length
  }))()`)
  ok('contextPaneLayout', shape.segments === 2 && shape.meter && shape.labels.join('') === '低中高', shape)

  // 默认档位是中
  let cfg = await ball.eval('window.bwu.settings.get()')
  ok('defaultLevelMid', cfg?.context?.level === 'mid', cfg?.context)

  // 切到低频：预算数字应该变小
  const budgetText = () => ui.eval("document.querySelector('.main__body .ctx-meter')?.textContent || ''")
  const midText = await budgetText()
  await ui.eval("document.querySelectorAll('.main__body .segmented')[0].querySelectorAll('button')[0].click()")
  await sleep(800)
  cfg = await ball.eval('window.bwu.settings.get()')
  const lowText = await budgetText()
  ok('switchToLow', cfg?.context?.level === 'low' && lowText !== midText, { level: cfg?.context?.level, midText, lowText })

  // 切回中档
  await ui.eval("document.querySelectorAll('.main__body .segmented')[0].querySelectorAll('button')[1].click()")
  await sleep(700)
  cfg = await ball.eval('window.bwu.settings.get()')
  ok('switchBackToMid', cfg?.context?.level === 'mid', cfg?.context?.level)

  // 时间感知：切到「每条消息」
  await ui.eval("document.querySelectorAll('.main__body .segmented')[1].querySelectorAll('button')[2].click()")
  await sleep(700)
  cfg = await ball.eval('window.bwu.settings.get()')
  ok('timeAwarenessFull', cfg?.context?.timeAwareness === 'full', cfg?.context?.timeAwareness)

  // 压缩保留轮数：改成 6
  await ui.eval(`(() => {
    const input = document.querySelectorAll('.main__body .input--num')[1]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '6')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
  })()`)
  await sleep(800)
  cfg = await ball.eval('window.bwu.settings.get()')
  ok('keepRecentTurns', cfg?.context?.keepRecentTurns === 6, cfg?.context?.keepRecentTurns)

  // 没有历史时点「立即压缩」应给出人话
  await ui.eval(`Array.from(document.querySelectorAll('.main__body .btn')).find(b => b.textContent.includes('立即压缩'))?.click()`)
  await sleep(1200)
  const compactMsg = await ui.eval("document.querySelector('.main__body .ctx-result')?.textContent || ''")
  ok('compactWithoutHistory', /还不够压|没有/.test(compactMsg), compactMsg)

  // 摘要不给正文查看：不该有查看按钮或摘要正文块
  const noViewer = await ui.eval(`(() => ({
    viewBtn: Array.from(document.querySelectorAll('.main__body .btn')).some(b => b.textContent.includes('查看')),
    summaryBox: Boolean(document.querySelector('.main__body .summary-box'))
  }))()`)
  ok('summaryNotViewable', noViewer.viewBtn === false && noViewer.summaryBox === false, noViewer)

  // 上下文信息接口可用且自带预算
  const info = await ui.eval('window.bwu.settings.contextInfo()')
  ok('contextInfoApi', Boolean(info) && info.budget > 0 && info.window > 0, {
    budget: info?.budget,
    window: info?.window,
    source: info?.windowSource
  })

  admin.close()
  ball.close()
  app.kill()
  await sleep(600)
  rmSync(TMP, { recursive: true, force: true })
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
}
