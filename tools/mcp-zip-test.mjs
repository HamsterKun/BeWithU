/* 压缩包导入 + MCP 端到端测试（BWU_AGENT_TEST=1，不需要真实 Key） */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9285)
const TMP = join(ROOT, '.tmp-zip-mcp')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (n, c, d) => {
  c ? pass++ : fail++
  console.log(`${c ? '✓' : '✗'} ${n}${d === undefined ? '' : ' ' + JSON.stringify(d)}`)
}

function zipDir(srcDir, zipPath) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force`],
    { stdio: 'ignore' }
  )
}

async function waitTarget(match, timeout = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.type === 'page' && x.url.includes(match))
      if (t) return t
    } catch {}
    await sleep(300)
  }
  throw new Error('timeout ' + match)
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
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  const toolDir = join(TMP, 'tool', 'zip-tool')
  const skillDir = join(TMP, 'skill', 'zip-skill')
  mkdirSync(toolDir, { recursive: true })
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(toolDir, 'manifest.json'),
    JSON.stringify({
      id: 'zip.tool',
      name: '压缩包工具',
      description: '从 zip 导入的测试工具',
      risk: 'low',
      permissions: [],
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }),
    'utf8'
  )
  writeFileSync(
    join(toolDir, 'index.js'),
    'module.exports = { async run(args) { return { ok: true, summary: "zip 工具收到: " + String(args.text || "") } } }\n',
    'utf8'
  )
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: 压缩包技能\ndescription: 从 zip 导入\nwhenToUse: 测试时\n---\n\n# 步骤\n\n1. 打个招呼\n',
    'utf8'
  )
  const toolZip = join(TMP, 'tool.zip')
  const skillZip = join(TMP, 'skill.zip')
  zipDir(toolDir, toolZip)
  zipDir(skillDir, skillZip)

  const profile = join(TMP, 'profile')
  mkdirSync(profile, { recursive: true })
  const env = { ...process.env, BWU_AGENT_TEST: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, stdio: 'ignore' }
  )
  const ball = await Conn.open((await waitTarget('ball/index.html')).webSocketDebuggerUrl)
  await sleep(1800)

  const q = (p) => JSON.stringify(p)

  // 1) 工具压缩包
  let r = JSON.parse(await ball.eval(`window.bwu.agentTest.importToolZip(${q(toolZip)}).then(t => JSON.stringify({id:t.id})).catch(e => JSON.stringify({error:String(e)}))`))
  check('从 zip 导入工具', r.id === 'zip.tool', r)

  // 2) 技能压缩包
  r = JSON.parse(await ball.eval(`window.bwu.agentTest.importSkillZip(${q(skillZip)}).then(s => JSON.stringify({name:s.name})).catch(e => JSON.stringify({error:String(e)}))`))
  check('从 zip 导入技能', r.name === '压缩包技能', r)

  // 3) 添加 MCP 服务器（用当前 node 跑假服务）
  const server = join(ROOT, 'tools', 'fixtures', 'mcp-server.cjs')
  const list = JSON.parse(
    await ball.eval(`window.bwu.mcp.add({ name:'假MCP', transport:'stdio', command:${q(process.execPath)}, args:${q(server)} }).then(l => JSON.stringify(l))`)
  )
  const added = list.find((x) => x.name === '假MCP')
  check('添加 MCP 服务器', Boolean(added), list.map((x) => x.name))

  // 4) 测试连接
  r = JSON.parse(await ball.eval(`window.bwu.mcp.test(${q(added.id)}).then(r => JSON.stringify(r))`))
  check('MCP 连接并列出工具', r.ok && r.tools?.includes('echo'), r)

  // 5) 注册进工具表
  const ids = JSON.parse(await ball.eval(`window.bwu.agentTest.mcpTools().then(l => JSON.stringify(l))`))
  check('MCP 工具已注册', ids.includes(`mcp.${added.id}.echo`), ids)

  // 6) 真正调用
  r = JSON.parse(
    await ball.eval(`window.bwu.agentTest.call(${q(`mcp.${added.id}.echo`)}, { text: '你好' }).then(r => JSON.stringify(r))`)
  )
  check('MCP 工具调用成功', r.ok && r.summary.includes('MCP echo: 你好'), r.summary)

  ball.ws.close()
  proc.kill()
  await sleep(700)
  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
