/* 自定义工具 + Skill 端到端测试（需要 BWU_AGENT_TEST=1，不需要真实 API Key）
 *
 * 覆盖：
 *  1. 未信任的工具不会注册（模型看不到、调不到）
 *  2. 导入 → 信任 → 出现在工具列表
 *  3. 子进程执行 + api 代理（log）返回正确结果
 *  4. Skill 导入 → 列表 → skill.read 读到全文
 *  5. 删除工具后从列表消失
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9273)
const BASE = `http://127.0.0.1:${PORT}`
const TMP = join(ROOT, '.tmp-ext-test')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`)
  }
}

async function listTargets() {
  const res = await fetch(`${BASE}/json/list`)
  return res.json()
}

async function waitTarget(match, timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await listTargets()
      const t = list.find((x) => x.type === 'page' && x.url.includes(match))
      if (t) return t
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  throw new Error(`等待页面超时：${match}`)
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  const env = { ...process.env, BWU_AGENT_TEST: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${TMP}`, `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, stdio: 'ignore' }
  )

  let conn
  try {
    const target = await waitTarget('ball/index.html')
    conn = await Conn.open(target.webSocketDebuggerUrl)
    await sleep(1500)

    const toolDir = join(ROOT, 'tools', 'fixtures', 'custom-tool')
    const skillDir = join(ROOT, 'tools', 'fixtures', 'skill')

    // 1. 未导入时调不到
    let r = await conn.eval(`window.bwu.agentTest.call('demo.greet', { name: '未信任' }).then(r => JSON.stringify(r))`)
    r = JSON.parse(r)
    check('未导入的工具不可调用', r.ok === false && /没有这个工具/.test(r.summary), r.summary)

    // 2. 导入（默认未信任）
    const imported = JSON.parse(
      await conn.eval(
        `window.bwu.agentTest.importTool(${JSON.stringify(toolDir)}).then(t => JSON.stringify({ id: t.id, name: t.name }))`
      )
    )
    check('导入解析 manifest', imported.id === 'demo.greet' && imported.name === '问候示例', imported)

    // 3. 未信任仍然不可调用
    r = JSON.parse(
      await conn.eval(`window.bwu.agentTest.call('demo.greet', { name: '未信任' }).then(r => JSON.stringify(r))`)
    )
    check('未信任的工具不可调用', r.ok === false && /没有这个工具/.test(r.summary), r.summary)

    // 4. 信任后进入工具列表
    await conn.eval(`window.bwu.agentTest.trustTool('demo.greet', true).then(x => JSON.stringify(x))`)
    const listed = JSON.parse(
      await conn.eval(`window.bwu.agentTest.list().then(l => JSON.stringify(l.map(t => t.id)))`)
    )
    check('信任后注册进工具列表', listed.includes('demo.greet'), listed)
    check('内置 skill.read 已注册', listed.includes('skill.read'), listed)

    // 5. 真正执行（子进程 + api 代理）
    r = JSON.parse(
      await conn.eval(`window.bwu.agentTest.call('demo.greet', { name: '小伴' }).then(r => JSON.stringify(r))`)
    )
    check('自定义工具执行成功', r.ok === true && r.summary.includes('你好，小伴'), r)

    // 6. Skill 导入与读取
    const skill = JSON.parse(
      await conn.eval(
        `window.bwu.agentTest.importSkill(${JSON.stringify(skillDir)}).then(s => JSON.stringify({ name: s.name, when: s.whenToUse }))`
      )
    )
    check('Skill 导入解析 frontmatter', skill.name === '示例技能' && /演示技能/.test(skill.when), skill)
    const skills = JSON.parse(await conn.eval(`window.bwu.agentSkills.list().then(l => JSON.stringify(l))`))
    check('Skill 列表包含导入项', skills.some((s) => s.name === '示例技能'), skills.length)
    r = JSON.parse(
      await conn.eval(
        `window.bwu.agentTest.call('skill.read', { name: '示例技能' }).then(r => JSON.stringify(r))`
      )
    )
    check('skill.read 能读到正文', r.ok === true && r.summary.includes('技能已加载'), r.summary.slice(0, 80))

    // 7. 删除工具
    await conn.eval(`window.bwu.agentTools.deleteCustom('demo.greet').then(x => JSON.stringify(x))`)
    const after = JSON.parse(
      await conn.eval(`window.bwu.agentTest.list().then(l => JSON.stringify(l.map(t => t.id)))`)
    )
    check('删除后从工具列表移除', !after.includes('demo.greet'), after)
  } finally {
    try {
      conn?.ws.close()
    } catch {
      /* ignore */
    }
    proc.kill()
    await sleep(800)
    rmSync(TMP, { recursive: true, force: true })
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
