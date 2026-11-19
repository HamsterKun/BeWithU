import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const mock = `data:text/javascript,${encodeURIComponent('export const app = { getPath: () => globalThis.__bwuFixture.home }; export const settingsStore = { get: () => ({agent:{files:{fullAccess:false,dirs:[globalThis.__bwuFixture.allowed]}}}) }; export const registerTool = () => {};')}`
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/agent/tools/files.ts') && ['electron', '../../store/settings', '../registry'].includes(specifier)) {
    return { shortCircuit: true, url: mock }
  }
  return next(specifier, context)
} })
const { resolveAgentPath } = await import('../src/main/agent/tools/files.ts')

test('path guard permits ordinary paths and rejects linked paths', async (t) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'bwu-file-guard-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const allowed = join(home, 'allowed')
  const other = join(home, 'other')
  globalThis.__bwuFixture = { home, allowed }
  mkdirSync(allowed)
  mkdirSync(other)
  const inside = join(allowed, 'document.txt')
  writeFileSync(inside, 'test')
  assert.equal(await resolveAgentPath(inside), inside)
  const missing = join(allowed, 'new-folder', 'new.txt')
  assert.equal(await resolveAgentPath(missing, { allowMissing: true }), missing)
  await assert.rejects(resolveAgentPath(join(other, 'new.txt'), { allowMissing: true }))
  symlinkSync(other, join(allowed, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(resolveAgentPath(join(allowed, 'link', 'new.txt'), { allowMissing: true }))
})
