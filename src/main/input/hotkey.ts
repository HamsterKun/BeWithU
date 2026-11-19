import { globalShortcut } from 'electron'
import { log } from '../logger'

/* ---------------------------------------------------------------------------
 * 全局键鼠监听：优先用 uiohook-napi（能拿到 keyup 与鼠标侧键），
 * 失败时降级为 Electron globalShortcut（只能拿到按下，按住模式会退化为切换）。
 * ------------------------------------------------------------------------ */

type Chord = { type: 'key'; mods: string[]; key: string } | { type: 'mouse'; button: number }

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta']

interface UiohookEvent {
  keycode: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

let uio: any = null
let keyNames: Map<number, string> = new Map()
let modifierCodes: Set<number> = new Set()
let hotkeySpec: Chord | null = null
let active = false
let activeKey = ''
let listener: ((phase: 'down' | 'up') => void) | null = null
let started = false
let usingFallback = false
/** 降级时是否真的注册上了（鼠标键在降级路径下注册不了） */
let fallbackRegistered = false
let captureResolve: ((chord: string) => void) | null = null
let globalMouseDown: ((button: number) => void) | null = null
let globalMouseUp: ((button: number) => void) | null = null
let globalMouseMove: ((x: number, y: number) => void) | null = null

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
  const mods = new Set<number>()
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
    if (/^(Alt|Ctrl|Shift|Meta)(Right|Left)?$/.test(name)) {
      mods.add(code)
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
  if (process.env['BWU_AGENT_TEST'] === '1' && process.env['BWU_HOTKEY_FALLBACK'] === '1') {
    log('hotkey: 测试开关 BWU_HOTKEY_FALLBACK=1，强制降级')
    return false
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('uiohook-napi')
    buildKeyMaps(mod.UiohookKey ?? {})
    uio = mod.uIOhook
    uio.on('keydown', (e: UiohookEvent) => onKey('down', e))
    uio.on('keyup', (e: UiohookEvent) => onKey('up', e))
    uio.on('mousedown', (e: { button: number }) => onMouse('down', e.button))
    uio.on('mouseup', (e: { button: number }) => onMouse('up', e.button))
    uio.on('mousemove', (e: { x: number; y: number }) => {
      if (globalMouseMove) globalMouseMove(e.x, e.y)
    })
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

function onKey(phase: 'down' | 'up', e: UiohookEvent): void {
  if (captureResolve && phase === 'down' && !modifierCodes.has(e.keycode)) {
    const name = keyNames.get(e.keycode)
    if (name) {
      const chord = chordToString({ type: 'key', mods: modsOf(e), key: name })
      const resolve = captureResolve
      captureResolve = null
      resolve(chord)
      return
    }
  }

  if (phase === 'down') {
    if (modifierCodes.has(e.keycode) || active) return
    if (hotkeySpec && matches(hotkeySpec, e)) {
      active = true
      activeKey = keyNames.get(e.keycode) ?? ''
      listener?.('down')
    }
    return
  }

  if (!active) return
  const name = keyNames.get(e.keycode)
  if (modifierCodes.has(e.keycode) || (name && name.toLowerCase() === activeKey.toLowerCase())) {
    active = false
    listener?.('up')
  }
}

function onMouse(phase: 'down' | 'up', button: number): void {
  if (phase === 'down') {
    if (captureResolve && button >= 3) {
      const resolve = captureResolve
      captureResolve = null
      resolve(`Mouse${button}`)
      globalMouseDown?.(button)
      return
    }
    if (hotkeySpec?.type === 'mouse' && hotkeySpec.button === button && !active) {
      active = true
      listener?.('down')
    }
    globalMouseDown?.(button)
  } else {
    if (hotkeySpec?.type === 'mouse' && hotkeySpec.button === button && active) {
      active = false
      listener?.('up')
    }
    globalMouseUp?.(button)
  }
}

export function hotkeyStatus(): { ok: boolean; message: string } {
  if (usingFallback) {
    if (hotkeySpec?.type === 'mouse') {
      return { ok: false, message: '受系统限制，鼠标键监听不了；已按切换模式处理，请在设置里改用键盘组合' }
    }
    if (!fallbackRegistered) return { ok: false, message: '受系统限制，按键注册失败；请到设置里换一个键盘组合' }
    return { ok: false, message: '受系统限制，已降级为切换模式（按下开始、再按结束）' }
  }
  if (!uio) return { ok: false, message: '按键监听未启动' }
  return started ? { ok: true, message: '按键监听正常' } : { ok: false, message: '按键监听未启动' }
}

/** 是否处于降级监听（降级时只能用切换模式） */
export function isHotkeyFallback(): boolean {
  return usingFallback
}

export function startHotkey(rawSpec: string, cb: (phase: 'down' | 'up') => void): void {
  listener = cb
  hotkeySpec = parseChord(rawSpec)
  active = false

  if (!initUiohook()) {
    startFallback(rawSpec)
    return
  }
  if (!started) {
    try {
      uio.start()
      started = true
    } catch (e) {
      log('hotkey: start 失败', e)
      startFallback(rawSpec)
      return
    }
  }
  usingFallback = false
  log(`hotkey: 已监听 ${rawSpec} (${prettyChord(rawSpec)})`)
}

function startFallback(rawSpec: string): void {
  usingFallback = true
  fallbackRegistered = false
  const chord = parseChord(rawSpec)
  if (!chord || chord.type !== 'key') {
    log('hotkey: 降级路径只能注册键盘组合，鼠标键无法监听', rawSpec)
    return
  }
  try {
    fallbackRegistered = globalShortcut.register(chordToString(chord), () => {
      listener?.('down')
      setTimeout(() => listener?.('up'), 60)
    })
    if (!fallbackRegistered) log('hotkey: globalShortcut 注册失败', rawSpec)
  } catch (e) {
    fallbackRegistered = false
    log('hotkey: globalShortcut 注册失败', e)
  }
}

export function reloadHotkey(rawSpec: string): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
  if (uio && started) {
    try {
      uio.stop()
    } catch {
      /* ignore */
    }
    started = false
  }
  active = false
  hotkeySpec = null
  if (listener) startHotkey(rawSpec, listener)
}

export function captureNextChord(): Promise<string> {
  if (!initUiohook()) return Promise.resolve('')
  if (!started) {
    try {
      uio.start()
      started = true
    } catch {
      return Promise.resolve('')
    }
  }
  return new Promise((resolve) => {
    captureResolve = resolve
    setTimeout(() => {
      if (captureResolve === resolve) {
        captureResolve = null
        resolve('')
      }
    }, 15000)
  })
}

export function setGlobalMouseHandlers(down: ((b: number) => void) | null, up: ((b: number) => void) | null): void {
  globalMouseDown = down
  globalMouseUp = up
}

/** 全局光标位置（用于悬浮球圆形命中测试） */
export function setGlobalMouseMoveHandler(fn: ((x: number, y: number) => void) | null): void {
  globalMouseMove = fn
}

export function stopHotkey(): void {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
  if (uio && started) {
    try {
      uio.stop()
    } catch {
      /* ignore */
    }
    started = false
  }
}
