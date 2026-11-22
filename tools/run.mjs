#!/usr/bin/env node
/**
 * 测试总入口。以前跑回归要手抄一长串文件名，容易漏、也容易忘了先杀 electron；
 * 现在统一从这里走：
 *
 *   node tools/run.mjs              # 等价于 unit
 *   node tools/run.mjs unit         # 单元/安全（node:test，不需要 Electron）
 *   node tools/run.mjs e2e          # 端到端，逐个跑，前后自动清进程
 *   node tools/run.mjs all          # unit + e2e
 *   node tools/run.mjs list         # 看清单（含不参与回归的辅助脚本）
 *
 * 常用参数：
 *   --only=context,update   只跑名字里带这些片段的
 *   --timeout=600           单个 E2E 的超时秒数（默认 300）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = join(ROOT, 'tools')

/** 单元/安全：纯 node:test，不启动 Electron */
const UNITS = [
  'agent-screenshot.test.mjs',
  'agent-system.test.mjs',
  'agent-tool-results.test.mjs',
  'approval.test.mjs',
  'archive-limits.test.mjs',
  'asr-generation.test.mjs',
  'asr-model-manifest.test.mjs',
  'audit.test.mjs',
  'auto-launch-command.test.mjs',
  'ball-position.test.mjs',
  'context-budget.test.mjs',
  'context-migrate.test.mjs',
  'context-plan.test.mjs',
  'data-dir-migration.test.mjs',
  'dsh-route.test.mjs',
  'file-boundary.test.mjs',
  'file-io.test.mjs',
  'format.test.mjs',
  'gpt-sovits.test.mjs',
  'input-worker.test.mjs',
  'log-tail.test.mjs',
  'mcp-http.test.mjs',
  'mcp-secrets.test.mjs',
  'player-test.mjs',
  'retry-policy.test.mjs',
  'secure-json.test.mjs',
  'service-lifecycle.test.mjs',
  'sse-parse.test.mjs',
  'version.test.mjs',
  'vision-grab.test.mjs',
  'voice-mode.test.mjs',
  'windows-hotkey.test.mjs'
]

/** 需要本机有已校验 ASR 归档才跑得动，单独列出来 */
const OPTIONAL_UNITS = ['asr-download-test.mjs']

/** 端到端：每个都要先清掉上一轮的 Electron，否则单实例锁会让新实例直接退出 */
const E2E = [
  { file: 'smoke-test.mjs', expect: 11 },
  { file: 'agent-run-test.mjs', expect: 15 },
  { file: 'agent-ext-test.mjs', expect: 10 },
  { file: 'agent-llm-test.mjs', expect: 3 },
  { file: 'agent-settings-test.mjs', expect: 8 },
  { file: 'agent-ui-test.mjs', expect: 23 },
  { file: 'agent-input-test.mjs', expect: 13 },
  { file: 'app-test.mjs', expect: 16 },
  { file: 'menu-test.mjs', expect: 6 },
  { file: 'prompts-test.mjs', expect: 4 },
  { file: 'thinking-test.mjs', expect: 7 },
  { file: 'sse-tail-test.mjs', expect: 3 },
  { file: 'search-test.mjs', expect: 4 },
  { file: 'shell-encoding-test.mjs', expect: 3 },
  { file: 'mcp-zip-test.mjs', expect: 6 },
  { file: 'recorder-cancel-test.mjs', expect: 9 },
  { file: 'hotkey-fallback-test.mjs', expect: 4 },
  { file: 'privacy-at-rest-test.mjs', expect: 5 },
  { file: 'context-ui-test.mjs', expect: 10 },
  { file: 'context-compact-test.mjs', expect: 6 },
  { file: 'data-pane-test.mjs', expect: 14 },
  { file: 'update-test.mjs', expect: 12 },
  { file: 'update-portable-test.mjs', expect: 5 },
  { file: 'local-asr-test.mjs' } // 需要已装本地模型，断言数不固定
]

/** 手工辅助脚本：截图、探针、生成素材，不参与回归 */
const MANUAL = [
  'asr-probe.mjs',
  'tts-probe.mjs',
  'cdp.mjs',
  'gen-voices.mjs',
  'gen-skins.py',
  'input-harness.ps1',
  'input-helper.ps1'
]

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const only = flag('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const timeoutSec = Number(flag('timeout', '300')) || 300

const cmd = args.find((a) => !a.startsWith('--')) ?? 'unit'

const nameOf = (file) => file.replace(/\.mjs$/, '')
const picked = (file) => only.length === 0 || only.some((k) => nameOf(file).includes(k))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function killApps() {
  for (const exe of ['electron.exe', 'BeWithU.exe']) {
    spawnSync('taskkill', ['/F', '/IM', exe, '/T'], { stdio: 'ignore', windowsHide: true })
  }
}

function runUnit(files) {
  const list = files.filter(picked).filter((f) => existsSync(join(TOOLS, f)))
  if (!list.length) {
    console.log('没有匹配的单元测试')
    return 0
  }
  console.log(`\n单元/安全：${list.length} 个文件\n`)
  const r = spawnSync(process.execPath, ['--test', ...list.map((f) => join('tools', f))], {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  })
  return r.status ?? 1
}

function runE2E() {
  const list = E2E.filter((s) => picked(s.file) && existsSync(join(TOOLS, s.file)))
  if (!list.length) {
    console.log('没有匹配的 E2E 套件')
    return 0
  }
  const failed = []
  const start = Date.now()
  for (const suite of list) {
    killApps()
    const name = nameOf(suite.file)
    process.stdout.write(`  ${name.padEnd(24)}`)
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [join('tools', suite.file)], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: timeoutSec * 1000
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const sec = ((Date.now() - t0) / 1000).toFixed(0)
    const fatal = /fatal|✗/.test(out)
    const passLine = out.match(/通过\s+(\d+)\/(\d+)/)
    const okExit = r.status === 0 && !fatal
    // expect 用来抓"少跑了几条断言"这种静默退化
    const enough = !suite.expect || (passLine && Number(passLine[1]) === suite.expect)
    if (okExit && enough) {
      console.log(`✓ ${passLine ? `${passLine[1]}/${passLine[2]}` : 'ok'}  ${sec}s`)
    } else {
      console.log(`✗ ${passLine ? `${passLine[1]}/${passLine[2]}` : `exit ${r.status}`}  ${sec}s`)
      const lines = out.split(/\r?\n/).filter((l) => l.trim())
      for (const line of lines.slice(-12)) console.log(`      ${line}`)
      failed.push(name)
    }
  }
  const total = ((Date.now() - start) / 1000).toFixed(0)
  console.log(`\nE2E ${list.length - failed.length}/${list.length} 套件通过（${total}s）`)
  if (failed.length) console.log(`失败：${failed.join(', ')}`)
  return failed.length ? 1 : 0
}

function list() {
  console.log(`单元测试 (${UNITS.length})`)
  for (const f of UNITS) console.log(`  ${nameOf(f)}`)
  console.log(`\n可选单元（需要 ASR 归档）`)
  for (const f of OPTIONAL_UNITS) console.log(`  ${nameOf(f)}`)
  console.log(`\nE2E (${E2E.length})`)
  for (const s of E2E) console.log(`  ${nameOf(s.file).padEnd(24)}${s.expect ?? '-'} 条`)
  console.log(`\n手工脚本（不参与回归）`)
  for (const f of MANUAL) console.log(`  ${f}`)
}

let code = 0
if (cmd === 'list') {
  list()
} else if (cmd === 'unit') {
  code = runUnit(UNITS)
} else if (cmd === 'e2e') {
  code = runE2E()
} else if (cmd === 'all') {
  code = runUnit(UNITS)
  if (code === 0) code = runE2E()
  else console.log('\n单元测试失败，跳过 E2E')
} else {
  console.log(`未知命令：${cmd}`)
  console.log('用法：node tools/run.mjs [unit|e2e|all|list] [--only=...] [--timeout=秒]')
  code = 1
}
process.exit(code)
