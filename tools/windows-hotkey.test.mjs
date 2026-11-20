import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isWindowsHotkeyDown, windowsHotkey } from '../src/main/input/windows-hotkey.ts'

test('Windows 键状态补齐鼠标侧键与常用游戏键盘键', () => {
  for (const [button, key] of [[3, 0x04], [4, 0x05], [5, 0x06]]) {
    assert.deepEqual(windowsHotkey({ type: 'mouse', button }), { key, modifiers: null })
  }
  for (const [name, key] of [['v', 0x56], ['7', 0x37], ['Numpad7', 0x67], ['F12', 0x7b], ['Left', 0x25]]) {
    assert.deepEqual(windowsHotkey({ type: 'key', key: name, mods: [] }), { key, modifiers: [] })
  }
  assert.equal(windowsHotkey({ type: 'key', key: 'constructor', mods: [] }), null)
})

test('鼠标热键在游戏移动时照常触发，键盘组合只要求已绑定的键保持按下', () => {
  const mouse = windowsHotkey({ type: 'mouse', button: 4 })
  const chord = windowsHotkey({ type: 'key', key: 'V', mods: ['Ctrl', 'Meta'] })
  const active = new Set([0x05, 0x11, 0x5c, 0x56])
  const isDown = (key) => active.has(key)
  assert.equal(isWindowsHotkeyDown(mouse, false, isDown), true)
  assert.equal(isWindowsHotkeyDown(chord, false, isDown), true)
  active.add(0x10)
  assert.equal(isWindowsHotkeyDown(chord, false, isDown), false)
  assert.equal(isWindowsHotkeyDown(chord, true, isDown), true)
  active.delete(0x11)
  assert.equal(isWindowsHotkeyDown(chord, true, isDown), false)
  active.delete(0x05)
  assert.equal(isWindowsHotkeyDown(mouse, true, isDown), false)
})
