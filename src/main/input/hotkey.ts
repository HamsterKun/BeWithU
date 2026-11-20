import { globalShortcut } from 'electron'
import { log } from '../logger'
import { windowsHotkey } from './windows-hotkey'
import { stopWatchingWindowsInput, watchWindowsInput } from './windows-input'

/* ---------------------------------------------------------------------------
 * 全局键鼠监听：uiohook 负责捕获事件，Windows 键状态补齐游戏里丢失的事件。
 * 两路都不可用时才依赖只支持按下事件的 globalShortcut。
 * ------------------------------------------------------------------------ */

export type Chord = { type: 'key'; mods: string[]; key: string } | { type: 'mouse'; button: number }

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta']

interface UiohookEvent {
  keycode: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

let uio: typeof import('uiohook-napi').uIOhook | null = null
let keyNames: Map<number, string> = new Map()
let modifierCodes = new Map<number, string>()
let hotkeySpec: Chord | null = null
let rawHotkey = ''
let active = false
let activeFromNative = false
let listener: ((phase: 'down' | 'up') => void) | null = null
let started = false
let usingFallback = false
let fallbackAccelerator: string | null = null
let nativeReady = false
let nativeEdge: NodeJS.Timeout | undefined
let captureResolve: ((chord: string) => void) | null = null
let globalMouseDown: ((button: number) => void) | null = null
let globalMouseUp: ((button: number) => void) | null = null

function forceFallback(): boolean {
  return process.env['BWU_AGENT_TEST'] === '1' && process.env['BWU_HOTKEY_FALLBACK'] === '1'
}

export function parseChord(raw: string): Chord | null {
  if (!raw) return null
  const text = raw.trim()
  const mouse = /^mouse\s*([345])$/i.exec(text)
  if (mouse) return { type: 'mouse', button: Number(mouse[1]) }
  const parts = text
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((m) => {
    const low = m.toLowerCase()
    if (low === 'ctrl' || low === 'control') return 'Ctrl'
    if (low === 'alt' || low === 'option') return 'Alt'
    if (low === 'shift') return 'Shift'
    if (low === 'meta' || low === 'win' || low === 'cmd' || low === 'super') return 'Meta'
    return m
  })
  return { type: 'key', mods, key }
}

export function chordToString(chord: Chord): string {
  if (chord.type === 'mouse') return `Mouse${chord.button}`
  const mods = MOD_ORDER.filter((m) => chord.mods.includes(m))
  return [...mods, chord.key].join('+')
}

export function normalizeChord(raw: string): string {
  const parsed = parseChord(raw)
  return parsed ? chordToString(parsed) : raw
}

export function prettyChord(raw: string): string {
  const chord = parseChord(raw)
  if (!chord) return raw
  if (chord.type === 'mouse') {
    return chord.button === 4 ? '鼠标侧键 1' : chord.button === 5 ? '鼠标侧键 2' : '鼠标中键'
  }
  return chordToString(chord).replace(/\+/g, ' + ')
}

function buildKeyMaps(UiohookKey: Record<string, number>): void {
  const names = new Map<number, string>()
  const mods = new Map<number, string>()
  const alias: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  }
  for (const [name, code] of Object.entries(UiohookKey)) {
    if (typeof code !== 'number') continue
    const mod = /^(Alt|Ctrl|Shift|Meta)(Right|Left)?$/.exec(name)
    if (mod) {
      mods.set(code, mod[1])
      continue
    }
    if (/Right$/.test(name) && names.has(code)) continue
    const display = name.length === 1 ? name.toUpperCase() : (alias[name] ?? name)
    if (!names.has(code) || /Left$/.test(name)) names.set(code, display)
  }
  keyNames = names
  modifierCodes = mods
}

function initUiohook(): boolean {
  if (uio) return true
  // 仅测试用：强制走降级路径，验证"降级=切换模式"的行为
  if (forceFallback()) {
    log('hotkey: 测试开关 BWU_HOTKEY_FALLBACK=1，强制降级')
    return false
  }
  try {
    const mod = require('uiohook-napi') as typeof import('uiohook-napi')
    buildKeyMaps(mod.UiohookKey ?? {})
    uio = mod.uIOhook
    uio.on('keydown', (e: UiohookEvent) => onKey('down', e))
    uio.on('keyup', (e: UiohookEvent) => onKey('up', e))
    uio.on('mousedown', (e) => onMouse('down', e.button))
    uio.on('mouseup', (e) => onMouse('up', e.button))
    return true
  } catch (e) {
    log('hotkey: uiohook 加载失败，降级 globalShortcut', e)
    uio = null
    return false
  }
}

function modsOf(e: UiohookEvent): string[] {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Meta')
  return mods
}

function matches(chord: Chord, e: UiohookEvent): boolean {
  if (chord.type !== 'key') return false
  const name = keyNames.get(e.keycode)
  if (!name || name.toLowerCase() !== chord.key.toLowerCase()) return false
  const mods = modsOf(e)
  const want = MOD_ORDER.filter((m) => chord.mods.includes(m))
  return want.length === mods.length && want.every((m) => mods.includes(m))
}

function setActive(down: boolean, fromNative = false): void {
  activeFromNative = down && fromNative
  if (active === down) return
  active = down
  listener?.(down ? 'down' : 'up')
}

function clearNativeEdge(): void {
  if (nativeEdge) clearTimeout(nativeEdge)
  nativeEdge = undefined
}

function onNativeHotkey(down?: boolean | null): void {
  if (forceFallback()) return
  clearNativeEdge()
  nativeReady = down !== null
  if (down === null && activeFromNative) setActive(false)
  if (!started) {
    if (down === null) {
      setActive(false)
      if (!usingFallback) startFallback(rawHotkey)
    } else {
      stopFallback()
      if (down !== undefined && !captureResolve) setActive(down, true)
    }
    return
  }
  if (down == null || down === active || captureResolve) return
  // 钩子先处理正常事件；给状态轮询留一个短窗口来补漏，避免同一次按键切换两次。
  nativeEdge = setTimeout(() => {
    nativeEdge = undefined
    if (!captureResolve) setActive(down, true)
  }, 36)
}

function finishCapture(chord: string): void {
  const resolve = captureResolve
  captureResolve = null
  clearNativeEdge()
  watchWindowsInput(forceFallback() ? null : windowsHotkey(hotkeySpec), onNativeHotkey)
  resolve?.(chord)
}

function onKey(phase: 'down' | 'up', e: UiohookEvent): void {
  if (captureResolve && phase === 'down' && !modifierCodes.has(e.keycode)) {
    const name = keyNames.get(e.keycode)
    if (name) {
      const chord = chordToString({ type: 'key', mods: modsOf(e), key: name })
      finishCapture(chord)
      return
    }
  }

  if (hotkeySpec?.type !== 'key') return
  const mod = modifierCodes.get(e.keycode)
  const released = mod ? hotkeySpec.mods.includes(mod) : keyNames.get(e.keycode)?.toLowerCase() === hotkeySpec.key.toLowerCase()
  if (phase === 'down' ? matches(hotkeySpec, e) : released) {
    clearNativeEdge()
    setActive(phase === 'down')
  }
}

function onMouse(phase: 'down' | 'up', button: unknown): void {
  if (typeof button !== 'number') return
  if (phase === 'down' && captureResolve && button >= 3 && button <= 5) {
    finishCapture(`Mouse${button}`)
    return
  }
  if (hotkeySpec?.type === 'mouse' && hotkeySpec.button === button) {
    clearNativeEdge()
    setActive(phase === 'down')
  }
  if (phase === 'down') globalMouseDown?.(button)
  else globalMouseUp?.(button)
}

export function hotkeyStatus(): { ok: boolean; message: string } {
  if (usingFallback) {
    if (hotkeySpec?.type === 'mouse') {
      return { ok: false, message: '受系统限制，鼠标键监听不了；已按切换模式处理，请在设置里改用键盘组合' }
    }
    if (!fallbackAccelerator) return { ok: false, message: '受系统限制，按键注册失败；请到设置里换一个键盘组合' }
    return { ok: false, message: '受系统限制，已降级为切换模式（按下开始、再按结束）' }
  }
  return started || nativeReady ? { ok: true, message: '按键监听正常' } : { ok: false, message: '按键监听未启动' }
}

/** 是否处于降级监听（降级时只能用切换模式） */
export function isHotkeyFallback(): boolean {
  return usingFallback
}

export function startHotkey(rawSpec: string, cb: (phase: 'down' | 'up') => void): void {
  listener = cb
  reloadHotkey(rawSpec)
}

function startHook(): void {
  if (started || !initUiohook()) return
  if (uio) {
    try {
      uio.start()
      started = true
    } catch (e) {
      log('hotkey: start 失败', e)
    }
  }
}

function startFallback(rawSpec: string): void {
  usingFallback = true
  const chord = parseChord(rawSpec)
  if (!chord || chord.type !== 'key') {
    log('hotkey: 降级路径只能注册键盘组合，鼠标键无法监听', rawSpec)
    return
  }
  try {
    const accelerator = chordToString(chord)
    if (globalShortcut.register(accelerator, () => {
      if (!captureResolve) listener?.('down')
    })) fallbackAccelerator = accelerator
    else log('hotkey: globalShortcut 注册失败', rawSpec)
  } catch (e) {
    log('hotkey: globalShortcut 注册失败', e)
  }
}

function stopFallback(): void {
  if (fallbackAccelerator) globalShortcut.unregister(fallbackAccelerator)
  fallbackAccelerator = null
  usingFallback = false
}

export function reloadHotkey(rawSpec: string): void {
  setActive(false)
  clearNativeEdge()
  stopFallback()
  rawHotkey = rawSpec
  hotkeySpec = parseChord(rawSpec)
  nativeReady = false
  startHook()
  if (!started) startFallback(rawSpec)
  watchWindowsInput(forceFallback() ? null : windowsHotkey(hotkeySpec), onNativeHotkey)
  if (started) log(`hotkey: 已监听 ${rawSpec} (${prettyChord(rawSpec)})`)
}

export function captureNextChord(): Promise<string> {
  startHook()
  if (!started) return Promise.resolve('')
  captureResolve?.('')
  return new Promise((resolve) => {
    captureResolve = resolve
    setTimeout(() => {
      if (captureResolve === resolve) {
        finishCapture('')
      }
    }, 15000)
  })
}

export function setGlobalMouseHandlers(down: ((b: number) => void) | null, up: ((b: number) => void) | null): void {
  globalMouseDown = down
  globalMouseUp = up
}

export function stopHotkey(): void {
  stopFallback()
  clearNativeEdge()
  stopWatchingWindowsInput()
  captureResolve?.('')
  captureResolve = null
  if (uio && started) {
    try {
      uio.stop()
    } catch {
      /* ignore */
    }
    started = false
  }
}
