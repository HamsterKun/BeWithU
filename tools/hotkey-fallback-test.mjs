/* C7：按键监听降级时按"切换模式"工作。
 *
 * 用 BWU_HOTKEY_FALLBACK=1（仅测试）强制走 globalShortcut 降级路径，
 * 用户配置仍是"按住说话"，然后模拟两次 down：
 *   - 第一次：开始录音（.stage[data-phase]=listening）
 *   - 第二次：结束录音（不该被"已在录音"忽略，也不该被最短按住时长丢掉）
 * 顺带断言设置页拿到的状态文案与 hotkeyFallback 标记。
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSettingsWindow } from './lib/settings-window.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9295)
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

const tmp = join(ROOT, '.shots', '.tmp-hotkey-fallback')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
mkdirSync(ud, { recursive: true })
// 行为验证需要本地识别模型能就绪：把本机已装的模型文件拷进这个隔离 userData
const installed = join(process.env.APPDATA ?? '', 'BeWithU', 'models', 'sensevoice-2024-07-17')
const modelFiles = ['model.int8.onnx', 'tokens.txt']
const hasModel = modelFiles.every((f) => existsSync(join(installed, f)))
if (hasModel) {
  const target = join(ud, 'models', 'sensevoice-2024-07-17')
  mkdirSync(target, { recursive: true })
  for (const f of modelFiles) copyFileSync(join(installed, f), join(target, f))
}

let app
let ball
let admin
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BWU_AGENT_MOCK
  app = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, stdio: 'ignore', env: { ...env, BWU_AGENT_TEST: '1', BWU_HOTKEY_FALLBACK: '1' } }
  )

  let list = null
  for (let i = 0; i < 80 && !list; i++) {
    try {
      list = await jget('/json')
    } catch {
      await sleep(400)
    }
  }
  ball = await Conn.open(list.find((x) => x.type === 'page' && x.url.includes('/ball/')).webSocketDebuggerUrl)
  for (let i = 0; i < 60; i++) {
    if (await ball.eval('Boolean(document.querySelector(".stage"))')) break
    await sleep(200)
  }

  admin = await openSettingsWindow({ Conn, jget, sleep, ball, tab: 'hotkey' })
  // 用户仍然配着"按住说话"，但监听已降级；快捷键换成键盘组合（降级只认键盘）
  await admin.update({ voice: { mode: 'hold', hotkey: 'Ctrl+Alt+J' } })
  await sleep(800)

  const info = await admin.conn.eval('window.bwu.settings.appInfo()')
  ok('fallbackFlagged', info?.hotkeyFallback === true, {
    fallback: info?.hotkeyFallback,
    active: info?.hotkeyActive,
    message: info?.hotkeyMessage
  })
  ok('fallbackMessage', /降级为切换模式/.test(String(info?.hotkeyMessage ?? '')), info?.hotkeyMessage)

  const model = await admin.conn.eval('window.bwu.settings.asrModelStatus()')
  const ready = model?.state === 'ready'
  if (!ready) {
    console.log(`SKIP 行为验证：本机没装本地识别模型（state=${model?.state}）`)
    ok('toggleBehavior', true, { skipped: true, reason: 'no local asr model' })
  } else {
    const phase = () => ball.eval("document.querySelector('.stage')?.dataset.phase || ''")
    const waitPhase = async (want, ms) => {
      const start = Date.now()
      while (Date.now() - start < ms) {
        if ((await phase()) === want) return true
        await sleep(150)
      }
      return false
    }

    await ball.eval("window.bwu.agentTest.hotkey('down')")
    const listening = await waitPhase('listening', 8000)
    ok('firstPressStarts', listening, { phase: await phase() })

    await sleep(400)
    await ball.eval("window.bwu.agentTest.hotkey('down')")
    let stopped = false
    for (let i = 0; i < 40; i++) {
      if ((await phase()) !== 'listening') {
        stopped = true
        break
      }
      await sleep(150)
    }
    ok('secondPressStops', listening && stopped, { phase: await phase() })
  }
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  admin?.close()
  try {
    app && process.kill(app.pid)
  } catch {}
  await sleep(400)
  try {
    app && execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
  } catch {}
  rmSync(tmp, { recursive: true, force: true })
  const failed = Object.entries(results).filter(([, v]) => !v.pass)
  console.log(`\n通过 ${Object.keys(results).length - failed.length}/${Object.keys(results).length}`)
  process.exit(failed.length ? 1 : 0)
}
