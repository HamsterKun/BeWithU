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

async function waitForBubble() {
  for (let i = 0; i < 30; i++) {
    const list = await jget('/json')
    const target = list.find((x) => x.type === 'page' && x.url.includes('/bubble/'))
    if (target) return target
    await sleep(200)
  }
  throw new Error('bubble window did not open')
}

async function waitForSettings() {
  for (let i = 0; i < 30; i++) {
    const list = await jget('/json')
    const target = list.find((x) => x.type === 'page' && x.url.includes('/settings/'))
    if (target) return target
    await sleep(200)
  }
  throw new Error('settings window did not open')
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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
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
const delayedTarget = join(work, 'delayed-note.txt')
const delayedWrite = {
  name: 'delay',
  args: { seconds: 0.12, then: { name: 'file_write', arguments: { path: delayedTarget, content: '延时后写入' } } }
}
const mockFile = join(tmp, 'mock.json')
writeFileSync(
  mockFile,
  JSON.stringify({
    scenarios: {
      写: [
        {
          text: '我来写这个文件。',
          toolCalls: [{ name: 'file_write', args: { path: target, content: '你好，这是 Agent 写入的内容。' } }]
        },
        { text: '已完成：已经把内容写进 note.txt。' }
      ],
      denyBatch: [
        { toolCalls: [
          { name: 'file_write', args: { path: target, content: '不应写入' } },
          { name: 'file_read', args: { path: target } }
        ] },
        { text: '拒绝后不应继续请求模型。' }
      ],
      几点: [
        { text: '需要执行命令。', toolCalls: [{ name: 'shell_ps', args: { script: 'Get-Date', purpose: '测试时间' } }] },
        { text: 'Shell 没有开启，我已经提醒你去设置里打开。' }
      ],
      预算: [
        { text: '执行多个安全工具。', toolCalls: Array.from({ length: 5 }, (_, i) => ({ name: 'notify', args: { title: `budget-${i}`, body: 'budget test' } })) },
        { text: '预算结束。' }
      ],
      未知: [
        { text: '执行未开放工具。', toolCalls: [{ name: 'not_in_this_turn', args: {} }] },
        { text: '未知工具已拒绝。' }
      ],
      delaySequence: [
        { toolCalls: [
          delayedWrite,
          { name: 'file_read', args: { path: delayedTarget } },
          { name: 'file_read', args: { path: delayedTarget } }
        ] },
        { text: '延时流程完成。' }
      ],
      delayApproval: [
        { toolCalls: [delayedWrite, { name: 'file_read', args: { path: delayedTarget } }] },
        { text: '延时后续工具需确认。' }
      ],
      disabledFollowUp: [
        { toolCalls: [
          { name: 'delay', args: { seconds: 0.1, then: { name: 'file_write', arguments: { path: delayedTarget, content: '不应写入' } } } }
        ] },
        { text: '延时流程结束。' }
      ],
      delayAlone: [
        { toolCalls: [{ name: 'delay', args: { seconds: 0.12 } }] },
        { text: '等待完成。' }
      ]
    }
  })
)

let app
let ball
let bubble
let settings
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

  // 管理设置只允许设置窗口发起；通过气泡公开的入口打开设置页。
  await ball.eval('window.bwu.ball.click(false)')
  const bubbleTarget = await waitForBubble()
  bubble = await Conn.open(bubbleTarget.webSocketDebuggerUrl)
  await bubble.eval("window.bwu.settings.open('agent')")
  const settingsTarget = await waitForSettings()
  settings = await Conn.open(settingsTarget.webSocketDebuggerUrl)
  await settings.eval(
    `window.bwu.settings.update({ llm: { apiKey: 'sk-mock' }, agent: { enabled: true, files: { dirs: ${JSON.stringify([work])} } } })`
  )
  await sleep(600)
  await settings.eval("window.bwu.settings.update({ agent: { maxSteps: 3 } })")
  const cfg = await settings.eval('window.bwu.settings.get()')
  ok('agentEnabled', cfg?.agent?.enabled === true && cfg.agent.files.dirs.includes(work), {
    enabled: cfg?.agent?.enabled,
    maxSteps: cfg?.agent?.maxSteps,
    shell: cfg?.agent?.shellEnabled
  })
  ok('maxStepsCanBeConfigured', cfg?.agent?.maxSteps === 3, cfg?.agent?.maxSteps)
  ok('shellOffByDefault', cfg?.agent?.shellEnabled === false, cfg?.agent?.shellEnabled)

  const call = (id, args) => ball.eval(`window.bwu.agentTest.call(${JSON.stringify(id)}, ${JSON.stringify(args ?? {})})`)

  // 1) 拒绝高风险：文件不该被写
  const denied = await ball.eval("window.bwu.agentTest.run('denyBatch', false)")
  ok(
    'denyStopsBatchAndModel',
    denied?.stopped && denied.steps === 1 && denied.tools.length === 1 && !existsSync(target) &&
      denied.tools[0].summary.includes('拒绝') && denied.text === '操作未获确认，已停止这次任务。',
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

  // 2.5) 中间轮的过程叙述不能混进最终回答
  ok(
    'narrationNotLeaked',
    typeof allowed?.text === 'string' && !allowed.text.includes('我来写这个文件'),
    allowed?.text
  )

  // 3) Shell 未开启：引导语 + 不执行
  const shellDenied = await ball.eval("window.bwu.agentTest.run('帮我看下现在几点', true)")
  const shellSummary = String(shellDenied?.tools?.[0]?.summary || '')
  ok(
    'shellGuidesUser',
    shellDenied?.tools?.[0]?.ok === false && /没有开启|Agent 能力|Shell/.test(shellSummary),
    shellSummary.slice(0, 120)
  )

  // One model response cannot exceed the configured tool-call budget.
  const budget = await ball.eval("window.bwu.agentTest.run('执行预算检查', true)")
  ok('toolCallBudget', budget?.steps === 3 && budget?.tools?.length === 3, budget)

  // A model cannot invoke names outside the published tool list.
  const unknown = await ball.eval("window.bwu.agentTest.run('执行未知工具', true)")
  ok('unknownToolRejected', unknown?.steps === 1 && unknown?.tools?.length === 0, unknown)

  const started = performance.now()
  const waited = await ball.eval("window.bwu.agentTest.run('delayAlone', true)")
  ok('delayBlocksUntilTimer', performance.now() - started >= 120 && waited?.steps === 1 &&
    waited?.tools?.[0]?.toolId === 'delay' && waited?.tools?.[0]?.ok === true, waited)

  const delayDenied = await ball.eval("window.bwu.agentTest.run('delayApproval', false)")
  ok('delayedToolDenialStopsBatch', delayDenied?.stopped && delayDenied.steps === 2 &&
    delayDenied.tools.length === 2 && delayDenied.tools[0].ok === true &&
    delayDenied.tools[1].summary.includes('拒绝') && !existsSync(delayedTarget), delayDenied)

  const delayAllowed = await ball.eval("window.bwu.agentTest.run('delaySequence', true)")
  ok('delayedToolExecutesAndConsumesBudget', delayAllowed?.steps === 3 &&
    delayAllowed?.tools?.map((tool) => tool.toolId).join(',') === 'delay,file.write,file.read' &&
    delayAllowed.tools.every((tool) => tool.ok) && readFileSync(delayedTarget, 'utf8') === '延时后写入', delayAllowed?.tools)

  await settings.eval("window.bwu.settings.update({ agent: { disabledTools: ['file.write'] } })")
  const disabledFollowUp = await ball.eval("window.bwu.agentTest.run('disabledFollowUp', true)")
  ok('delayCannotCallDisabledTool', disabledFollowUp?.tools?.length === 1 &&
    disabledFollowUp.tools[0].ok === false && readFileSync(delayedTarget, 'utf8') === '延时后写入', disabledFollowUp?.tools)

  const invalidDelay = await call('delay', { seconds: 0 })
  ok('invalidDelayRejected', invalidDelay?.ok === false, invalidDelay)

  // 4) 工具清单完整
  const tools = await ball.eval('window.bwu.agentTest.list()')
  const ids = (tools || []).map((t) => t.id)
  ok(
    'toolsetComplete',
    ['shell.ps', 'file.read', 'file.write', 'file.list', 'app.launch', 'notify', 'remind', 'web.open', 'input.type', 'delay'].every((i) =>
      ids.includes(i)
    ),
    ids.length
  )
} catch (e) {
  ok('fatal', false, String(e && e.message ? e.message : e))
} finally {
  ball?.close()
  bubble?.close()
  settings?.close()
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
