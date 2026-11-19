import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'bwu-mcp-secrets-'))
const fakeElectron = `data:text/javascript,${encodeURIComponent(`export const app={getPath:()=>${JSON.stringify(root)}}; export const safeStorage={isEncryptionAvailable:()=>globalThis.__safeAvailable,encryptString:(s)=>Buffer.from('enc:'+s),decryptString:(b)=>{const s=b.toString(); if(!s.startsWith('enc:')) throw new Error('bad ciphertext'); return s.slice(4)}}`)}`
globalThis.__safeAvailable = true
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'electron' && context.parentURL?.endsWith('/settings.ts')) return { shortCircuit: true, url: fakeElectron }
  if (specifier === '../logger' && context.parentURL?.endsWith('/settings.ts')) return { shortCircuit: true, url: 'data:text/javascript,export const log=()=>{}' }
  if (context.parentURL?.includes('/src/') && !specifier.startsWith('node:')) {
    try { return next(`${specifier}.ts`, context) } catch {}
  }
  return next(specifier, context)
} })
const { settingsStore } = await import('../src/main/store/settings.ts')

test('MCP headers are encrypted at rest and masked from public settings', () => {
  settingsStore.update({ mcp: { servers: [{ id: 'secure', name: 'Secure', enabled: true, transport: 'http', command: '', args: '', url: 'https://example.test/mcp', headers: 'Authorization: Bearer secret-value' }] } })
  const onDisk = readFileSync(join(root, 'settings.json'), 'utf8')
  const secrets = readFileSync(join(root, 'secrets.bin'), 'utf8')
  assert.equal(onDisk.includes('secret-value'), false)
  assert.equal(secrets.includes('secret-value'), false)
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
  globalThis.__safeAvailable = false
  assert.throws(() => settingsStore.update({ mcp: { servers: [{ id: 'secure', name: 'Secure', enabled: true, transport: 'http', command: '', args: '', url: 'https://example.test/mcp', headers: 'Authorization: Bearer changed' }] } }), /加密不可用/)
  assert.equal(settingsStore.mcpServers()[0].headers, 'Authorization: Bearer previous')
  globalThis.__safeAvailable = true
})

test.after(() => rmSync(root, { recursive: true, force: true }))
