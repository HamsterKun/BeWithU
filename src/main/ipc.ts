import { BrowserWindow, app, dialog, ipcMain, screen, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { SecretPath, Settings, SettingsPatch, TestResult } from '../shared/types'
import { historyStore } from './store/history'
import { settingsStore } from './store/settings'
import { conversation } from './services/pipeline'
import { synthesize } from './services/tts'
import { testLlm } from './services/llm'
import { testAsr } from './services/asr'
import { captureScreen } from './services/vision'
import { callTool, listTools, registerBuiltinTools } from './agent'
import { resolveApproval } from './agent/approval'
import { clearAudit, recentAudit } from './agent/audit'
import { mkdirSync } from 'node:fs'
import { runAgentTask } from './agent/runner'
import {
  deleteCustomTool,
  importCustomTool,
  importCustomToolArchive,
  registerCustomTools,
  scanCustomTools,
  setToolTrusted,
  toolsDir,
  writeToolTemplate
} from './agent/custom-tools'
import { deleteSkill, importSkill, importSkillArchive, scanSkills, writeSkillTemplate } from './agent/skills'
import { disconnectMcp, mcpListTools } from './agent/mcp'
import { ensureMcpTools, unregisterMcpServer } from './agent'
import { mcpConfigKey } from './agent/mcp'
import { webSearch } from './services/web-search'
import { listModels } from './services/llm'
import { clearUsage, usageSummary } from './store/usage'
import { readLogTail } from './services/log-tail'
import { isPortable } from './platform'
import { refreshModelInfo } from './services/model-info'
import { applyAutoLaunch } from './services/auto-launch'
import { check as checkUpdate, currentStatus, download as downloadUpdate, install as installUpdate, openReleasePage } from './services/update'
import { APP_REPO_URL } from '../shared/defaults'
import { deleteModel, downloadModel, modelStatus } from './services/asr-model'
import { warmupLocalAsr } from './services/local-asr'
import {
  currentDataDir,
  defaultDataDir,
  dirSizeMB,
  isCustomDataDir,
  migrateDataDir,
  moveBackToDefault,
  pickDataDir
} from './data-dir'
import { resolveGrab } from './vision-grab'
import type { GrabResult } from '../shared/ipc'
import {
  captureNextChord,
  prettyChord,
  reloadHotkey,
  hotkeyStatus,
  isHotkeyFallback,
  setGlobalMouseHandlers
} from './input/hotkey'
import { secureStorageAvailable } from './store/secure-json'
import {
  broadcastSettings,
  ballCenter,
  bubbleBounds,
  defaultBallPosition,
  focusBubble,
  getBallBounds,
  getBallWindow,
  getBubbleWindow,
  getMenuWindow,
  getSettingsWindow,
  rendererFrameMatches,
  type RendererRole as WindowRole,
  hideBallMenu,
  hideBallWindow,
  hideBubble,
  isBubblePinned,
  isBubbleVisible,
  sendAgentProgress,
  openSettingsWindow,
  releaseBubbleFocus,
  setBallPosition,
  setBubbleCardSize,
  setBubblePinned,
  setMenuSize,
  showBallMenu,
  showBallWindow,
  hideAllWindows,
  toggleBubble
} from './windows'
import { log, logPath } from './logger'

let dragTimer: NodeJS.Timeout | null = null
let dragOrigin = { x: 0, y: 0 }
let dragStart = { x: 0, y: 0 }
let previewSeq = 500000

function windowForRole(role: WindowRole): BrowserWindow | null {
  switch (role) {
    case 'ball': return getBallWindow()
    case 'bubble': return getBubbleWindow()
    case 'menu': return getMenuWindow()
    case 'settings': return getSettingsWindow()
  }
}

function assertSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, roles: WindowRole[]): void {
  const allowed = roles.some((role) => {
    const win = windowForRole(role)
    return win?.webContents === event.sender && rendererFrameMatches(event.senderFrame, win, role)
  })
  if (!allowed) throw new Error('拒绝未授权窗口 IPC')
}

const channelRoles = new Map<string, WindowRole[]>([
  [IPC.settingsGet, ['ball', 'bubble', 'menu', 'settings']],
  [IPC.settingsOpen, ['ball', 'bubble', 'menu', 'settings']],
  [IPC.visionGrabResult, ['ball']], [IPC.ballResetPosition, ['settings']],
  [IPC.voicePcm, ['ball']], [IPC.voiceError, ['ball']], [IPC.audioDrained, ['ball']],
  [IPC.contextClear, ['bubble']], [IPC.agentApprove, ['bubble']]
])

function allowedRoles(channel: string): WindowRole[] {
  const explicit = channelRoles.get(channel)
  if (explicit) return explicit
  if (channel.startsWith('ball:')) return ['ball']
  if (channel.startsWith('bubble:')) return ['bubble']
  if (channel.startsWith('menu:')) return ['menu']
  if (channel.startsWith('agent:test-') && !app.isPackaged) return ['ball', 'bubble', 'menu', 'settings']
  return ['settings']
}

function handle<A extends unknown[], R>(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: A) => R): void {
  ipcMain.handle(channel, (event, ...args: A) => {
    assertSender(event, allowedRoles(channel))
    return fn(event, ...args)
  })
}

function on<A extends unknown[]>(channel: string, fn: (event: Electron.IpcMainEvent, ...args: A) => unknown): void {
  ipcMain.on(channel, (event, ...args: A) => {
    try { assertSender(event, allowedRoles(channel)) } catch { return }
    return fn(event, ...args)
  })
}

function pointIn(rect: Electron.Rectangle, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

function startBallDrag(): void {
  const bounds = getBallBounds()
  if (!bounds) return
  endBallDrag(false)
  const cursor = screen.getCursorScreenPoint()
  dragOrigin = { x: bounds.x, y: bounds.y }
  dragStart = { x: cursor.x, y: cursor.y }
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint()
    setBallPosition(dragOrigin.x + (p.x - dragStart.x), dragOrigin.y + (p.y - dragStart.y))
  }, 8)
}

function endBallDrag(persist = true): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  const b = getBallBounds()
  if (b && persist) settingsStore.update({ ball: { x: b.x, y: b.y } })
}

setGlobalMouseHandlers(
  (button) => {
    if (button !== 1) return
    // 注意：这里绝不能 endBallDrag，否则会和渲染层的 dragStart 抢时序，把刚起步的拖动掐掉
    if (!isBubbleVisible() || isBubblePinned()) return
    const p = screen.getCursorScreenPoint()
    const bb = bubbleBounds()
    const center = ballCenter()
    const size = settingsStore.get().ball.size
    const inBubble = bb ? pointIn(bb, p.x, p.y) : false
    const inBall = center ? Math.hypot(p.x - center.x, p.y - center.y) <= size / 2 + 12 : false
    if (!inBubble && !inBall) hideBubble()
  },
  () => {
    if (dragTimer) endBallDrag(true)
  }
)

function resetBallPosition(): void {
  const { x, y } = defaultBallPosition()
  setBallPosition(x, y)
  const b = getBallBounds()
  if (b) settingsStore.update({ ball: { x: b.x, y: b.y } })
}

/** 当前正在进行的试听：新的试听会打断它（停播 + 取消合成请求） */
let previewAbort: AbortController | null = null

/**
 * 合成一段话并直接从悬浮球播放（设置页测试 / 音色试听共用）。
 * 再次调用会立刻打断上一次试听：停止正在播放的音频、取消还没发完的合成请求，
 * 避免"点了没反应 → 疯狂点 → 一串声音排队响"。
 */
async function synthToBall(tts: Settings['tts'], text: string): Promise<TestResult> {
  // 打断上一次试听
  previewAbort?.abort()
  // 顺手结束正在进行的语音播报，避免两路声音叠在一起
  conversation.interrupt()

  const controller = new AbortController()
  previewAbort = controller
  const t0 = Date.now()
  const seq = previewSeq++
  let bytes = 0
  let firstAt = 0
  const timer = setTimeout(() => controller.abort(), 30000)

  // 立刻停掉渲染端正在播放的音频
  getBallWindow()?.webContents.send(IPC.audioStop)

  try {
    for await (const chunk of synthesize(tts, text, controller.signal)) {
      if (controller.signal.aborted) break
      if (!firstAt) firstAt = Date.now() - t0
      bytes += chunk.pcm.length
      conversation.previewChunk(seq, chunk.pcm, false)
    }
    if (controller.signal.aborted) {
      log('tts: 试听被打断')
      return { ok: false, message: '已打断' }
    }
    conversation.previewChunk(seq, Buffer.alloc(0), true)
    getBallWindow()?.webContents.send(IPC.audioEnd)
    if (!bytes) {
      return { ok: false, message: '没有收到声音，请检查音色与音色版本' }
    }
    log('tts: 试听完成', `首包 ${firstAt}ms / 共 ${Date.now() - t0}ms`)
    return { ok: true, message: '试听成功' }
  } catch (e) {
    return { ok: false, message: controller.signal.aborted ? '已打断' : (e as Error).message }
  } finally {
    clearTimeout(timer)
    if (previewAbort === controller) previewAbort = null
  }
}

export function registerIpc(getQuit: () => void): void {
  /* ---------------------------------------------------------- settings ---- */

  handle(IPC.settingsGet, () => settingsStore.public())

  handle(IPC.settingsUpdate, (_e, patch: SettingsPatch) => {
    const before = settingsStore.get()
    const next = settingsStore.update(patch)
    const configured = settingsStore.get().mcp.servers
    for (const server of before.mcp.servers) {
      const current = configured.find((s) => s.id === server.id && s.enabled)
      if (!current || mcpConfigKey(current) !== mcpConfigKey(server)) unregisterMcpServer(server.id)
    }
    if (before.voice.hotkey !== next.voice.hotkey || before.voice.mode !== next.voice.mode) {
      reloadHotkey(next.voice.hotkey)
    }
    if (before.ui.autoLaunch !== next.ui.autoLaunch) applyAutoLaunch(next.ui.autoLaunch)
    if (
      before.llm.model !== next.llm.model ||
      before.llm.baseUrl !== next.llm.baseUrl ||
      before.llm.apiKey !== next.llm.apiKey
    ) {
      void refreshModelInfo(next.llm, true)
    }
    broadcastSettings(next)
    return next
  })

  handle(IPC.settingsReset, () => {
    const oldServers = settingsStore.get().mcp.servers
    const next = settingsStore.reset()
    for (const server of oldServers) unregisterMcpServer(server.id)
    reloadHotkey(next.voice.hotkey)
    broadcastSettings(next)
    return next
  })

  handle(IPC.settingsOpen, (_e, tab?: string) => {
    openSettingsWindow(tab)
  })

  handle(IPC.settingsAppInfo, () => {
    const status = hotkeyStatus()
    return {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      hotkeyActive: status.ok,
      hotkeyMessage: status.message,
      hotkeyFallback: isHotkeyFallback(),
      hotkeyPretty: prettyChord(settingsStore.get().voice.hotkey),
      secureStorage: secureStorageAvailable(),
      platform: process.platform,
      portable: isPortable(),
      logPath: logPath()
    }
  })

  handle(IPC.settingsPickImage, async () => {
    const res = await dialog.showOpenDialog({
      title: '选择悬浮球皮肤',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    try {
      const file = res.filePaths[0]
      const buf = readFileSync(file)
      if (buf.length > 24 * 1024 * 1024) throw new Error('图片超过 24MB')
      const ext = extname(file).toLowerCase().replace('.', '')
      const mime = ext === 'jpg' ? 'jpeg' : ext
      return `data:image/${mime};base64,${buf.toString('base64')}`
    } catch (e) {
      log('pick image 失败', e)
      return null
    }
  })

  handle(IPC.settingsClearHistory, () => {
    conversation.clearContext()
  })

  handle(IPC.settingsRevealSecret, (_e, path: SecretPath) => settingsStore.reveal(path))
  handle(IPC.contextGet, () => conversation.contextInfo())
  handle(IPC.contextCompact, () => conversation.compactNow())

  on(IPC.visionGrabResult, (_e, result: GrabResult) => resolveGrab(result))

  handle(IPC.asrModelStatus, () => modelStatus())

  handle(IPC.asrModelDownload, async () => {
    const send = (p: unknown): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.asrModelProgress, p)
      }
    }
    await downloadModel(send)
    return modelStatus()
  })

  handle(IPC.asrModelDelete, () => {
    deleteModel()
    return modelStatus()
  })

  handle(IPC.asrLocalWarmup, async () => {
    try {
      const ms = await warmupLocalAsr()
      return { ok: true, message: `模型可用 · ${(ms / 1000).toFixed(1)}s` }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  handle(IPC.visionCapture, async () => {
    const res = await captureScreen()
    if (!res.ok) {
      return {
        ok: false,
        message:
          res.reason === 'blank'
            ? '抓到的是黑屏：游戏可能处于独占全屏，改成「无边框窗口化」再试'
            : `截屏失败：${res.message}`,
        width: 0,
        height: 0,
        bytes: 0,
        displayLabel: '',
        dataUrl: ''
      }
    }
    return {
      ok: true,
      message: '截图成功',
      width: res.shot.width,
      height: res.shot.height,
      bytes: res.shot.bytes,
      displayLabel: res.shot.displayLabel,
      dataUrl: res.shot.dataUrl
    }
  })

  handle(IPC.settingsOpenDataDir, async () => {
    await shell.openPath(app.getPath('userData'))
  })

  handle(IPC.dataDirGet, () => {
    const dir = currentDataDir()
    return {
      dir,
      defaultDir: defaultDataDir(),
      custom: isCustomDataDir(),
      sizeMB: Math.round(dirSizeMB(dir) * 10) / 10
    }
  })

  handle(IPC.dataDirChange, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const target = await pickDataDir(win)
    if (!target) return { ok: false, canceled: true }
    try {
      await migrateDataDir(target)
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 800)
      return {
        ok: true,
        dir: target,
        message: '迁移完成，即将重启'
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(IPC.dataDirReset, async () => {
    try {
      await moveBackToDefault()
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 800)
      return { ok: true, message: '已搬回默认目录，即将重启' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  handle(IPC.settingsRestartHotkey, () => {
    reloadHotkey(settingsStore.get().voice.hotkey)
    return hotkeyStatus()
  })

  handle(IPC.settingsTestLlm, async () => {
    const s = settingsStore.get()
    if (!s.llm.apiKey.trim()) return { ok: false, message: '还没填 API Key' }
    return testLlm(s.llm)
  })

  handle(IPC.settingsTestTts, async (_e, text?: string) => {
    const s = settingsStore.get()
    return synthToBall(s.tts, text?.trim() || '你好，我是你的桌面伙伴，语音合成已经连上了')
  })

  handle(
    IPC.settingsPreviewVoice,
    async (_e, speaker: string, resourceId: string) => {
      const s = settingsStore.get()
      if (!speaker?.trim()) return { ok: false, message: '没有指定音色' }
      return synthToBall(
        { ...s.tts, speaker: speaker.trim(), resourceId: (resourceId || s.tts.resourceId).trim() },
        '你好呀，我是你的桌面伙伴。这个声音你喜欢吗？'
      )
    }
  )

  handle(IPC.settingsTestAsr, async () => testAsr(settingsStore.get().asr))

  /* -------------------------------------------------------------- ball ---- */

  on(IPC.ballDragStart, () => startBallDrag())
  on(IPC.ballDragEnd, () => endBallDrag(true))
  on(IPC.ballClick, (_e, moved: boolean) => {
    log('ball: click', moved)
    if (!moved) toggleBubble()
  })
  on(IPC.ballBubbleToggle, () => toggleBubble())

  on(IPC.ballContextMenu, () => {
    const s = settingsStore.get()
    showBallMenu([
      { id: 'settings', label: '设置…' },
      { id: 'skin', label: '换皮肤' },
      { id: 'size-plus', label: '悬浮球放大' },
      { id: 'size-minus', label: '悬浮球缩小' },
      { id: 'mute', label: s.ui.muted ? '取消静音' : '静音', checked: s.ui.muted },
      { id: 'sep1', label: '', separator: true },
      { id: 'hide-ball', label: '隐藏悬浮球' },
      { id: 'reset-pos', label: '重置悬浮球位置' },
      { id: 'sep2', label: '', separator: true },
      { id: 'logs', label: '打开日志' },
      { id: 'quit', label: '退出 BeWithU', danger: true }
    ])
  })

  on(IPC.menuPick, (_e, id: string) => {
    log('menu: pick', id)
    hideBallMenu()
    const s = settingsStore.get()
    switch (id) {
      case 'settings':
        openSettingsWindow('model')
        break
      case 'skin':
        openSettingsWindow('ball')
        break
      case 'mute':
        broadcastSettings(settingsStore.update({ ui: { muted: !s.ui.muted } }))
        break
      case 'size-plus':
      case 'size-minus': {
        const step = id === 'size-plus' ? 8 : -8
        const next = Math.max(64, Math.min(152, s.ball.size + step))
        if (next !== s.ball.size) {
          broadcastSettings(settingsStore.update({ ball: { size: next } }))
        }
        break
      }
      case 'show-ball':
        showBallWindow()
        break
      case 'hide-all':
        hideAllWindows()
        break
      case 'clear-context':
        conversation.clearContext()
        break
      case 'hide-ball':
        hideBallWindow()
        break
      case 'reset-pos':
        resetBallPosition()
        break
      case 'logs':
        void shell.showItemInFolder(logPath())
        break
      case 'quit':
        getQuit()
        break
      default:
        break
    }
  })
  on(IPC.menuResize, (_e, w: number, h: number) => setMenuSize(Number(w), Number(h)))
  on(IPC.menuClose, () => hideBallMenu())

  on(IPC.ballResetPosition, () => resetBallPosition())

  /* ------------------------------------------------------------ bubble ---- */

  on(IPC.bubbleResize, (_e, w: number, h: number) => setBubbleCardSize(w, h))
  on(IPC.bubbleClose, () => {
    conversation.interrupt()
    conversation.cancelListening()
    hideBubble()
  })
  on(IPC.bubblePin, (_e, pinned: boolean) => setBubblePinned(pinned))
  on(IPC.bubbleSubmit, (_e, text: string) => conversation.respondText(String(text ?? '')))
  on(IPC.bubbleFocus, () => focusBubble())
  on(IPC.bubbleBlur, () => releaseBubbleFocus())
  on(IPC.bubbleStop, () => {
    conversation.interrupt()
    conversation.cancelListening()
    hideBubble()
  })
  on(IPC.contextClear, () => conversation.clearContext())

  /* ------------------------------------------------------------- voice ---- */

  on(IPC.voicePcm, (_e, data: ArrayBuffer) => {
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 16384 || data.byteLength % 2 !== 0) return
    try {
      conversation.handlePcm(Buffer.from(new Uint8Array(data)))
    } catch (e) {
      log('voice: pcm 处理失败', e)
    }
  })
  on(IPC.voiceError, (_e, message: string) => conversation.onVoiceError(message))
  on(IPC.audioDrained, () => conversation.onAudioDrained())

  /* ------------------------------------------------------------- misc ---- */

  handle(IPC.hotkeyCapture, async () => captureNextChord())
  handle(IPC.settingsHotkeyStatus, () => hotkeyStatus())

  /* ------------------------------------------------------------- agent ---- */

  registerBuiltinTools()
  // Agent 设置页
  handle(IPC.appPickDir, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择允许操作的目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : r.filePaths[0] ?? null
  })
  handle(IPC.agentToolsList, () => {
    const disabled = settingsStore.get().agent.disabledTools
    return listTools().map((t) => ({
      id: t.id,
      name: t.name,
      risk: t.risk,
      enabled: !disabled.includes(t.id)
    }))
  })
  handle(IPC.agentRuns, () => recentAudit(50))
  handle(IPC.agentRunsClear, () => {
    clearAudit()
    return true
  })
  handle(IPC.agentOpenToolsDir, async () => {
    writeToolTemplate()
    await shell.openPath(toolsDir())
  })

  /* ------------------------------------------------- 自定义工具 / Skill ---- */

  handle(IPC.agentCustomList, () => scanCustomTools())
  handle(IPC.agentCustomImport, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择工具目录（里面要有 manifest.json）',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const tool = importCustomTool(r.filePaths[0])
      registerCustomTools()
      return { ok: true, tool }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle(IPC.agentCustomTrust, (_e, id: string, trusted: boolean) => {
    setToolTrusted(String(id ?? ''), Boolean(trusted))
    registerCustomTools()
    return scanCustomTools()
  })
  handle(IPC.agentCustomDelete, (_e, id: string) => {
    deleteCustomTool(String(id ?? ''))
    registerCustomTools()
    return scanCustomTools()
  })

  handle(IPC.agentSkillsList, () => scanSkills())
  handle(IPC.agentSkillImport, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择技能目录（里面要有 SKILL.md）',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      return { ok: true, skill: importSkill(r.filePaths[0]) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle(IPC.agentSkillDelete, (_e, id: string) => {
    deleteSkill(String(id ?? ''))
    return scanSkills()
  })
  handle(IPC.agentSkillOpenDir, async () => {
    await shell.openPath(writeSkillTemplate())
  })

  /* ------------------------------------------------------ zip / MCP ------- */

  handle(IPC.agentCustomImportZip, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择工具压缩包（zip）',
      properties: ['openFile'],
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const tool = await importCustomToolArchive(r.filePaths[0])
      registerCustomTools()
      return { ok: true, tool }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle(IPC.agentSkillImportZip, async () => {
    const r = await dialog.showOpenDialog({
      title: '选择技能压缩包（zip）',
      properties: ['openFile'],
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      return { ok: true, skill: await importSkillArchive(r.filePaths[0]) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /* ------------------------------------------------------- 模型列表 / 用量 -- */

  handle(IPC.llmModels, async () => {
    try {
      const models = await listModels(settingsStore.get().llm)
      return { ok: true, models }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle(IPC.usageStats, () => usageSummary())
  handle(IPC.updateGet, () => currentStatus())
  handle(IPC.updateCheck, () => checkUpdate())
  handle(IPC.updateDownload, () => downloadUpdate())
  handle(IPC.updateInstall, () => installUpdate())
  handle(IPC.updateOpenPage, () => openReleasePage())

  handle(IPC.logsTail, (_e, opts?: { lines?: number; keyword?: string; onlyProblems?: boolean }) =>
    readLogTail(logPath(), opts ?? {})
  )
  handle(IPC.logsOpenDir, () => {
    void shell.showItemInFolder(logPath())
  })
  // 固定地址、渲染进程传不了 URL，避免这条通道变成任意协议的外链入口
  handle(IPC.appOpenRepo, async () => {
    const url = new URL(APP_REPO_URL)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('非法的项目地址')
    await shell.openExternal(APP_REPO_URL)
  })

  handle(IPC.usageClear, () => {
    clearUsage()
    return usageSummary()
  })

  handle(IPC.mcpList, () => settingsStore.publicMcpServers())
  handle(IPC.mcpAdd, (_e, cfg: Record<string, unknown>) => {
    const cur = settingsStore.mcpServers()
    const id = `mcp-${Date.now().toString(36)}`
    const next = [
      ...cur,
      {
        id,
        name: String(cfg.name ?? '').trim() || 'MCP',
        enabled: true,
        transport: cfg.transport === 'http' ? ('http' as const) : ('stdio' as const),
        command: String(cfg.command ?? '').trim(),
        args: String(cfg.args ?? '').trim(),
        url: String(cfg.url ?? '').trim(),
        headers: String(cfg.headers ?? '').trim()
      }
    ]
    settingsStore.update({ mcp: { servers: next } })
    return settingsStore.publicMcpServers()
  })
  handle(IPC.mcpRemove, (_e, id: string) => {
    if (typeof id !== 'string') throw new Error('无效的 MCP 服务 ID')
    const next = settingsStore.mcpServers().filter((s) => s.id !== id)
    settingsStore.update({ mcp: { servers: next } })
    unregisterMcpServer(id)
    return settingsStore.publicMcpServers()
  })
  handle(IPC.mcpTest, async (_e, id: string) => {
    const server = settingsStore.mcpServers().find((s) => s.id === id)
    if (!server) return { ok: false, message: '服务器不存在' }
    try {
      disconnectMcp(server.id)
      const tools = await mcpListTools(server)
      return { ok: true, message: `已连接 · ${tools.length} 个工具`, tools: tools.map((t) => t.name) }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  /* ---------------------------------------------------------------- 搜索 ---- */

  handle(IPC.searchTest, async (_e, query: string) => {
    const q = String(query ?? '').trim() || 'DeepSeek'
    try {
      const { provider, hits } = await webSearch(q)
      if (!hits.length) return { ok: false, message: `（${provider}）没有搜到结果` }
      const head = hits
        .slice(0, 3)
        .map((h, i) => `${i + 1}. ${h.title}`)
        .join('\n')
      return { ok: true, message: `${provider} · ${hits.length} 条\n${head}` }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  // 气泡里点「允许/拒绝」
  on(IPC.agentApprove, (_e, id: string, allow: boolean) => {
    if (typeof id !== 'string' || id.length > 100 || typeof allow !== 'boolean') return
    resolveApproval(id, allow)
  })
  // 测试通道：只有以 BWU_AGENT_TEST=1 启动时才暴露，正常运行时不存在
  if (!app.isPackaged && process.env['BWU_AGENT_TEST'] === '1') {
    handle(IPC.agentTestImportTool, (_e, dir: string) => {
      const tool = importCustomTool(String(dir ?? ''))
      registerCustomTools()
      return tool
    })
    handle(IPC.agentTestTrustTool, (_e, id: string, trusted: boolean) => {
      setToolTrusted(String(id ?? ''), Boolean(trusted))
      registerCustomTools()
      return scanCustomTools()
    })
    handle(IPC.agentTestImportSkill, (_e, dir: string) => importSkill(String(dir ?? '')))
    handle(IPC.agentTestImportToolZip, (_e, path: string) => importCustomToolArchive(String(path ?? '')))
    handle(IPC.agentTestImportSkillZip, async (_e, path: string) =>
      importSkillArchive(String(path ?? ''))
    )
    handle(IPC.agentTestMcp, async () => {
      await ensureMcpTools()
      return listTools().filter((t) => t.id.startsWith('mcp.')).map((t) => t.id)
    })
    handle(IPC.agentTestList, () =>
      listTools().map((t) => ({ id: t.id, name: t.name, risk: t.risk }))
    )
    handle(IPC.agentTestCall, (_e, id: string, args: Record<string, unknown>) =>
      callTool(String(id ?? ''), (args ?? {}) as Record<string, unknown>)
    )
    handle(IPC.agentTestBubble, () => isBubbleVisible())
    handle(IPC.agentTestBallTop, (_e, action: string) => {
      const win = getBallWindow()
      if (!win) return false
      if (action === 'drop') {
        win.setAlwaysOnTop(false)
        return win.isAlwaysOnTop()
      }
      return win.isAlwaysOnTop()
    })
    // 让球窗走一遍真实的录音启动/停止（Recorder 的取消与清理只有渲染端能验）
    handle(IPC.agentTestRec, (_e, action: string) => {
      const win = getBallWindow()
      if (!win) return false
      win.webContents.send(action === 'stop' ? IPC.voiceRecStop : IPC.voiceRecStart)
      return true
    })
    // 模拟一次全局热键事件（验证降级时按切换模式工作）
    handle(IPC.agentTestHotkey, (_e, phase: string) => {
      conversation.onHotkey(phase === 'up' ? 'up' : 'down')
      return true
    })
    handle(IPC.agentTestProgress, (_e, p: Record<string, unknown>) => {
      sendAgentProgress({
        active: Boolean(p.active),
        mode: p.mode === 'working' ? 'working' : 'thinking',
        step: Number(p.step ?? 0),
        total: Number(p.total ?? 30)
      })
      return true
    })
    handle(IPC.agentTestRun, async (_e, text: string, autoApprove?: boolean) => {
      const controller = new AbortController()
      const tools: Array<{ toolId: string; ok: boolean; summary: string }> = []
      const res = await runAgentTask(String(text ?? ''), {
        signal: controller.signal,
        events: {
          onText: () => undefined,
          onStep: () => undefined,
          onStepDone: (info) =>
            tools.push({ toolId: info.toolId, ok: info.ok, summary: info.summary.slice(0, 300) }),
          onApproval: () =>
            Promise.resolve(autoApprove ?? process.env['BWU_AGENT_AUTO_APPROVE'] === '1')
        }
      })
      return { ...res, tools }
    })
    log('agent: 测试通道已开启')
  }
}
