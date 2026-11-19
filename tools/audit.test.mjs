/* B4：审计默认只记元数据，详细审计才写摘要/参数，且密钥类字段脱敏 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const userData = mkdtempSync(join(tmpdir(), 'bwu-audit-'))
globalThis.__bwuFixture = { userData, agent: { audit: true, auditDetail: false } }

const mock = `data:text/javascript,${encodeURIComponent(`
  export const app = { getPath: () => globalThis.__bwuFixture.userData }
  export const settingsStore = { get: () => ({ agent: globalThis.__bwuFixture.agent }) }
`)}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { shortCircuit: true, url: mock }
    if (context.parentURL?.endsWith('/agent/audit.ts') && specifier === '../store/settings') {
      return { shortCircuit: true, url: mock }
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return next(specifier + suffix, context)
        } catch {}
      }
    }
    return next(specifier, context)
  }
})
const { buildAuditEntry, recordAudit, redactValue, recentAudit } = await import(
  '../src/main/agent/audit.ts'
)

const readEntries = () => {
  const dir = join(userData, 'agent', 'runs')
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .flatMap((n) =>
        readFileSync(join(dir, n), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      )
  } catch {
    return []
  }
}

test('默认只记元数据：不含结果摘要与参数值', () => {
  const entry = buildAuditEntry(
    {
      at: Date.now(),
      callId: 'c1',
      toolId: 'file.read',
      ok: true,
      durationMs: 12,
      args: { path: 'C:\\secret\\a.txt', maxChars: 100 },
      summary: '已读取 a.txt：这里是文件正文……'
    },
    false
  )
  assert.equal(entry.summary, undefined)
  assert.equal(entry.argsPreview, undefined)
  assert.deepEqual(entry.argsKeys, ['path', 'maxChars'])
  assert.ok(entry.argsBytes > 0)
  assert.ok(entry.summaryBytes > 0)
  assert.equal(entry.durationMs, 12)
})

test('详细审计：摘要与参数写入，但 Bearer 与密钥字段打码', () => {
  const entry = buildAuditEntry(
    {
      at: Date.now(),
      callId: 'c2',
      toolId: 'shell.ps',
      ok: false,
      args: { script: 'curl -H "Authorization: Bearer abcdef1234567890"', apiKey: 'sk-live-1234' },
      summary: '失败：Authorization: Bearer abcdef1234567890 无效'
    },
    true
  )
  assert.ok(entry.summary)
  assert.ok(!entry.summary.includes('abcdef1234567890'), entry.summary)
  assert.ok(entry.summary.includes('[已隐藏]'))
  assert.ok(entry.argsPreview)
  assert.ok(!entry.argsPreview.includes('sk-live-1234'), entry.argsPreview)
  assert.ok(!entry.argsPreview.includes('abcdef1234567890'), entry.argsPreview)
})

test('redactValue 递归处理嵌套对象与数组', () => {
  const out = redactValue({ a: { token: 't0ken', note: 'ok' }, list: [{ secret: 's' }] })
  assert.equal(out.a.token, '[已隐藏]')
  assert.equal(out.a.note, 'ok')
  assert.equal(out.list[0].secret, '[已隐藏]')
})

test('recordAudit 按设置写盘：默认无摘要，打开详细后才有', () => {
  const input = {
    at: Date.now(),
    callId: 'c3',
    toolId: 'file.write',
    ok: true,
    args: { path: 'a.txt', content: '正文' },
    summary: '已写入 a.txt'
  }
  recordAudit(input)
  let entry = readEntries().at(-1)
  assert.equal(entry.summary, undefined)
  assert.deepEqual(entry.argsKeys, ['path', 'content'])

  globalThis.__bwuFixture.agent = { audit: true, auditDetail: true }
  recordAudit({ ...input, callId: 'c4' })
  entry = readEntries().at(-1)
  assert.ok(entry.summary.includes('已写入'))
  assert.ok(entry.argsPreview.includes('a.txt'))

  // 关掉审计后不再写
  globalThis.__bwuFixture.agent = { audit: false, auditDetail: true }
  const before = readEntries().length
  recordAudit({ ...input, callId: 'c5' })
  assert.equal(readEntries().length, before)
  assert.ok(recentAudit(10).length >= 2)
})

process.on('exit', () => rmSync(userData, { recursive: true, force: true }))
