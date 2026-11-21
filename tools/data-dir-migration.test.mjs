// Run with Node 24+: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tools/data-dir-migration.test.mjs
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const electron = { app: {}, dialog: {} }
const fakeElectron = `data:text/javascript,${encodeURIComponent('export const { app, dialog } = globalThis.__bwuFakeElectron')}`
globalThis.__bwuFakeElectron = electron
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron' && context.parentURL?.includes('/data-dir.ts?')) {
      return { shortCircuit: true, url: fakeElectron }
    }
    return nextResolve(specifier, context)
  }
})

let moduleId = 0
async function profile(t) {
  const root = mkdtempSync(join(fs.realpathSync.native(tmpdir()), 'bwu-data-dir-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const appData = join(root, 'appdata')
  const defaults = join(appData, 'BeWithU')
  const custom = join(root, 'custom')
  const pointer = join(defaults, 'data-dir.txt')
  let userData = defaults
  electron.app.getName = () => 'BeWithU'
  electron.app.getPath = (name) => name === 'appData' ? appData : userData
  electron.app.setPath = (name, path) => {
    assert.equal(name, 'userData')
    userData = path
  }
  mkdirSync(defaults, { recursive: true })
  const start = () => import(`../src/main/data-dir.ts?test=${++moduleId}`)
  return { root, defaults, custom, pointer, start, dataDir: await start() }
}

function file(root, path, contents) {
  const fullPath = join(root, path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, contents)
}

const read = (root, path) => readFileSync(join(root, path), 'utf8')

function failFs(t, name, match) {
  const original = fs[name]
  t.mock.method(fs, name, (...args) => {
    if (match(...args)) throw new Error('injected filesystem failure')
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

test('copies application data, switches on startup, and retains source and caches', async (t) => {
  const { dataDir, defaults, custom, pointer, start } = await profile(t)
  file(defaults, 'settings.json', '{}')
  file(defaults, 'usage.json', 'usage')
  file(defaults, 'agent/skills/skill.md', 'skill')
  file(defaults, 'Cache/entry', 'cache')
  mkdirSync(custom)
  const result = await dataDir.migrateDataDir(custom)
  assert.deepEqual(result, { moved: ['settings.json', 'usage.json', 'agent'], bytes: 12 })
  assert.equal(read(defaults, 'settings.json'), '{}')
  assert.equal(read(custom, 'agent/skills/skill.md'), 'skill')
  assert.equal(readFileSync(pointer, 'utf8'), custom)
  assert.equal(existsSync(join(custom, 'Cache')), false)
  assert.equal(dataDir.currentDataDir(), defaults)
  assert.throws(() => dataDir.moveBackToDefault(), /请先重启应用/)
  const restarted = await start()
  restarted.applyCustomDataDir()
  assert.equal(restarted.currentDataDir(), custom)
  assert.equal(restarted.isCustomDataDir(), true)
})

test('return to default preserves Chromium and archives earlier app data separately', async (t) => {
  const { defaults, custom, pointer, dataDir, start } = await profile(t)
  file(defaults, 'settings.json', 'old default settings')
  file(defaults, 'history.json', 'old default history')
  file(defaults, 'GPUCache/cache', 'chromium')
  file(custom, 'settings.json', 'current settings')
  file(custom, 'agent/runs/run.json', 'current run')
  writeFileSync(pointer, custom)
  dataDir.applyCustomDataDir()
  await dataDir.moveBackToDefault()
  const backup = readdirSync(defaults).find((name) => name.startsWith('.bewithu-backup-'))
  assert.ok(backup)
  assert.equal(read(defaults, `${backup}/settings.json`), 'old default settings')
  assert.equal(read(defaults, `${backup}/history.json`), 'old default history')
  assert.equal(existsSync(join(defaults, 'history.json')), false)
  assert.equal(read(defaults, 'GPUCache/cache'), 'chromium')
  assert.equal(read(defaults, 'settings.json'), 'current settings')
  assert.equal(read(custom, 'settings.json'), 'current settings')
  assert.equal(existsSync(pointer), false)
  electron.app.setPath('userData', defaults)
  const restarted = await start()
  restarted.applyCustomDataDir()
  assert.equal(restarted.isCustomDataDir(), false)
})

test('rejects nonempty custom directories and path aliases', async (t) => {
  const { dataDir, root, defaults, custom, pointer } = await profile(t)
  file(defaults, 'settings.json', 'source settings')
  file(custom, 'history.json', 'target-only history')
  assert.throws(() => dataDir.migrateDataDir(custom), /必须为空/)
  assert.deepEqual(readdirSync(custom), ['history.json'])
  assert.throws(() => dataDir.migrateDataDir(join(defaults, 'nested')), /当前数据目录/)
  const alias = join(root, 'alias')
  symlinkSync(defaults, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => dataDir.migrateDataDir(join(alias, 'nested')), /符号链接/)
  assert.equal(existsSync(pointer), false)
})

test('rejects dangling links in app data', async (t) => {
  const { dataDir, root, defaults, custom, pointer } = await profile(t)
  const gone = join(root, 'gone')
  mkdirSync(gone)
  symlinkSync(gone, join(defaults, 'agent'), process.platform === 'win32' ? 'junction' : 'dir')
  fs.rmdirSync(gone)
  assert.throws(() => dataDir.migrateDataDir(custom), /符号链接/)
  assert.equal(existsSync(pointer), false)
  assert.equal(existsSync(custom), false)
})

test('restores the default profile if removing the custom pointer fails', async (t) => {
  const { dataDir, defaults, custom, pointer } = await profile(t)
  file(defaults, 'history.json', 'default history')
  file(defaults, 'models/old.bin', 'old model')
  file(defaults, 'Cache/cache', 'chromium')
  file(custom, 'history.json', 'custom history')
  file(custom, 'agent/skills/skill.md', 'current skill')
  writeFileSync(pointer, custom)
  dataDir.applyCustomDataDir()
  failFs(t, 'unlinkSync', (path) => path === pointer)
  assert.throws(() => dataDir.moveBackToDefault(), /injected filesystem failure/)
  assert.equal(readFileSync(pointer, 'utf8'), custom)
  assert.equal(read(defaults, 'history.json'), 'default history')
  assert.equal(read(defaults, 'models/old.bin'), 'old model')
  assert.equal(read(defaults, 'Cache/cache'), 'chromium')
  assert.equal(read(custom, 'history.json'), 'custom history')
  assert.deepEqual(readdirSync(defaults).sort(), ['Cache', 'data-dir.txt', 'history.json', 'models'])
})

test('a failed pointer replacement keeps the previous pointer and target state', async (t) => {
  const { dataDir, root, custom, pointer } = await profile(t)
  file(custom, 'settings.json', 'current settings')
  writeFileSync(pointer, custom)
  dataDir.applyCustomDataDir()
  const destination = join(root, 'next')
  mkdirSync(destination)
  failFs(t, 'renameSync', (_, dest) => dest === pointer)
  assert.throws(() => dataDir.migrateDataDir(destination), /injected filesystem failure/)
  assert.equal(readFileSync(pointer, 'utf8'), custom)
  assert.deepEqual(readdirSync(destination), [])
  assert.equal(read(custom, 'settings.json'), 'current settings')
})

test('switches between custom directories by replacing the existing pointer', async (t) => {
  const { dataDir, root, custom, pointer, start } = await profile(t)
  file(custom, 'settings.json', 'current settings')
  writeFileSync(pointer, custom)
  dataDir.applyCustomDataDir()
  const destination = join(root, 'next')
  await dataDir.migrateDataDir(destination)
  assert.equal(readFileSync(pointer, 'utf8'), destination)
  assert.equal(read(destination, 'settings.json'), 'current settings')
  assert.equal(read(custom, 'settings.json'), 'current settings')
  const restarted = await start()
  restarted.applyCustomDataDir()
  assert.equal(restarted.currentDataDir(), destination)
})

test('rejects a staged copy corrupted without a size change', async (t) => {
  const { dataDir, defaults, custom, pointer } = await profile(t)
  file(defaults, 'settings.json', 'good')
  const original = fs.cpSync
  t.mock.method(fs, 'cpSync', (src, dest, options) => {
    original(src, dest, options)
    writeFileSync(dest, 'bad!')
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  assert.throws(() => dataDir.migrateDataDir(custom), /数据复制校验失败/)
  assert.equal(read(defaults, 'settings.json'), 'good')
  assert.equal(existsSync(pointer), false)
  assert.equal(existsSync(custom), false)
})

test('size reporting uses metadata and excludes caches', async (t) => {
  const { dataDir, defaults } = await profile(t)
  file(defaults, 'models/model.bin', '12345')
  file(defaults, 'Cache/entry', 'ignore this')
  failFs(t, 'openSync', (path) => path === join(defaults, 'models/model.bin'))
  assert.equal(dataDir.dirSizeMB(defaults), 5 / 1024 / 1024)
})

test('changing and restoring the directory exits in the same turn as committing the copy', async (t) => {
  const { dataDir, defaults, custom, pointer, start } = await profile(t)
  const lifecycle = []
  electron.app.relaunch = () => lifecycle.push('relaunch')
  electron.app.exit = (code) => lifecycle.push(code)
  file(defaults, 'history.json', 'latest history before moving')
  dataDir.switchDataDirAndRestart(custom)
  assert.deepEqual(lifecycle, ['relaunch', 0])
  assert.equal(readFileSync(pointer, 'utf8'), custom)
  assert.equal(read(custom, 'history.json'), 'latest history before moving')

  const restarted = await start()
  restarted.applyCustomDataDir()
  file(custom, 'history.json', 'latest history before restoring')
  restarted.switchDataDirAndRestart()
  assert.deepEqual(lifecycle, ['relaunch', 0, 'relaunch', 0])
  assert.equal(existsSync(pointer), false)
  assert.equal(read(defaults, 'history.json'), 'latest history before restoring')
})
