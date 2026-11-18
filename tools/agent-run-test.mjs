/* Agent 主循环端到端测试（用 mock LLM，不需要真实 API Key）
 *
 * 覆盖：
 *  1. mock 工具调用 → file.write 真的落盘
 *  2. 高风险操作：拒绝时不执行
 *  3. 高风险操作：允许时执行
 *  4. Shell 未开启时，工具返回"没有权限"的引导语，而不是真的执行
 *  5. 步数上限来自设置（默认 10）
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9271)
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

const tmp = join(ROOT, '.shots', '.tmp-agent-run')
rmSync(tmp, { recursive: true, force: true })
const ud = join(tmp, 'ud')
const work = join(tmp, 'work')
mkdirSync(ud, { recursive: true })
mkdirSync(work, { recursive: true })

const target = join(work, 'note.txt')
const mockFile = join(tmp, 'mock.json')
writeFileSync(
  mockFile,
  JSON.stringify({
    scenarios: {
      写: [
        {
          text: '我来写这个文件。',
          toolCalls: [{ name: 'file.write', args: { path: target, content: '你好，这是 Agent 写入的内容。' } }]
        },
        { text: '已完成：已经把内容写进 note.txt。' }
      ],
      几点: [
        { text: '需要执行命令。', toolCalls: [{ name: 'shell.ps', args: { script: 'Get-Date', purpose: '测试时间' } }] },
        { text: 'Shell 没有开启，我已经提醒你去设置里打开。' }
      ]
    }
  })
)

let app
let ball
try {
  const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  app = spawn(exe, ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      BWU_AGENT_TEST: '1',
      BWU_AGENT_MOCK: mockFile
    }
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

  // 开启 agent + 允许 work 目录
  await ball.eval(
    `window.bwu.settings.update({ llm: { apiKey: 'sk-mock' }, agent: { enabled: true, files: { dirs: ${JSON.stringify([work])} } } })`
  )
  await sleep(600)
  const cfg = await ball.eval('window.bwu.settings.get()')
  ok('agentEnabled', cfg?.agent?.enabled === true && cfg.agent.files.dirs.includes(work), {
    enabled: cfg?.agent?.enabled,
    maxSteps: cfg?.agent?.maxSteps,
    shell: cfg?.agent?.shellEnabled
  })
  ok('defaultMaxSteps', cfg?.agent?.maxSteps === 10, cfg?.agent?.maxSteps)
  ok('shellOffByDefault', cfg?.agent?.shellEnabled === false, cfg?.agent?.shellEnabled)

  const call = (id, args) => ball.eval(`window.bwu.agentTest.call(${JSON.stringify(id)}, ${JSON.stringify(args ?? {})})`)

  // 1) 拒绝高风险：文件不该被写
  const denied = await ball.eval("window.bwu.agentTest.run('帮我写个文件', false)")
  ok(
    'denyBlocksWrite',
    denied?.steps >= 1 && !existsSync(target) && String(denied?.tools?.[0]?.summary || '').includes('拒绝'),
    denied
  )

  // 2) 允许高风险：文件写入成功
  const allowed = await ball.eval("window.bwu.agentTest.run('帮我写个文件', true)")
  const content = existsSync(target) ? readFileSync(target, 'utf8') : ''
  ok(
    'allowWritesFile',
    allowed?.steps >= 1 && content.includes('Agent 写入的内容') && allowed?.tools?.[0]?.ok === true,
    { text: allowed?.text, tools: allowed?.tools, content }
  )

  // 3) Shell 未开启：引导语 + 不执行
  const shellDenied = await ball.eval("window.bwu.agentTest.run('帮我看下现在几点', true)")
  const shellSummary = String(shellDenied?.tools?.[0]?.summary || '')
  ok(
    'shellGuidesUser',
    shellDenied?.tools?.[0]?.ok === false && /没有开启|Agent 能力|Shell/.test(shellSummary),
    shellSummary.slice(0, 120)
  )

  // 4) 工具清单完整
  const tools = await ball.eval('window.bwu.agentTest.list()')
  const ids = (tools || []).map((t) => t.id)
  ok(
    'toolsetComplete',
    ['shell.ps', 'file.read', 'file.write', 'file.list', 'app.launch', 'notify', 'remind', 'web.open', 'input.type'].every((i) =>
      ids.includes(i)
    ),
    ids.length
  )
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
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
