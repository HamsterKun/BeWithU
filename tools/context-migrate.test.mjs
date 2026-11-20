/* 旧版本数据迁移：memory.json → context.json，historyTurns/summary → context */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const mock = `data:text/javascript,${encodeURIComponent(`
export const app = { getPath: () => globalThis.__bwuUserData, getVersion: () => '0.0.0', isPackaged: false }
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from('ENC:' + v, 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^ENC:/, '')
}
`)}`

registerHooks({
  resolve(specifier, context, next) {
    // 导入时可能带 ?v= 查询串，判断前缀前先剥掉
    const parent = (context.parentURL ?? '').split('?')[0]
    const needsMock =
      specifier === 'electron' &&
      (parent.endsWith('/store/context.ts') ||
        parent.endsWith('/store/secure-json.ts') ||
        parent.endsWith('/store/settings.ts') ||
        parent.endsWith('/logger.ts'))
    if (needsMock) return { shortCircuit: true, url: mock }
    // 源码里用的是省略扩展名的相对导入（打包器能解析，Node 不能）
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/i.test(specifier) && parent.endsWith('.ts')) {
      return next(`${specifier}.ts`, context)
    }
    return next(specifier, context)
  }
})

const contextUrl = new URL('../src/main/store/context.ts', import.meta.url).href
const settingsUrl = new URL('../src/main/store/settings.ts', import.meta.url).href

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bwu-ctx-'))
  mkdirSync(dir, { recursive: true })
  globalThis.__bwuUserData = dir
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('memory.json 会被当作旧版摘要读入，并写成 context.json', async (t) => {
  const dir = fixture(t)
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({ summary: '他昨天在打黑神话', updatedAt: 111 }), 'utf8')
  const mod = await import(`${contextUrl}?v=legacy`)
  assert.equal(mod.contextStore.getSummary(), '他昨天在打黑神话')
  assert.equal(mod.contextStore.updatedAt(), 111)
  assert.equal(mod.contextStore.archivedUpTo(), 0)
  // 下一次写入落到新文件名
  mod.contextStore.setSummary({ summary: '新摘要', archivedUpTo: 3, before: 900, after: 100 })
  assert.ok(readFileSync(join(dir, 'context.json'), 'utf8').length > 0)
  assert.equal(mod.contextStore.archivedUpTo(), 3)
})

test('归档游标只前进不后退', async (t) => {
  fixture(t)
  const mod = await import(`${contextUrl}?v=cursor`)
  mod.contextStore.setSummary({ summary: 'a', archivedUpTo: 5, before: 1, after: 1 })
  mod.contextStore.setSummary({ summary: 'b', archivedUpTo: 2, before: 1, after: 1 })
  assert.equal(mod.contextStore.archivedUpTo(), 5)
  mod.contextStore.clampArchived(3)
  assert.equal(mod.contextStore.archivedUpTo(), 3)
})

test('旧设置（historyTurns / summary）迁移成 context 默认值', async (t) => {
  const dir = fixture(t)
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      llm: {
        model: 'deepseek-chat',
        historyTurns: 0,
        summary: { enabled: true, baseUrl: 'https://x', apiKey: 'sk-legacy', model: 'cheap' }
      }
    }),
    'utf8'
  )
  const mod = await import(`${settingsUrl}?v=migrate`)
  const s = mod.settingsStore.get()
  // 上下文永远开启：旧的 historyTurns=0 不再意味着"不记上下文"
  assert.deepEqual(s.context, {
    level: 'mid',
    modelWindow: 0,
    timeAwareness: 'current',
    keepRecentTurns: 4
  })
  assert.equal('historyTurns' in s.llm, false)
  assert.equal('summary' in s.llm, false)
})

test('非法的 context 值会被夹回合法范围', async (t) => {
  const dir = fixture(t)
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ context: { level: 'huge', modelWindow: 100, timeAwareness: 'always', keepRecentTurns: 0 } }),
    'utf8'
  )
  const mod = await import(`${settingsUrl}?v=clamp`)
  const s = mod.settingsStore.get()
  assert.equal(s.context.level, 'mid')
  // 小于 8k 的手动窗口视为没填
  assert.equal(s.context.modelWindow, 0)
  assert.equal(s.context.timeAwareness, 'current')
  assert.equal(s.context.keepRecentTurns, 4)
})

test('合法的 context 值原样保留', async (t) => {
  const dir = fixture(t)
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ context: { level: 'high', modelWindow: 200000, timeAwareness: 'full', keepRecentTurns: 8 } }),
    'utf8'
  )
  const mod = await import(`${settingsUrl}?v=valid`)
  const s = mod.settingsStore.get()
  assert.equal(s.context.level, 'high')
  assert.equal(s.context.modelWindow, 200000)
  assert.equal(s.context.timeAwareness, 'full')
  assert.equal(s.context.keepRecentTurns, 8)
})
