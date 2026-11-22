import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BallMenuItem, Phase, PublicSettings } from '../shared/types'
import { IPC, type AgentProgress } from '../shared/ipc'
import { settingsStore } from './store/settings'
import { prettyChord } from './input/hotkey'
import { windowsCursorVisible } from './input/windows-input'
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

const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

export type RendererRole = 'ball' | 'bubble' | 'settings' | 'menu'

export function rendererFrameMatches(frame: Electron.WebFrameMain | null, win: BrowserWindow | null, page: RendererRole): boolean {
  if (!frame || !win || win.isDestroyed() || frame !== win.webContents.mainFrame) return false
  try {
    const expected = devUrl
      ? new URL(`${devUrl}/${page}/index.html`)
      : pathToFileURL(join(__dirname, `../renderer/${page}/index.html`))
    const actual = new URL(frame.url)
    if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.search !== expected.search) return false
    if (actual.protocol === 'file:' && process.platform === 'win32') {
      return actual.pathname.toLowerCase() === expected.pathname.toLowerCase()
    }
    return actual.pathname === expected.pathname
  } catch {
    return false
  }
}

function loadRenderer(win: BrowserWindow, page: RendererRole): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  if (devUrl) void win.loadURL(`${devUrl}/${page}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

function baseWebPrefs(role: RendererRole): Electron.WebPreferences {
  const test = !app.isPackaged && process.env.BWU_AGENT_TEST === '1'
  return {
    preload: preloadPath(),
    additionalArguments: [`--bwu-role=${role}`, ...(test ? ['--bwu-test-bridge'] : [])],
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
  const wa = screen.getDisplayNearestPoint({
    x: Math.round(x + BALL_WIN_SIZE / 2),
    y: Math.round(y + BALL_WIN_SIZE / 2)
  }).workArea
  return {
    x: Math.min(Math.max(x, wa.x - BALL_WIN_SIZE / 2), wa.x + wa.width - BALL_WIN_SIZE / 2),
    y: Math.min(Math.max(y, wa.y - BALL_WIN_SIZE / 2), wa.y + wa.height - BALL_WIN_SIZE / 2)
  }
}

export function createBallWindow(): BrowserWindow {
  if (ballWin && !ballWin.isDestroyed()) return ballWin
  const s = settingsStore.get()
  const saved = s.ball.positioned ? s.ball : defaultBallPosition()
  const pos = clampToDisplays(saved.x, saved.y)

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
    webPreferences: baseWebPrefs('ball')
  })

  ballWin.setAlwaysOnTop(true, 'screen-saver')
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 置顶被系统/别的窗口改掉时立刻拉回，并常驻一个低速看门狗兜底
  ballWin.on('always-on-top-changed', (_e, isTop) => {
    if (!isTop) setTimeout(ensureBallTop, 50)
  })
  ballWin.on('show', () => ensureBallTop())
  // 默认整块穿透；主进程轮询光标（updateHitTests），光标进到球体圆内才恢复可点击
  ballWin.setIgnoreMouseEvents(true)
  ballClickThrough = true
  loadRenderer(ballWin, 'ball')

  ballWin.once('ready-to-show', () => {
    ballWin?.showInactive()
    if (ballWin) forceRelayout(ballWin)
    if (!settingsStore.get().ball.positioned) {
      const b = ballWin!.getBounds()
      settingsStore.update({ ball: { x: b.x, y: b.y, positioned: true } })
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
    webPreferences: baseWebPrefs('bubble')
  })
  bubbleWin.setAlwaysOnTop(true, 'screen-saver')
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  bubbleWin.setSkipTaskbar(true)
  bubbleWin.setIgnoreMouseEvents(windowsCursorVisible() === false)
  loadRenderer(bubbleWin, 'bubble')
  bubbleWin.on('blur', () => getBubbleWindow()?.setFocusable(false))
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
  const win = getBubbleWindow()
  if (!win || win.isDestroyed()) return false
  const b = win.getBounds()
  // 窗口被挪到屏幕外（OFFSCREEN）就是这个值，光看标志位会误判
  return bubbleVisible && Math.abs(b.x) < 30000 && Math.abs(b.y) < 30000
}

export function layoutBubble(): void {
  // 隐藏期间渲染进程仍会上报尺寸（步骤/思考在变），这里绝不能再布局，
  // 否则会把已经挪到屏幕外的窗口又挪回可见位置——表现就是"说收起了其实没收"
  if (!bubbleVisible) return
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
  // 方向按"球在屏幕的左半区还是右半区"决定：左半区往右弹，右半区往左弹；
  // 只有那一侧实在放不下时才反向。
  const midX = wa.x + wa.width / 2
  const preferRight = center.x < midX
  const fitsRight = spaceRight >= winW + 12
  const fitsLeft = spaceLeft >= winW + 12
  bubbleSide = preferRight
    ? fitsRight || !fitsLeft
      ? 'right'
      : 'left'
    : fitsLeft || !fitsRight
      ? 'left'
      : 'right'

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
  // 隐藏时只更新尺寸，等 showBubble() 再统一布局
  if (bubbleVisible) layoutBubble()
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
  // 两个置顶窗口只留一个：要弹气泡就先把菜单收起来（点哪个开哪个）
  if (menuVisible) hideBallMenu()
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
    releaseBubbleFocus()
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

export function isOverBall(point: Electron.Point): boolean {
  if (!isBallVisible()) return false
  const center = ballCenter()
  if (!center) return false
  const size = settingsStore.get().ball.size
  return Math.hypot(point.x - center.x, point.y - center.y) <= size / 2 + 8
}

export function isOverBubble(point: Electron.Point): boolean {
  const card = bubbleCardRect()
  return Boolean(card && point.x >= card.x && point.x < card.x + card.width &&
    point.y >= card.y && point.y < card.y + card.height)
}

/** 全屏游戏能隐藏系统光标，坐标仍可能停在悬浮球或聊天卡片上。 */
export function updateOverlayPointerVisibility(visible: boolean | null): void {
  const bubble = getBubbleWindow()
  const hidden = visible === false
  if (hidden) hideBallMenu()
  bubble?.setIgnoreMouseEvents(hidden)
  if (!hidden && bubble && isBubbleVisible()) forceRelayout(bubble)
  updateHitTests()
}

export function updateHitTests(): void {
  if (windowsCursorVisible() === false) {
    setBallIgnore(true)
    return
  }
  const cursor = screen.getCursorScreenPoint()
  setBallIgnore(!isOverBall(cursor) || isOverBubble(cursor))
}

/** 打字时临时允许窗口获得键盘焦点（平时不抢焦点） */
export function focusBubble(): void {
  const win = getBubbleWindow()
  if (!win || !bubbleVisible || windowsCursorVisible() === false) return
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
/** 卡片四周留白：不要投影时必须是 0，否则透明窗口会露出黑色边框 */
const MENU_PAD = 0
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
    webPreferences: baseWebPrefs('menu')
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
  // 同样按半屏取舍：左半区往右弹，右半区往左弹，放不下才反向
  const preferRight = center.x < wa.x + wa.width / 2
  const fitsRight = spaceRight >= cardW + 8
  const fitsLeft = center.x - radius - wa.x >= cardW + 8
  const side = preferRight
    ? fitsRight || !fitsLeft
      ? 'right'
      : 'left'
    : fitsLeft || !fitsRight
      ? 'left'
      : 'right'
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

export function showBallMenu(items: BallMenuItem[], anchor?: Electron.Rectangle, keepBubbleVisible = false): void {
  log('menu: show')
  // 气泡和菜单都是置顶窗口，气泡在上面会吃掉菜单的点击，先收起来
  if (bubbleVisible && !keepBubbleVisible) hideBubble()
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

const TITLEBAR_COLORS = {
  dark: { color: '#0b0d12', symbolColor: '#c7d2e5' },
  light: { color: '#eef1f7', symbolColor: '#16202e' }
} as const

/** 窗口标题栏/底色跟随主题：亮色下右上角不再是一块黑 */
export function applyWindowTheme(theme: 'dark' | 'light'): void {
  const c = TITLEBAR_COLORS[theme] ?? TITLEBAR_COLORS.dark
  const bg = theme === 'light' ? '#eef1f7' : '#0b0d12'
  // 只处理不透明的设置窗；气泡/菜单是透明窗口，调 setBackgroundColor 反而会画出一层黑底
  const win = settingsWin
  if (!win || win.isDestroyed()) return
  try {
    win.setBackgroundColor(bg)
  } catch {
    /* ignore */
  }
  try {
    ;(win as unknown as { setTitleBarOverlay: (o: unknown) => void }).setTitleBarOverlay({
      ...c,
      height: 44
    })
  } catch {
    /* 非 hidden 标题栏的窗口不支持，忽略 */
  }
}

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
    backgroundColor: settingsStore.get().ui.theme === 'light' ? '#eef1f7' : '#0b0d12',
    title: 'BeWithU · 设置',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...TITLEBAR_COLORS[settingsStore.get().ui.theme === 'light' ? 'light' : 'dark'],
      height: 44
    },
    webPreferences: baseWebPrefs('settings')
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
  applyWindowTheme(s.ui.theme)
  sendBubbleMeta()
}

export function sendAgentProgress(p: AgentProgress): void {
  log('agent: progress', p.active ? `${p.mode ?? 'thinking'} ${p.step}` : 'idle')
  getBallWindow()?.webContents.send(IPC.agentProgress, p)
}

/* ---------------------------------------------------- 置顶看门狗 ---- */

let topWatchdog: NodeJS.Timeout | null = null

/**
 * 球窗口偶尔会莫名其妙丢掉"置顶"（Windows 上被别的 topmost 窗口挤掉、
 * 或某些全屏程序退出后 z-order 没恢复）。这里定期重新声明一次置顶，
 * 只设标志、不 moveTop，避免把气泡/菜单压下去。
 */
export function ensureBallTop(): void {
  const win = getBallWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.setAlwaysOnTop(true, 'screen-saver')
  } catch (e) {
    log('windows: 重置置顶失败', e)
  }
}

export function startBallTopWatchdog(): void {
  if (topWatchdog) return
  topWatchdog = setInterval(ensureBallTop, 1500)
  topWatchdog.unref?.()
}

export function stopBallTopWatchdog(): void {
  if (topWatchdog) clearInterval(topWatchdog)
  topWatchdog = null
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
