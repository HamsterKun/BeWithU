import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const profile = mkdtempSync(join(tmpdir(), 'bwu-ball-position-'))
const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const left = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }
const above = { workArea: { x: 0, y: -1080, width: 1920, height: 1080 } }
let displays = [primary, left, above]
let pointUsed

class FakeWindow extends EventEmitter {
  constructor({ x, y, width, height }) {
    super()
    this.bounds = { x, y, width, height }
  }
  webContents = { setWindowOpenHandler() {}, on() {} }
  isDestroyed() { return false }
  getBounds() { return this.bounds }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents() {}
  async loadFile() {}
}

globalThis.__dirname = fileURLToPath(new URL('../src/main/', import.meta.url))
globalThis.__ballFixture = {
  app: { isPackaged: true, getPath: () => profile }, safeStorage: {}, BrowserWindow: FakeWindow,
  screen: {
    getPrimaryDisplay: () => primary,
    getDisplayNearestPoint(point) {
      pointUsed = point
      return displays.find(({ workArea: a }) => point.x >= a.x && point.x < a.x + a.width &&
        point.y >= a.y && point.y < a.y + a.height) ?? primary
    }
  }
}
const mock = (source) => ({ shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return mock('export const {app, safeStorage, BrowserWindow, screen} = globalThis.__ballFixture')
    if (specifier === './input/hotkey') return mock('export const prettyChord = () => ""')
    if (specifier === './input/windows-input') return mock('export const windowsCursorVisible = () => true')
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  }
})

test('restores legacy left-monitor and new above-monitor positions, then clamps when the monitor is removed', async (t) => {
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ball: { x: -1500, y: 200 } }))
  const { createBallWindow, defaultBallPosition } = await import('../src/main/windows.ts')
  const { settingsStore } = await import('../src/main/store/settings.ts')
  const open = () => {
    const win = createBallWindow()
    const { x, y } = win.getBounds()
    win.emit('closed')
    return { x, y }
  }
  assert.deepEqual(open(), { x: -1500, y: 200 })
  assert.deepEqual(pointUsed, { x: -1370, y: 330 })
  settingsStore.update({ ball: { x: 500, y: -700, positioned: true } })
  assert.deepEqual(open(), { x: 500, y: -700 })
  displays = [primary]
  assert.deepEqual(open(), { x: 500, y: -130 })
  settingsStore.update({ ball: { x: -1, y: -1, positioned: true } })
  assert.deepEqual(open(), { x: -1, y: -1 })
  settingsStore.reset()
  assert.deepEqual(open(), defaultBallPosition())
})
