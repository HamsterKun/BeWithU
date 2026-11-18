/* Agent 交互端到端测试（mock LLM）：气泡审批卡 + 球「工作中」+ 步骤行
 *
 * 覆盖：提交任务 → 球进入 acting 并显示 💬 工作中… → 气泡弹确认卡 →
 *      点允许 → 文件真的写入 → 结束回到 idle、徽标消失
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

writeFileSync(
  mockFile,
  JSON.stringify({
    scenarios: {
      写: [
        {
          text: '好的，我来写。',
          toolCalls: [{ name: 'file.write', args: { path: target, content: 'UI 测试写入的内容' } }]
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

  await ball.eval(
    `window.bwu.settings.update({
      llm: { apiKey: 'sk-mock' },
      ui: { muted: true },
      tts: { enabled: false },
      agent: { enabled: true, files: { dirs: ${JSON.stringify([work])} } }
    })`
  )
  await sleep(700)

  // 打开气泡
  await ball.eval('window.bwu.ball.toggleBubble()')
  await sleep(1200)
  const l2 = await jget('/json')
  bubble = await Conn.open(l2.find((x) => x.type === 'page' && x.url.includes('/bubble/')).webSocketDebuggerUrl)
  await sleep(300)

  // 提交任务
  await bubble.eval("window.bwu.bubble.submit('帮我写个文件')")

  // 球进入 acting + 徽标
  let badge = null
  let phase = ''
  for (let i = 0; i < 30; i++) {
    phase = await ball.eval("document.querySelector('.stage')?.dataset.phase || ''")
    badge = await ball.eval("document.querySelector('.work-badge')?.textContent || ''")
    if (phase === 'acting' && badge) break
    await sleep(200)
  }
  ok('ballActing', phase === 'acting' && /工作中/.test(badge), { phase, badge })

  // 气泡里出现确认卡
  let approveVisible = false
  let detail = ''
  for (let i = 0; i < 30; i++) {
    approveVisible = await bubble.eval("Boolean(document.querySelector('.approve'))")
    detail = await bubble.eval("document.querySelector('.approve__detail')?.textContent || ''")
    if (approveVisible) break
    await sleep(200)
  }
  ok('approveCardShown', approveVisible && detail.includes('ui-note.txt'), detail.slice(0, 80))

  // 步骤行
  const stepText = await bubble.eval("document.querySelector('.card__step-text')?.textContent || ''")
  ok('stepLineShown', /写入/.test(stepText), stepText.trim())

  // 点允许
  await bubble.eval("document.querySelector('.approve__ok')?.click()")
  let written = ''
  for (let i = 0; i < 30; i++) {
    written = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (written.includes('UI 测试写入的内容')) break
    await sleep(200)
  }
  ok('approvedAndWritten', written.includes('UI 测试写入的内容'), written.slice(0, 40))

  // 结束：徽标消失、回到 idle、气泡显示汇报
  let finalPhase = 'acting'
  for (let i = 0; i < 40; i++) {
    finalPhase = await ball.eval("document.querySelector('.stage')?.dataset.phase || ''")
    if (finalPhase === 'idle') break
    await sleep(250)
  }
  const badgeGone = await ball.eval("!document.querySelector('.work-badge')")
  const aiText = await bubble.eval("document.querySelector('.row__text--ai')?.textContent || ''")
  ok('backToIdle', finalPhase === 'idle' && badgeGone, { finalPhase, badgeGone })
  ok('finalReport', /已完成/.test(aiText), aiText.slice(0, 60))
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
