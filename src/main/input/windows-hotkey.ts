import type { Chord } from './hotkey'

export interface WindowsHotkey {
  key: number
  modifiers: string[] | null
}

const mouseKeys: Record<number, number> = { 3: 0x04, 4: 0x05, 5: 0x06 }

const modifierKeys: Record<string, number[]> = {
  Ctrl: [0x11], Alt: [0x12], Shift: [0x10], Meta: [0x5b, 0x5c]
}

const namedKeys: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, pause: 0x13, capslock: 0x14,
  escape: 0x1b, esc: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, insert: 0x2d, delete: 0x2e,
  numpadmultiply: 0x6a, numpadadd: 0x6b, numpadsubtract: 0x6d, numpaddecimal: 0x6e, numpaddivide: 0x6f,
  numlock: 0x90, scrolllock: 0x91,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde
}

export function windowsHotkey(chord: Chord | null): WindowsHotkey | null {
  if (!chord) return null
  if (chord.type === 'mouse') {
    const key = mouseKeys[chord.button]
    return key ? { key, modifiers: null } : null
  }
  const name = chord.key.toLowerCase()
  let key: number | undefined
  if (/^[a-z0-9]$/.test(name)) key = name.toUpperCase().charCodeAt(0)
  else if (/^numpad[0-9]$/.test(name)) key = 0x60 + Number(name.slice(6))
  else if (/^f(?:[1-9]|1\d|2[0-4])$/.test(name)) key = 0x6f + Number(name.slice(1))
  else if (Object.hasOwn(namedKeys, name)) key = namedKeys[name]
  return key ? { key, modifiers: chord.mods.filter((mod) => Object.hasOwn(modifierKeys, mod)) } : null
}

export function isWindowsHotkeyDown(hotkey: WindowsHotkey, wasDown: boolean, isDown: (key: number) => boolean): boolean {
  if (!isDown(hotkey.key)) return false
  const mods = hotkey.modifiers
  if (!mods) return true
  return Object.entries(modifierKeys).every(([mod, keys]) => {
    const down = keys.some(isDown)
    // 已经按住时，游戏里再按其它修饰键不应该截断录音。
    return mods.includes(mod) ? down : wasDown || !down
  })
}
