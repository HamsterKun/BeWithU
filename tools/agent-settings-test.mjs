/* Agent 设置页端到端测试 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9276)
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
  async shot(file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
    if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

const tmp = join(ROOT, '.shots', '.tmp-agent-settings')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
const extraDir = join(tmp, '工作目录')
mkdirSync(extraDir, { recursive: true })
const mockFile = join(tmp, 'mock.json')

let app
let ball
let settings
let admin
try {
  writeFileSync(mockFile, JSON.stringify({ responses: [{ text: 'ok' }] }))
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
  // 管理调用只允许设置窗发起：点球出气泡，再从气泡打开设置页的 Agent 标签
  admin = await openSettingsWindow({ Conn, jget, sleep, ball })
  settings = admin.conn
  await admin.update({ llm: { apiKey: 'sk-mock' } })
  await sleep(600)

  const title = await settings.eval("document.querySelector('.main__head h1')?.textContent || ''")
  ok('agentTabOpen', title.includes('Agent'), title)

  // 1) 启用 Agent
  const toggles = await settings.eval("document.querySelectorAll('.pane .toggle').length")
  await settings.eval("document.querySelectorAll('.pane .toggle')[0].click()")
  await sleep(500)
  let cfg = await ball.eval('window.bwu.settings.get()')
  ok('enableAgent', cfg?.agent?.enabled === true, { toggles, enabled: cfg?.agent?.enabled })

  // 2) 开启 Shell
  await settings.eval("document.querySelectorAll('.pane .toggle')[1].click()")
  await sleep(1400)
  cfg = await ball.eval('window.bwu.settings.get()')
  const warn = await settings.eval("Boolean(document.querySelector('.agent-warn'))")
  const aria = await settings.eval("document.querySelectorAll('.pane .toggle')[1]?.getAttribute('aria-checked')")
  ok('enableShell', cfg?.agent?.shellEnabled === true && warn, { shell: cfg?.agent?.shellEnabled, warn, aria })

  // 3) 最大步数改成 12
  await settings.eval(`(() => {
    const input = document.querySelector('.pane .input--num')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '12')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
  })()`)
  await sleep(600)
  cfg = await ball.eval('window.bwu.settings.get()')
  ok('maxStepsEditable', cfg?.agent?.maxSteps === 12, cfg?.agent?.maxSteps)

  // 4) 目录列表（走真实设置接口，选择器用系统对话框无法自动化）
  await admin.update({ agent: { files: { dirs: [extraDir] } } })
  await sleep(800)
  const dirRow = await settings.eval("document.querySelector('.agent-dir__path')?.textContent || ''")
  ok('dirListed', dirRow.includes('工作目录'), dirRow)

  // 5) 工具列表 + 禁用某个工具
  const toolCount = await settings.eval("document.querySelectorAll('.agent-tool').length")
  await settings.eval(`(() => {
    const rows = [...document.querySelectorAll('.agent-tool')]
    const row = rows.find((r) => r.textContent.includes('shell.ps')) || rows[0]
    row.querySelector('.toggle').click()
  })()`)
  await sleep(500)
  cfg = await ball.eval('window.bwu.settings.get()')
  const disabled = cfg?.agent?.disabledTools ?? []
  ok('toolsListed', toolCount >= 19, { toolCount })
  ok('toolTogglePersists', disabled.length === 1, disabled)

  // 6) 运行记录：先调一次工具，再刷新
  await ball.eval("window.bwu.agentTest.call('file.list', { dir: " + JSON.stringify(extraDir) + " })")
  await sleep(500)
  await settings.eval(`(() => {
    const btns = [...document.querySelectorAll('.agent-actions .btn')]
    const refresh = btns.find((b) => b.textContent.includes('刷新'))
    refresh?.click()
  })()`)
  await sleep(700)
  const runCount = await settings.eval("document.querySelectorAll('.agent-run').length")
  ok('runLogShown', runCount >= 1, { runCount })

  await settings.shot(join(ROOT, '.shots', 'settings-agent.png'))
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  settings?.close()
  admin?.bubble.close()
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
