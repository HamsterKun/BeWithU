import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'bwu-mcp-secrets-'))
const fakeElectron = `data:text/javascript,${encodeURIComponent(`
  export const app = { getPath: () => globalThis.__settingsFixture.dir }
  export const safeStorage = {
    isEncryptionAvailable: () => globalThis.__settingsFixture.secure,
    encryptString: (s) => Buffer.from('enc:' + s),
    decryptString: (b) => {
      const s = b.toString()
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
      return s.slice(4)
    }
  }
`)}`
const fakeFs = `data:text/javascript,${encodeURIComponent(`
  export * from 'node:fs'
  import { renameSync as nativeRename } from 'node:fs'
  export function renameSync(from, to) {
    if (globalThis.__settingsFixture.failCommit && to.endsWith('settings.json')) throw new Error('fixture: commit failed')
    nativeRename(from, to)
  }
`)}`
globalThis.__settingsFixture = { dir: root, secure: true, failCommit: false }
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.split('?')[0].endsWith('/settings.ts')) {
    if (specifier === 'electron') return { shortCircuit: true, url: fakeElectron }
    if (specifier === 'node:fs') return { shortCircuit: true, url: fakeFs }
    if (specifier === '../logger') return { shortCircuit: true, url: 'data:text/javascript,export const log=()=>{}' }
  }
  if (context.parentURL?.includes('/src/') && !specifier.startsWith('node:')) {
    try { return next(`${specifier}.ts`, context) } catch {}
  }
  return next(specifier, context)
} })
const { settingsStore } = await import('../src/main/store/settings.ts')
const settingsUrl = new URL('../src/main/store/settings.ts', import.meta.url).href

test('MCP headers are encrypted at rest and masked from public settings', () => {
  settingsStore.update({ mcp: { servers: [{ id: 'secure', name: 'Secure', enabled: true, transport: 'http', command: '', args: '', url: 'https://example.test/mcp', headers: 'Authorization: Bearer secret-value' }] } })
  const onDisk = readFileSync(join(root, 'settings.json'), 'utf8')
  assert.equal(onDisk.includes('secret-value'), false)
  assert.equal(typeof JSON.parse(onDisk).encryptedSecrets['mcp.secure.headers'], 'string')
  assert.equal('encryptedSecrets' in settingsStore.public(), false)
  assert.equal(settingsStore.public().mcp.servers[0].headers, '')
  assert.equal(settingsStore.public().mcp.servers[0].headersConfigured, true)
  assert.equal(settingsStore.mcpServers()[0].headers, 'Authorization: Bearer secret-value')
})

test('MCP credentials survive unrelated settings updates and reset', () => {
  settingsStore.update({ ui: { muted: true } })
  assert.equal(settingsStore.mcpServers()[0].headers, 'Authorization: Bearer secret-value')
  settingsStore.reset()
  assert.equal(settingsStore.mcpServers().length, 0)
})

test('encryption failure rejects updates and retains previous in-memory settings', () => {
  settingsStore.update({ mcp: { servers: [{ id: 'secure', name: 'Secure', enabled: true, transport: 'http', command: '', args: '', url: 'https://example.test/mcp', headers: 'Authorization: Bearer previous' }] } })
  globalThis.__settingsFixture.secure = false
  assert.throws(() => settingsStore.update({ mcp: { servers: [{ id: 'secure', name: 'Secure', enabled: true, transport: 'http', command: '', args: '', url: 'https://example.test/mcp', headers: 'Authorization: Bearer changed' }] } }), /加密不可用/)
  assert.equal(settingsStore.mcpServers()[0].headers, 'Authorization: Bearer previous')
  globalThis.__settingsFixture.secure = true
})

test('failed settings commit preserves the old provider and key even after reopening the store', async () => {
  settingsStore.update({ llm: { baseUrl: 'https://old.example/v1', apiKey: 'fixture-old' } })
  const file = join(root, 'settings.json')
  const before = readFileSync(file, 'utf8')
  const patch = { llm: { baseUrl: 'https://new.example/v1', apiKey: 'fixture-new' } }
  globalThis.__settingsFixture.failCommit = true
  try {
    assert.throws(() => settingsStore.update(patch), /fixture: commit failed/)
  } finally {
    globalThis.__settingsFixture.failCommit = false
  }
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(settingsStore.get().llm.apiKey, 'fixture-old')
  const { settingsStore: reopened } = await import(`${settingsUrl}?v=failed`)
  assert.equal(reopened.get().llm.baseUrl, 'https://old.example/v1')
  assert.equal(reopened.get().llm.apiKey, 'fixture-old')

  reopened.update(patch)
  const { settingsStore: afterRetry } = await import(`${settingsUrl}?v=retry`)
  assert.equal(afterRetry.get().llm.baseUrl, 'https://new.example/v1')
  assert.equal(afterRetry.get().llm.apiKey, 'fixture-new')
})

test('legacy secrets migrate only after commit and stale copies cannot resurrect a cleared key', async (t) => {
  const dir = join(root, 'legacy')
  mkdirSync(dir)
  globalThis.__settingsFixture.dir = dir
  t.after(() => { globalThis.__settingsFixture.dir = root })
  const legacyFile = join(dir, 'secrets.bin')
  const legacy = JSON.stringify({ 'llm.apiKey': Buffer.from('enc:fixture-legacy').toString('base64') })
  writeFileSync(legacyFile, legacy)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ llm: { baseUrl: 'https://legacy.example/v1' } }))

  const { settingsStore: legacyStore } = await import(`${settingsUrl}?v=legacy`)
  assert.equal(legacyStore.get().llm.apiKey, 'fixture-legacy')
  globalThis.__settingsFixture.failCommit = true
  try {
    assert.throws(() => legacyStore.update({ ui: { muted: true } }), /fixture: commit failed/)
    assert.equal(readFileSync(legacyFile, 'utf8'), legacy)
  } finally {
    globalThis.__settingsFixture.failCommit = false
  }
  legacyStore.update({ clearSecrets: ['llm.apiKey'] })
  assert.equal(existsSync(legacyFile), false)
  writeFileSync(legacyFile, legacy)
  const { settingsStore: reopened } = await import(`${settingsUrl}?v=legacy-clear`)
  assert.equal(reopened.get().llm.apiKey, '')
})

test.after(() => rmSync(root, { recursive: true, force: true }))
