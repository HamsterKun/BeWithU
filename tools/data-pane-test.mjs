/* 「数据与日志」页 + 关于页项目卡：页面结构、日志过滤、用量搬迁 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9280)
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

const TMP = join(ROOT, '.shots', '.tmp-data-pane')
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

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'data' })
  const ui = admin.conn

  let title = ''
  for (let i = 0; i < 20; i++) {
    title = await ui.eval("document.querySelector('.main__head h1')?.textContent || ''")
    if (title.includes('数据')) break
    await admin.bubble.eval("window.bwu.settings.open('data')")
    await sleep(400)
  }
  ok('dataTabOpen', title.includes('数据与日志'), title)

  const sections = await ui.eval(
    "Array.from(document.querySelectorAll('.main__body .section__head h3')).map(h => h.textContent)"
  )
  ok('sectionsMoved', ['用量统计', '运行日志', '数据目录'].every((x) => sections.includes(x)), sections)

  const apis = await ui.eval(
    "({ tail: typeof window.bwu.logsTail, dir: typeof window.bwu.logsOpenDir, repo: typeof window.bwu.openRepo })"
  )
  ok('apisExposed', apis.tail === 'function' && apis.dir === 'function' && apis.repo === 'function', apis)

  // 日志应该有内容（应用启动就会写）
  await sleep(800)
  const firstCount = await ui.eval("document.querySelectorAll('.logbox__line').length")
  const meta = await ui.eval("document.querySelector('.log-meta .muted')?.textContent || ''")
  ok('logRendered', firstCount > 0, { lines: firstCount, meta })

  // 时间戳按本地时间渲染成 HH:mm:ss
  const clock = await ui.eval("document.querySelector('.logbox__time')?.textContent || ''")
  ok('logClockFormat', /^\d{2}:\d{2}:\d{2}$/.test(clock), clock)

  // 关键字过滤：不存在的词应该一条都不剩
  await ui.eval(`(() => {
    const input = document.querySelector('.input--search')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'zzz-not-exist-keyword')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(900)
  const emptyCount = await ui.eval("document.querySelectorAll('.logbox__line').length")
  const emptyText = await ui.eval("document.querySelector('.logbox__empty')?.textContent || ''")
  ok('logKeywordFilter', emptyCount === 0 && emptyText.includes('没有匹配'), { emptyCount, emptyText })

  // 清空关键字后恢复
  await ui.eval(`(() => {
    const input = document.querySelector('.input--search')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(900)
  const restored = await ui.eval("document.querySelectorAll('.logbox__line').length")
  ok('logKeywordCleared', restored > 0, restored)

  // 塞一条明确的失败日志，验证级别识别与「只看问题」
  appendFileSync(join(ud, 'logs', 'app.log'), '2026-11-20T06:00:00.000Z llm: http error 401 鉴权失败\n', 'utf8')
  await ui.eval("Array.from(document.querySelectorAll('.main__body .btn')).find(b => b.textContent.trim() === '刷新')?.click()")
  await sleep(900)
  const errorLines = await ui.eval("document.querySelectorAll('.logbox__line.is-error').length")
  const withAll = await ui.eval("document.querySelectorAll('.logbox__line').length")
  ok('logErrorLevel', errorLines >= 1 && withAll > errorLines, { errorLines, withAll })

  await ui.eval("document.querySelector('.log-check input').click()")
  await sleep(900)
  const problems = await ui.eval("document.querySelectorAll('.logbox__line').length")
  const infoLeft = await ui.eval("document.querySelectorAll('.logbox__line.is-info').length")
  ok('logOnlyProblems', problems >= 1 && infoLeft === 0, { all: withAll, problems, infoLeft })

  // 关于页：有项目卡 + 点星入口，且用量统计已经搬走
  await admin.bubble.eval("window.bwu.settings.open('about')")
  await sleep(900)
  const about = await ui.eval(`(() => ({
    repoCard: Boolean(document.querySelector('.repo-card')),
    btn: Array.from(document.querySelectorAll('.repo-card .btn')).map(b => b.textContent.trim()),
    starText: document.querySelector('.repo-card__text p')?.textContent || '',
    hasUsage: Array.from(document.querySelectorAll('.main__body .section__head h3')).some(h => h.textContent.includes('用量'))
  }))()`)
  ok(
    'aboutRepoCard',
    about.repoCard && about.btn.some((t) => t.includes('GitHub')) && about.starText.includes('星星') && about.hasUsage === false,
    about
  )

  // 关于页：开机自启默认开、能关掉并落盘
  const autoLaunch = await ui.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('.main__body .field'))
    const row = rows.find(r => r.textContent.includes('开机自启动'))
    return { has: Boolean(row), on: row?.querySelector('.toggle')?.getAttribute('aria-checked') }
  })()`)
  ok('autoLaunchDefaultOn', autoLaunch.has && autoLaunch.on === 'true', autoLaunch)

  await ui.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('.main__body .field'))
    const row = rows.find(r => r.textContent.includes('开机自启动'))
    row?.querySelector('.toggle')?.click()
  })()`)
  await sleep(900)
  const cfgAuto = await ball.eval('window.bwu.settings.get()')
  ok('autoLaunchTogglePersists', cfgAuto?.ui?.autoLaunch === false, cfgAuto?.ui?.autoLaunch)

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
