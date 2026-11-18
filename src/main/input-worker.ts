/**
 * 键鼠注入工作进程（utilityProcess）。
 *
 * 为什么单独开进程：
 * - koffi 的 FFI 在 Electron 主进程（Chromium 线程）里会崩（实测 0xC0000005），
 *   在纯 Node 环境里完全正常，所以把原生调用隔离到这个 Node 子进程里；
 * - 顺带好处：注入崩溃不会带走主进程，可以随时重启 worker。
 *
 * 协议：父进程通过 postMessage 发 { id, cmd, args }，这里回 { id, ok, result|error }。
 * 坐标一律是「物理像素」，基于虚拟桌面原点。
 */
import koffi from 'koffi'

const INPUT_SIZE = 40
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1

const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000

const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

const BLOCKED_TITLE = /密码|登录|登陆|支付|password|sign in|sign-in|login/i
const MAX_TYPE_CHARS = 2000

const VK: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  pause: 0x13,
  capslock: 0x14,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  win: 0x5b,
  meta: 0x5b,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde
}
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i
const MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'win', 'meta'])

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const SendInput = user32.func('uint32 SendInput(uint32 cInputs, void *pInputs, int cbSize)')
const GetForegroundWindow = user32.func('intptr GetForegroundWindow()')
const GetWindowTextW = user32.func('int GetWindowTextW(intptr hWnd, void *buf, int max)')
const GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)')
const FindWindowW = user32.func('intptr FindWindowW(str16 lpClassName, str16 lpWindowName)')
const ShowWindow = user32.func('bool ShowWindow(intptr hWnd, int nCmdShow)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr hWnd)')
const BringWindowToTop = user32.func('bool BringWindowToTop(intptr hWnd)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(intptr hWnd, void *pid)')
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 a, uint32 b, bool on)')
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()')
const GetCursorPos = user32.func('bool GetCursorPos(void *p)')
const keybdEvent = user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)')
const OpenInputDesktop = user32.func('intptr OpenInputDesktop(uint32 dwFlags, bool fInherit, uint32 dwDesiredAccess)')
const CloseDesktop = user32.func('bool CloseDesktop(intptr hDesktop)')

/* ------------------------------------------------------------------ 工具 -- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function packKey(vk: number, scan: number, flags: number): Buffer {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(INPUT_KEYBOARD, 0)
  b.writeUInt16LE(vk & 0xffff, 8)
  b.writeUInt16LE(scan & 0xffff, 10)
  b.writeUInt32LE(flags >>> 0, 12)
  return b
}

function packMouse(dx: number, dy: number, data: number, flags: number): Buffer {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(INPUT_MOUSE, 0)
  b.writeInt32LE(dx | 0, 8)
  b.writeInt32LE(dy | 0, 12)
  b.writeUInt32LE(data >>> 0, 16)
  b.writeUInt32LE(flags >>> 0, 20)
  return b
}

function send(events: Buffer[]): boolean {
  if (!events.length) return false
  const sent = Number(SendInput(events.length, Buffer.concat(events), INPUT_SIZE))
  return sent === events.length
}

function windowTitle(hwnd: unknown): string {
  try {
    const buf = Buffer.alloc(512 * 2)
    const n = Number(GetWindowTextW(hwnd, buf, 512))
    if (n <= 0) return ''
    return buf.subarray(0, n * 2).toString('utf16le')
  } catch {
    return ''
  }
}

function foregroundTitle(): string {
  return windowTitle(GetForegroundWindow())
}

function metrics(): { x: number; y: number; width: number; height: number } {
  return {
    x: Number(GetSystemMetrics(SM_XVIRTUALSCREEN)),
    y: Number(GetSystemMetrics(SM_YVIRTUALSCREEN)),
    width: Number(GetSystemMetrics(SM_CXVIRTUALSCREEN)),
    height: Number(GetSystemMetrics(SM_CYVIRTUALSCREEN))
  }
}

function cursorPos(): { x: number; y: number } {
  const b = Buffer.alloc(8)
  GetCursorPos(b)
  return { x: b.readInt32LE(0), y: b.readInt32LE(4) }
}

/** 工作站是否锁定：锁屏后输入注入会被系统静默丢弃 */
function sessionLocked(): boolean {
  try {
    const h = OpenInputDesktop(0, false, 0x0100)
    if (!h) return true
    CloseDesktop(h)
    return false
  } catch {
    return false
  }
}

function assertUnlocked(): void {
  if (sessionLocked()) throw new Error('屏幕已锁定，无法操作电脑')
}

function assertSafe(): void {
  assertUnlocked()
  const title = foregroundTitle()
  if (title && BLOCKED_TITLE.test(title)) {
    throw new Error(`当前窗口「${title}」看起来是登录/支付类页面，已拒绝自动输入`)
  }
}

function assertForeground(expect: string): void {
  const title = foregroundTitle()
  if (!title.includes(expect)) {
    throw new Error(`当前前台窗口是「${title || '未知'}」，不是预期的「${expect}」，已拒绝输入`)
  }
}

function toAbsolute(x: number, y: number): { nx: number; ny: number } {
  const m = metrics()
  const w = Math.max(1, m.width - 1)
  const h = Math.max(1, m.height - 1)
  return {
    nx: Math.max(0, Math.min(65535, Math.round(((x - m.x) * 65535) / w))),
    ny: Math.max(0, Math.min(65535, Math.round(((y - m.y) * 65535) / h)))
  }
}

function move(x: number, y: number): void {
  const { nx, ny } = toAbsolute(x, y)
  if (!send([packMouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])) {
    throw new Error('鼠标移动失败')
  }
}

const BUTTONS = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP]
} as const

function click(opts: { x?: number; y?: number; button?: 'left' | 'right' | 'middle'; count?: number }): void {
  assertUnlocked()
  assertSafe()
  const [down, up] = BUTTONS[opts.button ?? 'left']
  const count = Math.max(1, Math.min(3, Math.round(opts.count ?? 1)))
  if (typeof opts.x === 'number' && typeof opts.y === 'number') move(opts.x, opts.y)
  for (let i = 0; i < count; i++) send([packMouse(0, 0, 0, down), packMouse(0, 0, 0, up)])
}

async function typeText(text: string): Promise<{ length: number; target: string }> {
  const content = String(text ?? '')
  if (!content) throw new Error('没有可输入的内容')
  if (content.length > MAX_TYPE_CHARS) throw new Error(`一次最多输入 ${MAX_TYPE_CHARS} 个字符`)
  assertUnlocked()
  assertSafe()
  const target = foregroundTitle()
  const units: number[] = []
  for (let i = 0; i < content.length; i++) units.push(content.charCodeAt(i))
  const BATCH = 32
  for (let i = 0; i < units.length; i += BATCH) {
    const events: Buffer[] = []
    for (const u of units.slice(i, i + BATCH)) {
      if (u === 0x0a) continue
      if (u === 0x0d) {
        events.push(packKey(0x0d, 0, 0), packKey(0x0d, 0, KEYEVENTF_KEYUP))
        continue
      }
      events.push(packKey(0, u, KEYEVENTF_UNICODE), packKey(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    }
    if (events.length) send(events)
    await sleep(4)
  }
  return { length: content.length, target }
}

function pressKeys(combo: string): void {
  const tokens = String(combo ?? '')
    .toLowerCase()
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length) throw new Error('组合键不能为空')
  assertUnlocked()
  assertSafe()
  const mods: number[] = []
  let keyVk: number | null = null
  for (const t of tokens) {
    const vk = VK[t]
    if (vk === undefined) throw new Error(`不认识的按键：${t}`)
    if (MODIFIERS.has(t)) mods.push(vk)
    else keyVk = vk
  }
  if (keyVk === null) keyVk = mods.pop() ?? 0x11
  const events: Buffer[] = []
  for (const m of mods) events.push(packKey(m, 0, 0))
  events.push(packKey(keyVk, 0, 0), packKey(keyVk, 0, KEYEVENTF_KEYUP))
  for (const m of [...mods].reverse()) events.push(packKey(m, 0, KEYEVENTF_KEYUP))
  if (!send(events)) throw new Error('按键注入失败（可能被系统拦截）')
}

function focusByTitle(title: string): { found: boolean; focused: boolean; foreground: string } {
  const hwnd = Number(FindWindowW(null, title))
  if (!hwnd) return { found: false, focused: false, foreground: foregroundTitle() }
  if (foregroundTitle().includes(title)) return { found: true, focused: true, foreground: title }
  ShowWindow(hwnd, 9)
  keybdEvent(0x12, 0, 0, 0)
  keybdEvent(0x12, 0, KEYEVENTF_KEYUP, 0)
  const targetTid = Number(GetWindowThreadProcessId(hwnd, null))
  const selfTid = Number(GetCurrentThreadId())
  let attached = false
  try {
    if (targetTid && targetTid !== selfTid) attached = Boolean(AttachThreadInput(selfTid, targetTid, true))
    BringWindowToTop(hwnd)
    SetForegroundWindow(hwnd)
  } finally {
    if (attached) {
      try {
        AttachThreadInput(selfTid, targetTid, false)
      } catch {
        /* ignore */
      }
    }
  }
  for (let i = 0; i < 5; i++) {
    if (foregroundTitle().includes(title)) break
    SetForegroundWindow(hwnd)
  }
  const fg = foregroundTitle()
  return { found: true, focused: fg.includes(title), foreground: fg }
}

/* ---------------------------------------------------------------- 命令分发 -- */

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>

const handlers: Record<string, Handler> = {
  ping: () => 'pong',
  locked: () => sessionLocked(),
  metrics,
  cursor: cursorPos,
  foreground: () => ({ title: foregroundTitle() }),
  findWindow: (a) => Number(FindWindowW(null, String(a.title ?? ''))) > 0,
  focus: (a) => focusByTitle(String(a.title ?? '')),
  type: async (a) => typeText(String(a.text ?? '')),
  key: (a) => {
    pressKeys(String(a.keys ?? ''))
    return { ok: true }
  },
  move: (a) => {
    const before = cursorPos()
    const x = Number(a.x)
    const y = Number(a.y)
    const { nx, ny } = toAbsolute(x, y)
    const sent = send([packMouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
    const after = cursorPos()
    return { ok: sent, sent, normalized: { nx, ny }, before, after, target: { x, y } }
  },
  click: (a) =>
    {
      click({
        x: typeof a.x === 'number' ? a.x : undefined,
        y: typeof a.y === 'number' ? a.y : undefined,
        button: (a.button as 'left' | 'right' | 'middle') ?? 'left',
        count: Number(a.count ?? 1)
      })
      return { ok: true }
    },
  scroll: (a) => {
    send([packMouse(0, 0, Math.round(Number(a.notches ?? 0) * 120), MOUSEEVENTF_WHEEL)])
    return { ok: true }
  },
  drag: async (a) => {
    assertSafe()
    const from = a.from as { x: number; y: number }
    const to = a.to as { x: number; y: number }
    move(from.x, from.y)
    await sleep(60)
    send([packMouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN)])
    try {
      for (let i = 1; i <= 12; i++) {
        move(Math.round(from.x + ((to.x - from.x) * i) / 12), Math.round(from.y + ((to.y - from.y) * i) / 12))
        await sleep(18)
      }
    } finally {
      send([packMouse(0, 0, 0, MOUSEEVENTF_LEFTUP)])
    }
    return { ok: true }
  },
  assertSafe: (a) => {
    if (a.expectTitle) assertForeground(String(a.expectTitle))
    return { ok: true }
  }
}

interface Request {
  id: number
  cmd: string
  args?: Record<string, unknown>
}

process.parentPort.on('message', (e) => {
  const req = e.data as Request
  if (!req || typeof req.id !== 'number') return
  const handler = handlers[req.cmd]
  if (!handler) {
    process.parentPort.postMessage({ id: req.id, ok: false, error: `未知命令：${req.cmd}` })
    return
  }
  Promise.resolve()
    .then(() => handler(req.args ?? {}))
    .then((result) => process.parentPort.postMessage({ id: req.id, ok: true, result }))
    .catch((err: unknown) =>
      process.parentPort.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    )
})

process.parentPort.postMessage({ id: 0, ok: true, result: 'ready' })
