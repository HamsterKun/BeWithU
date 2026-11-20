/* B4：历史与记忆加密落盘（safeStorage），兼容旧明文，加密不可用时退回明文 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const userData = mkdtempSync(join(tmpdir(), 'bwu-secure-json-'))
globalThis.__bwuFixture = { userData, available: true }

// 假的安全存储：密文 = "enc:" + 明文，再 base64；解不开时报错，用来模拟换机器
const mock = `data:text/javascript,${encodeURIComponent(`
  export const app = { getPath: () => globalThis.__bwuFixture.userData }
  export const safeStorage = {
    isEncryptionAvailable: () => globalThis.__bwuFixture.available,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => {
      const t = b.toString('utf8')
      if (!t.startsWith('enc:')) throw new Error('bad ciphertext')
      return t.slice(4)
    }
  }
  export const settingsStore = { get: () => ({ agent: {} }) }
`)}`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { shortCircuit: true, url: mock }
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

const secure = await import('../src/main/store/secure-json.ts')
const historyUrl = new URL('../src/main/store/history.ts', import.meta.url).href
const contextUrl = new URL('../src/main/store/context.ts', import.meta.url).href

test('加密可用：写入带 BWU1 前缀，读回一致', () => {
  const file = join(userData, 'a.json')
  writeFileSync(file, secure.encodeSecureJson({ hello: '世界' }), 'utf8')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('BWU1:'), text.slice(0, 16))
  assert.ok(!text.includes('世界'), '密文里不该出现明文')
  assert.deepEqual(secure.readSecureJson(file), { hello: '世界' })
})

test('兼容旧明文文件', () => {
  const file = join(userData, 'legacy.json')
  writeFileSync(file, '\uFEFF[{"role":"user","content":"旧消息"}]', 'utf8')
  assert.deepEqual(secure.readSecureJson(file), [{ role: 'user', content: '旧消息' }])
})

test('加密不可用：退回明文，仍能读回', () => {
  globalThis.__bwuFixture.available = false
  const file = join(userData, 'plain.json')
  const text = secure.encodeSecureJson({ a: 1 })
  writeFileSync(file, text, 'utf8')
  assert.ok(!text.startsWith('BWU1:'))
  assert.deepEqual(secure.readSecureJson(file), { a: 1 })
  globalThis.__bwuFixture.available = true
})

test('加密不可用时读不了已加密文件（返回 null，不抛）', () => {
  const file = join(userData, 'locked.json')
  writeFileSync(file, secure.encodeSecureJson({ x: 1 }), 'utf8')
  globalThis.__bwuFixture.available = false
  assert.equal(secure.readSecureJson(file), null)
  globalThis.__bwuFixture.available = true
})

test('损坏的密文 / 非法 JSON 返回 null', () => {
  const bad = join(userData, 'bad.json')
  writeFileSync(bad, 'BWU1:' + Buffer.from('garbage', 'utf8').toString('base64'), 'utf8')
  assert.equal(secure.readSecureJson(bad), null)
  const broken = join(userData, 'broken.json')
  writeFileSync(broken, '{not json', 'utf8')
  assert.equal(secure.readSecureJson(broken), null)
  assert.equal(secure.readSecureJson(join(userData, 'missing.json')), null)
})

test('history 存储：加密写盘、重载能读回，旧明文自动升级', async () => {
  const h1 = await import(`${historyUrl}?v=1`)
  h1.historyStore.add('user', '你好')
  h1.historyStore.add('assistant', '在的')
  const file = join(userData, 'history.json')
  assert.ok(readFileSync(file, 'utf8').startsWith('BWU1:'))

  const h2 = await import(`${historyUrl}?v=2`)
  h2.historyStore.load()
  assert.deepEqual(
    h2.historyStore.all().map((m) => m.content),
    ['你好', '在的']
  )

  // 旧明文文件：能读，下一次保存后变成密文
  writeFileSync(file, JSON.stringify([{ role: 'user', content: '老数据', at: 1 }]), 'utf8')
  const h3 = await import(`${historyUrl}?v=3`)
  h3.historyStore.load()
  assert.equal(h3.historyStore.all()[0].content, '老数据')
  h3.historyStore.add('user', '新一句')
  assert.ok(readFileSync(file, 'utf8').startsWith('BWU1:'))
})

test('context 存储：加密写盘、重载能读回', async () => {
  const m1 = await import(`${contextUrl}?v=1`)
  m1.contextStore.setSummary({ summary: '用户喜欢射击游戏', archivedUpTo: 2, before: 900, after: 120 })
  assert.ok(readFileSync(join(userData, 'context.json'), 'utf8').startsWith('BWU1:'))
  const m2 = await import(`${contextUrl}?v=2`)
  assert.equal(m2.contextStore.getSummary(), '用户喜欢射击游戏')
  assert.equal(m2.contextStore.archivedUpTo(), 2)
})

process.on('exit', () => rmSync(userData, { recursive: true, force: true }))
