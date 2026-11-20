import koffi from 'koffi'
import { isWindowsHotkeyDown, type WindowsHotkey } from './input/windows-hotkey'

const user32 = koffi.load('user32.dll')
const getCursorInfo = user32.func('bool GetCursorInfo(void *info)')
const getAsyncKeyState = user32.func('int16 GetAsyncKeyState(int key)')
const getSystemMetrics = user32.func('int GetSystemMetrics(int index)')

// CURSORINFO 在 Windows x64 占 24 字节，含 DPI 转换前的物理像素坐标。
const cursorInfo = Buffer.alloc(24)
cursorInfo.writeUInt32LE(cursorInfo.length, 0)
const CURSOR_SHOWING = 0x01
const CURSOR_SUPPRESSED = 0x02
const SM_SWAPBUTTON = 23

const isDown = (key: number): boolean => getAsyncKeyState(key) < 0
let cursorVisible: boolean | null | undefined
let leftDown: boolean | undefined
let hotkey: WindowsHotkey | null = null
let hotkeyDown = false
let armed = false
let generation = 0

process.parentPort.on('message', ({ data }: { data: { hotkey: WindowsHotkey | null; generation: number } }) => {
  hotkey = data.hotkey
  generation = data.generation
  hotkeyDown = false
  armed = !hotkey || !isDown(hotkey.key)
  if (hotkey) process.parentPort.postMessage({ type: 'hotkey', generation })
})

setInterval(() => {
  const hasCursorInfo = getCursorInfo(cursorInfo)
  const flags = cursorInfo.readUInt32LE(4)
  const visible = hasCursorInfo
    ? (flags & (CURSOR_SHOWING | CURSOR_SUPPRESSED)) === CURSOR_SHOWING && cursorInfo.readBigUInt64LE(8) !== 0n
    : null
  const left = isDown(getSystemMetrics(SM_SWAPBUTTON) ? 0x02 : 0x01)
  if (visible !== cursorVisible || left !== leftDown) {
    // 首次采样只建立基线，避免应用启动时把已按住的鼠标键当成点击。
    const edge = leftDown !== undefined && left !== leftDown ? left ? 'down' : 'up' : undefined
    cursorVisible = visible
    leftDown = left
    process.parentPort.postMessage({
      type: 'pointer', visible, edge,
      point: hasCursorInfo ? { x: cursorInfo.readInt32LE(16), y: cursorInfo.readInt32LE(20) } : undefined
    })
  }
  if (!hotkey) return
  if (!armed) {
    armed = !isDown(hotkey.key)
    return
  }
  const down = isWindowsHotkeyDown(hotkey, hotkeyDown, isDown)
  if (down !== hotkeyDown) {
    hotkeyDown = down
    process.parentPort.postMessage({ type: 'hotkey', generation, down })
  }
}, 12).unref()
