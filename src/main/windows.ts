import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { BallMenuItem, Phase, PublicSettings } from '../shared/types'
import { IPC, type AgentProgress } from '../shared/ipc'
import { settingsStore } from './store/settings'
import { prettyChord } from './input/hotkey'
import { log } from './logger'

/**
 * 悬浮球窗口边长。必须容得下最大球体（152px）+ 外圈光弧（+26px）×1.12，
 * 还要留出投影的模糊半径（36px）+ 下偏移（14px），否则大尺寸时阴影会被窗口直角裁断。
 * 200 时 152 的球只剩 24px 余量，阴影会被切出"断裂感"，所以放到 260。
 */
export const BALL_WIN_SIZE = 260
export const BUBBLE_PAD = 20
/** 气泡卡片与外圈光弧之间的横向留白 */
const BUBBLE_GAP = 18

let ballWin: BrowserWindow | null = null
let bubbleWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let bubbleCard = { w: 340, h: 260 }
let bubbleSide: 'left' | 'right' = 'right'
let bubblePinned = false
let bubbleVisible = false
let bubbleVisibleAt = 0

const devUrl = process.env['ELECTRON_RENDERER_URL']

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function loadRenderer(win: BrowserWindow, page: 'ball' | 'bubble' | 'settings' | 'menu'): void {
  if (devUrl) void win.loadURL(`${devUrl}/${page}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

function baseWebPrefs(): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
    spellcheck: false,
    backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required'
  }
}

/* ------------------------------------------------------------------ ball -- */

export function defaultBallPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  // 窗口变大后按中心补偿，保证球在默认位置看起来没变（原 48 / 150 是按 200 算的）
  const pad = (BALL_WIN_SIZE - 200) / 2
  return {
    x: Math.round(workArea.x + workArea.width - BALL_WIN_SIZE - 48 + pad),
    y: Math.round(workArea.y + workArea.height - BALL_WIN_SIZE - 150 + pad)
  }
}

function clampToDisplays(x: number, y: number): { x: number; y: number } {
  const displays = screen.getAllDisplays()
  const nearest = displays
    .map((d) => ({
      d,
      dist: Math.hypot(d.workArea.x + d.workArea.width / 2 - x, d.workArea.y + d.workArea.height / 2 - y)
    }))
    .sort((a, b) => a.dist - b.dist)[0].d
  const wa = nearest.workArea
  return {
    x: Math.min(Math.max(x, wa.x - BALL_WIN_SIZE / 2), wa.x + wa.width - BALL_WIN_SIZE / 2),
    y: Math.min(Math.max(y, wa.y - BALL_WIN_SIZE / 2), wa.y + wa.height - BALL_WIN_SIZE / 2)
  }
}

export function createBallWindow(): BrowserWindow {
  if (ballWin && !ballWin.isDestroyed()) return ballWin
  const s = settingsStore.get()
  let pos = { x: s.ball.x, y: s.ball.y }
  if (pos.x < -0.5 || pos.y < -0.5) pos = defaultBallPosition()
  pos = clampToDisplays(pos.x, pos.y)

  ballWin = new BrowserWindow({
    width: BALL_WIN_SIZE,
    height: BALL_WIN_SIZE,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    roundedCorners: false,
    title: 'BeWithU',
    webPreferences: baseWebPrefs()
  })

  ballWin.setAlwaysOnTop(true, 'screen-saver')
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 默认整块穿透；主进程轮询光标（updateHitTests），光标进到球体圆内才恢复可点击
  ballWin.setIgnoreMouseEvents(true)
  loadRenderer(ballWin, 'ball')

  ballWin.once('ready-to-show', () => {
    ballWin?.showInactive()
    if (ballWin) forceRelayout(ballWin)
    if (settingsStore.get().ball.x < 0) {
      const b = ballWin!.getBounds()
      settingsStore.update({ ball: { x: b.x, y: b.y } })
    }
  })
  ballWin.on('closed', () => {
    ballWin = null
  })
  // 菜单开着时拖球：实时跟着走（move 事件比定时轮询更跟手）
  ballWin.on('move', () => {
    if (menuVisible) layoutMenu()
  })
  return ballWin
}

export function getBallWindow(): BrowserWindow | null {
  return ballWin && !ballWin.isDestroyed() ? ballWin : null
}

export function getBallBounds(): Electron.Rectangle | null {
  return getBallWindow()?.getBounds() ?? null
}

let ballClickThrough = true

function setBallIgnore(through: boolean): void {
  const win = getBallWindow()
  if (!win) return
  if (through === ballClickThrough) return
  ballClickThrough = through
  win.setIgnoreMouseEvents(through)
}

export function ballCenter(): { x: number; y: number } | null {
  const b = getBallBounds()
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null
}

export function setBallPosition(x: number, y: number): void {
  const win = getBallWindow()
  if (!win) return
  const p = clampToDisplays(Math.round(x), Math.round(y))
  win.setPosition(p.x, p.y, false)
  if (bubbleVisible) layoutBubble()
}

/* ---------------------------------------------------------------- bubble -- */

function createBubbleWindow(): BrowserWindow {
  bubbleWin = new BrowserWindow({
    width: bubbleCard.w + BUBBLE_PAD * 2,
    height: bubbleCard.h + BUBBLE_PAD * 2,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    roundedCorners: false,
    title: 'BeWithU Bubble',
    webPreferences: baseWebPrefs()
  })
  bubbleWin.setAlwaysOnTop(true, 'screen-saver')
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  bubbleWin.setSkipTaskbar(true)
  loadRenderer(bubbleWin, 'bubble')
  bubbleWin.on('closed', () => {
    bubbleWin = null
    bubbleVisible = false
  })
  return bubbleWin
}

export function preloadBubble(): void {
  const win = getBubbleWindow() ?? createBubbleWindow()
  win.webContents.once('did-finish-load', () => sendBubbleMeta())
}

export function getBubbleWindow(): BrowserWindow | null {
  return bubbleWin && !bubbleWin.isDestroyed() ? bubbleWin : null
}

export function isBubbleVisible(): boolean {
  return bubbleVisible
}

export function bubbleBounds(): Electron.Rectangle | null {
  const w = getBubbleWindow()
  return w && bubbleVisible ? w.getBounds() : null
}

export function layoutBubble(): void {
  const win = getBubbleWindow()
  const center = ballCenter()
  if (!win || !center) return
  const s = settingsStore.get()
  const radius = s.ball.size / 2
  // 外圈呼吸光弧：直径 = 球 + 26，并随音量最多放大 1.12 倍。
  // 气泡卡片的边缘要落在光弧之外，否则会压住呼吸光。
  const ringRadius = (radius + 13) * 1.12
  const display = screen.getDisplayNearestPoint({ x: Math.round(center.x), y: Math.round(center.y) })
  const wa = display.workArea
  const winW = bubbleCard.w + BUBBLE_PAD * 2
  const winH = bubbleCard.h + BUBBLE_PAD * 2

  const spaceRight = wa.x + wa.width - (center.x + radius)
  const spaceLeft = center.x - radius - wa.x
  bubbleSide = spaceRight >= winW + 12 || spaceRight >= spaceLeft ? 'right' : 'left'

  const edge = center.x + (bubbleSide === 'right' ? ringRadius : -ringRadius)
  let x =
    bubbleSide === 'right'
      ? edge + BUBBLE_GAP - BUBBLE_PAD
      : edge - BUBBLE_GAP - bubbleCard.w - BUBBLE_PAD
  let y = center.y - winH / 2

  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - winW - 4)
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - winH - 4)
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: winW, height: winH })
  win.webContents.send(IPC.bubbleUpdate, { type: 'anchor', side: bubbleSide })
}

export function setBubbleCardSize(w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 120 || h < 40) return
  const nw = Math.max(240, Math.min(460, Math.round(w)))
  const nh = Math.max(72, Math.min(520, Math.round(h)))
  if (Math.abs(nw - bubbleCard.w) < 1 && Math.abs(nh - bubbleCard.h) < 1) return
  bubbleCard = { w: nw, h: nh }
  layoutBubble()
}

/**
 * 透明窗口被隐藏/挪走后再显示时，Chromium 的渲染子窗口可能没有回到正确位置，
 * 症状是"鼠标移动有效、但点不动"（按钮/拖动全失效）。
 * 做一次 1px 的真实 resize 可以强制它重排，代价可忽略。
 */
function forceRelayout(win: BrowserWindow): void {
  try {
    const b = win.getBounds()
    win.setBounds({ x: b.x, y: b.y, width: Math.max(120, b.width - 1), height: b.height })
    win.setBounds(b)
  } catch (e) {
    log('windows: relayout 失败', e)
  }
}

/** 气泡窗口是否已经 show 过一次 */
let bubbleShownOnce = false
/** 隐藏时把窗口挪到屏幕外，而不是 hide()。
 *  hide()/show() 之后，非激活透明窗口会收到 mousemove 却收不到鼠标按下，
 *  表现为"气泡看得见但按钮点不动"（Electron/Windows 的老问题）。 */
const OFFSCREEN = -32000

export function showBubble(): void {
  // 菜单开着的时候不弹气泡：气泡是置顶窗口，盖上来会吃掉菜单的点击
  if (menuVisible) return
  log('bubble: show')
  const win = getBubbleWindow() ?? createBubbleWindow()
  bubbleVisible = true
  bubbleVisibleAt = Date.now()
  if (!bubbleShownOnce) {
    bubbleShownOnce = true
    win.showInactive()
  }
  layoutBubble()
  // 隐藏期间窗口被挪走过，强制重排一次，否则按钮点不动
  forceRelayout(win)
  // 气泡永远压在悬浮球窗口之上，避免球窗口吃掉气泡上的点击
  if (!win.isDestroyed()) win.moveTop()
  sendBubbleMeta()
  // 以主进程为准同步一次固定状态，页面重载后也不会错位
  sendBubble({ type: 'pin', pinned: bubblePinned })
  // 隐藏状态下 Chromium 量不到真实尺寸，显示后让渲染进程重新报一次
  const askMeasure = (): void => {
    if (!win.isDestroyed() && win.isVisible()) win.webContents.send(IPC.bubbleMeasure)
  }
  setTimeout(askMeasure, 30)
  setTimeout(askMeasure, 180)
}

export function hideBubble(): void {
  log('bubble: hide')
  const win = getBubbleWindow()
  const wasPinned = bubblePinned
  bubbleVisible = false
  bubblePinned = false
  if (win) {
    const b = win.getBounds()
    win.setBounds({ x: OFFSCREEN, y: OFFSCREEN, width: b.width, height: b.height })
  }
  // 收起时固定状态一并复位，避免下次弹出还显示"已固定"
  if (wasPinned) sendBubble({ type: 'pin', pinned: false })
}

/* ------------------------------------------------- bubble 交互（穿透/焦点） -- */

/** 气泡卡片的屏幕矩形（窗口四周有 BUBBLE_PAD 的透明内边距） */
function bubbleCardRect(): Electron.Rectangle | null {
  const win = getBubbleWindow()
  if (!win || !bubbleVisible) return null
  const r = win.getBounds()
  return {
    x: r.x + BUBBLE_PAD,
    y: r.y + BUBBLE_PAD,
    width: r.width - BUBBLE_PAD * 2,
    height: r.height - BUBBLE_PAD * 2
  }
}

/**
 * 主进程轮询光标，维护悬浮球的点击穿透：
 * 只有"球体圆内、且不在气泡卡片上"的区域可点，其余一律穿透。
 * 这样球和气泡无论谁在上层，都不会吃掉对方区域里的点击。
 * （气泡窗口本身始终可交互，不做穿透切换——切换后会出现"显示着却点不到"的问题。）
 */
export function updateHitTests(): void {
  const cursor = screen.getCursorScreenPoint()
  const bw = getBallWindow()
  if (!bw || !bw.isVisible()) return
  const b = bw.getBounds()
  const size = settingsStore.get().ball.size
  const inCircle =
    Math.hypot(cursor.x - (b.x + b.width / 2), cursor.y - (b.y + b.height / 2)) <= size / 2 + 8
  const card = bubbleCardRect()
  const overBubble = Boolean(
    card &&
      cursor.x >= card.x &&
      cursor.x <= card.x + card.width &&
      cursor.y >= card.y &&
      cursor.y <= card.y + card.height
  )
  setBallIgnore(!inCircle || overBubble)
}

/** 打字时临时允许窗口获得键盘焦点（平时不抢焦点） */
export function focusBubble(): void {
  const win = getBubbleWindow()
  if (!win) return
  try {
    win.setFocusable(true)
    win.focus()
  } catch (e) {
    log('bubble: 聚焦失败', e)
  }
}

export function releaseBubbleFocus(): void {
  const win = getBubbleWindow()
  if (!win) return
  try {
    if (win.isFocused()) win.blur()
    win.setFocusable(false)
  } catch {
    /* ignore */
  }
}

export function isBubbleFocused(): boolean {
  const win = getBubbleWindow()
  return Boolean(win && !win.isDestroyed() && win.isFocused())
}

export function toggleBubble(): void {
  if (bubbleVisible) hideBubble()
  else showBubble()
}

export function setBubblePinned(pinned: boolean): void {
  bubblePinned = pinned
  // 回推给气泡，否则固定按钮的高亮/取消固定都失效
  sendBubble({ type: 'pin', pinned })
}

export function isBubblePinned(): boolean {
  return bubblePinned
}

export function sendBubble(payload: unknown): void {
  const win = getBubbleWindow()
  if (win) win.webContents.send(IPC.bubbleUpdate, payload)
}

function sendBubbleMeta(): void {
  const s = settingsStore.get()
  sendBubble({
    type: 'meta',
    assistantName: (s.ui.assistantName || '').trim() || 'TA',
    silent: !s.tts.enabled || s.ui.muted,
    hotkey: prettyChord(s.voice.hotkey)
  })
}

/* ------------------------------------------------------------------ menu -- */

let menuWin: BrowserWindow | null = null
let menuVisible = false
/** 菜单卡片的内容尺寸（不含投影留白） */
let menuSize = { w: 190, h: 300 }
/** 卡片四周留白：给投影留空间，否则圆角外会出现直角阴影 */
const MENU_PAD = 14
let menuAnchor: Electron.Rectangle | null = null
let followTimer: NodeJS.Timeout | null = null

function createMenuWindow(): BrowserWindow {
  menuWin = new BrowserWindow({
    width: menuSize.w + MENU_PAD * 2,
    height: menuSize.h + MENU_PAD * 2,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // 必须可聚焦：点桌面时窗口 blur，主进程据此关掉菜单
    focusable: true,
    roundedCorners: false,
    title: 'BeWithU Menu',
    webPreferences: baseWebPrefs()
  })
  menuWin.setAlwaysOnTop(true, 'screen-saver')
  menuWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  menuWin.setSkipTaskbar(true)
  loadRenderer(menuWin, 'menu')
  menuWin.on('blur', () => hideBallMenu())
  menuWin.on('closed', () => {
    menuWin = null
    menuVisible = false
  })
  return menuWin
}

export function getMenuWindow(): BrowserWindow | null {
  return menuWin && !menuWin.isDestroyed() ? menuWin : null
}

export function isMenuVisible(): boolean {
  return menuVisible
}

export function setMenuSize(w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return
  const nw = Math.max(140, Math.min(320, Math.round(w)))
  const nh = Math.max(80, Math.min(640, Math.round(h)))
  if (Math.abs(nw - menuSize.w) < 1 && Math.abs(nh - menuSize.h) < 1) return
  menuSize = { w: nw, h: nh }
  layoutMenu()
}

function clampNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max))
}

/**
 * 菜单布局：
 * - 有 anchor（托盘）时贴着图标右对齐、向上展开
 * - 否则贴在球的外侧，优先右边、放不下改左边；菜单开着时跟着球走
 * 窗口比卡片大 MENU_PAD*2，投影画在留白里，圆角才不会被切出直角。
 */
function layoutMenu(): void {
  const win = getMenuWindow()
  if (!win) return
  const cardW = menuSize.w
  const cardH = menuSize.h
  const totalW = cardW + MENU_PAD * 2
  const totalH = cardH + MENU_PAD * 2

  if (menuAnchor) {
    const wa = screen.getDisplayNearestPoint({ x: menuAnchor.x, y: menuAnchor.y }).workArea
    const cardX = Math.round(menuAnchor.x + menuAnchor.width - cardW)
    const cardY = Math.round(menuAnchor.y - cardH - 10)
    const cx = clampNum(cardX, wa.x + 4, wa.x + wa.width - cardW - 4)
    const cy = clampNum(cardY, wa.y + 4, wa.y + wa.height - cardH - 4)
    win.setBounds({ x: cx - MENU_PAD, y: cy - MENU_PAD, width: totalW, height: totalH })
    return
  }

  const center = ballCenter()
  if (!center) return
  const s = settingsStore.get()
  const radius = s.ball.size / 2 + 18
  const wa = screen.getDisplayNearestPoint({ x: Math.round(center.x), y: Math.round(center.y) }).workArea
  const spaceRight = wa.x + wa.width - (center.x + radius)
  const side = spaceRight >= cardW + 8 ? 'right' : 'left'
  const cardX = Math.round(side === 'right' ? center.x + radius : center.x - radius - cardW)
  const cardY = Math.round(center.y - cardH / 2)
  const cx = clampNum(cardX, wa.x + 4, wa.x + wa.width - cardW - 4)
  const cy = clampNum(cardY, wa.y + 4, wa.y + wa.height - cardH - 4)
  win.setBounds({ x: cx - MENU_PAD, y: cy - MENU_PAD, width: totalW, height: totalH })
}

export function preloadMenu(): void {
  const win = getMenuWindow() ?? createMenuWindow()
  win.webContents.once('did-finish-load', () => {
    /* 提前加载好，右键时无白屏 */
  })
}

export function showBallMenu(items: BallMenuItem[], anchor?: Electron.Rectangle): void {
  log('menu: show')
  // 气泡和菜单都是置顶窗口，气泡在上面会吃掉菜单的点击，先收起来
  if (bubbleVisible) hideBubble()
  const win = getMenuWindow() ?? createMenuWindow()
  menuVisible = true
  menuAnchor = anchor ?? null
  const push = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(IPC.menuItems, items)
    setTimeout(() => {
      if (menuVisible && !win.isDestroyed()) win.webContents.send(IPC.menuMeasure)
    }, 40)
  }
  // 窗口可能还在加载（首次右键），等页面就绪再发菜单项，否则渲染层收不到
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', push)
  else push()
  win.show()
  forceRelayout(win)
  win.moveTop()
  layoutMenu()
  // Windows 把窗口从屏幕外移回来是异步的，会覆盖我们刚设的位置；稍后再钉一次
  setTimeout(() => {
    if (menuVisible && !win.isDestroyed()) layoutMenu()
  }, 60)
  // 菜单开着时跟着球走（move 事件是主路径，这里只做兜底）
  if (!menuAnchor) {
    if (followTimer) clearInterval(followTimer)
    followTimer = setInterval(() => {
      if (!menuVisible) return
      layoutMenu()
    }, 200)
  }
  win.focus()
}

export function hideBallMenu(): void {
  const win = getMenuWindow()
  if (!menuVisible || !win) return
  menuVisible = false
  menuAnchor = null
  if (followTimer) {
    clearInterval(followTimer)
    followTimer = null
  }
  log('menu: hide')
  // 和气泡一样：别用 hide()，挪到屏幕外更稳
  const b = win.getBounds()
  win.setBounds({ x: OFFSCREEN, y: OFFSCREEN, width: b.width, height: b.height })
}

/* -------------------------------------------------------------- settings -- */

export function openSettingsWindow(tab?: string): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    if (tab) settingsWin.webContents.send(IPC.settingsFocusTab, tab)
    return settingsWin
  }
  settingsWin = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'BeWithU · 设置',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#c7d2e5', height: 44 },
    webPreferences: baseWebPrefs()
  })
  loadRenderer(settingsWin, 'settings')
  // 新建窗口时页面可能已经加载完，once('did-finish-load') 会错过，这里两种都覆盖
  const focusTab = (): void => {
    if (tab && settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send(IPC.settingsFocusTab, tab)
    }
  }
  if (settingsWin.webContents.isLoading()) {
    settingsWin.webContents.once('did-finish-load', focusTab)
  } else {
    focusTab()
  }
  settingsWin.once('ready-to-show', () => {
    settingsWin?.show()
    settingsWin?.focus()
  })
  settingsWin.on('closed', () => {
    settingsWin = null
  })
  return settingsWin
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null
}

/* --------------------------------------------------------------- helpers -- */

export function broadcastSettings(s: PublicSettings): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.settingsChanged, s)
  }
  sendBubbleMeta()
}

export function sendAgentProgress(p: AgentProgress): void {
  getBallWindow()?.webContents.send(IPC.agentProgress, p)
}

export function broadcastPhase(phase: Phase): void {
  getBallWindow()?.webContents.send(IPC.ballPhase, phase)
  sendBubble({ type: 'phase', phase })
}

export function hideAllWindows(): void {
  hideBubble()
  getBallWindow()?.hide()
}

export function hideBallWindow(): void {
  hideBubble()
  getBallWindow()?.hide()
}

export function showBallWindow(): void {
  const win = getBallWindow() ?? createBallWindow()
  win.showInactive()
  // 之前可能被隐藏过，强制重排一次，避免"看得见但点不动"
  forceRelayout(win)
}

export function isBallVisible(): boolean {
  const win = getBallWindow()
  return Boolean(win && win.isVisible())
}

export function allWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
}

export function logWindowState(): void {
  log(
    'windows',
    allWindows().map((w) => w.getTitle())
  )
}
