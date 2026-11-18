import { BrowserWindow, app, dialog, ipcMain, screen, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
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
import { runAgentTask } from './agent/runner'
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
import { captureNextChord, prettyChord, reloadHotkey, hotkeyStatus, setGlobalMouseHandlers } from './input/hotkey'
import {
  broadcastSettings,
  ballCenter,
  bubbleBounds,
  defaultBallPosition,
  focusBubble,
  getBallBounds,
  getBallWindow,
  hideBallMenu,
  hideBallWindow,
  hideBubble,
  isBubblePinned,
  isBubbleVisible,
  openSettingsWindow,
  releaseBubbleFocus,
  setBallPosition,
  setBubbleCardSize,
  setBubblePinned,
  setMenuSize,
  showBallMenu,
  toggleBubble
} from './windows'
import { log, logPath } from './logger'

let dragTimer: NodeJS.Timeout | null = null
let dragOrigin = { x: 0, y: 0 }
let dragStart = { x: 0, y: 0 }
let previewSeq = 500000

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

  ipcMain.handle(IPC.settingsGet, () => settingsStore.public())

  ipcMain.handle(IPC.settingsUpdate, (_e, patch: SettingsPatch) => {
    const before = settingsStore.get()
    const next = settingsStore.update(patch)
    if (before.voice.hotkey !== next.voice.hotkey || before.voice.mode !== next.voice.mode) {
      reloadHotkey(next.voice.hotkey)
    }
    broadcastSettings(next)
    return next
  })

  ipcMain.handle(IPC.settingsReset, () => {
    const next = settingsStore.reset()
    reloadHotkey(next.voice.hotkey)
    broadcastSettings(next)
    return next
  })

  ipcMain.handle(IPC.settingsOpen, (_e, tab?: string) => {
    openSettingsWindow(tab)
  })

  ipcMain.handle(IPC.settingsAppInfo, () => {
    const status = hotkeyStatus()
    return {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      hotkeyActive: status.ok,
      hotkeyMessage: status.message,
      hotkeyPretty: prettyChord(settingsStore.get().voice.hotkey),
      platform: process.platform,
      logPath: logPath()
    }
  })

  ipcMain.handle(IPC.settingsPickImage, async () => {
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

  ipcMain.handle(IPC.settingsClearHistory, () => {
    conversation.clearContext()
  })

  ipcMain.handle(IPC.settingsRevealSecret, (_e, path: SecretPath) => settingsStore.reveal(path))
  ipcMain.handle(IPC.memoryGet, () => conversation.memoryInfo())
  ipcMain.handle(IPC.memorySummarize, () => conversation.summarizeNow())

  ipcMain.on(IPC.visionGrabResult, (_e, result: GrabResult) => resolveGrab(result))

  ipcMain.handle(IPC.asrModelStatus, () => modelStatus())

  ipcMain.handle(IPC.asrModelDownload, async () => {
    const send = (p: unknown): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.asrModelProgress, p)
      }
    }
    await downloadModel(send)
    return modelStatus()
  })

  ipcMain.handle(IPC.asrModelDelete, () => {
    deleteModel()
    return modelStatus()
  })

  ipcMain.handle(IPC.asrLocalWarmup, async () => {
    try {
      const ms = await warmupLocalAsr()
      return { ok: true, message: `模型可用 · ${(ms / 1000).toFixed(1)}s` }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(IPC.visionCapture, async () => {
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

  ipcMain.handle(IPC.settingsOpenDataDir, async () => {
    await shell.openPath(app.getPath('userData'))
  })

  ipcMain.handle(IPC.dataDirGet, () => {
    const dir = currentDataDir()
    return {
      dir,
      defaultDir: defaultDataDir(),
      custom: isCustomDataDir(),
      sizeMB: Math.round(dirSizeMB(dir) * 10) / 10
    }
  })

  ipcMain.handle(IPC.dataDirChange, async (e) => {
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

  ipcMain.handle(IPC.dataDirReset, async () => {
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

  ipcMain.handle(IPC.settingsRestartHotkey, () => {
    reloadHotkey(settingsStore.get().voice.hotkey)
    return hotkeyStatus()
  })

  ipcMain.handle(IPC.settingsTestLlm, async () => {
    const s = settingsStore.get()
    if (!s.llm.apiKey.trim()) return { ok: false, message: '还没填 API Key' }
    return testLlm(s.llm)
  })

  ipcMain.handle(IPC.settingsTestTts, async (_e, text?: string) => {
    const s = settingsStore.get()
    return synthToBall(s.tts, text?.trim() || '你好，我是你的桌面伙伴，语音合成已经连上了')
  })

  ipcMain.handle(
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

  ipcMain.handle(IPC.settingsTestAsr, async () => testAsr(settingsStore.get().asr))

  /* -------------------------------------------------------------- ball ---- */

  ipcMain.on(IPC.ballDragStart, () => startBallDrag())
  ipcMain.on(IPC.ballDragEnd, () => endBallDrag(true))
  ipcMain.on(IPC.ballClick, (_e, moved: boolean) => {
    log('ball: click', moved)
    if (!moved) toggleBubble()
  })
  ipcMain.on(IPC.ballBubbleToggle, () => toggleBubble())

  ipcMain.on(IPC.ballContextMenu, () => {
    const s = settingsStore.get()
    showBallMenu([
      { id: 'settings', label: '设置…' },
      { id: 'skin', label: '换皮肤' },
      { id: 'mute', label: s.ui.muted ? '取消静音' : '静音', checked: s.ui.muted },
      { id: 'sep1', label: '', separator: true },
      { id: 'hide-ball', label: '隐藏悬浮球' },
      { id: 'reset-pos', label: '重置悬浮球位置' },
      { id: 'sep2', label: '', separator: true },
      { id: 'logs', label: '打开日志' },
      { id: 'quit', label: '退出 BeWithU', danger: true }
    ])
  })

  ipcMain.on(IPC.menuPick, (_e, id: string) => {
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
  ipcMain.on(IPC.menuResize, (_e, w: number, h: number) => setMenuSize(Number(w), Number(h)))
  ipcMain.on(IPC.menuClose, () => hideBallMenu())

  ipcMain.on(IPC.ballResetPosition, () => resetBallPosition())

  /* ------------------------------------------------------------ bubble ---- */

  ipcMain.on(IPC.bubbleResize, (_e, w: number, h: number) => setBubbleCardSize(w, h))
  ipcMain.on(IPC.bubbleClose, () => {
    conversation.interrupt()
    conversation.cancelListening()
    hideBubble()
  })
  ipcMain.on(IPC.bubblePin, (_e, pinned: boolean) => setBubblePinned(pinned))
  ipcMain.on(IPC.bubbleSubmit, (_e, text: string) => conversation.respondText(String(text ?? '')))
  ipcMain.on(IPC.bubbleFocus, () => focusBubble())
  ipcMain.on(IPC.bubbleBlur, () => releaseBubbleFocus())
  ipcMain.on(IPC.bubbleStop, () => {
    conversation.interrupt()
    conversation.cancelListening()
    hideBubble()
  })
  ipcMain.on(IPC.contextClear, () => conversation.clearContext())

  /* ------------------------------------------------------------- voice ---- */

  ipcMain.on(IPC.voicePcm, (_e, data: ArrayBuffer) => {
    try {
      conversation.handlePcm(Buffer.from(new Uint8Array(data)))
    } catch (e) {
      log('voice: pcm 处理失败', e)
    }
  })
  ipcMain.on(IPC.voiceError, (_e, message: string) => conversation.onVoiceError(message))
  ipcMain.on(IPC.audioDrained, () => conversation.onAudioDrained())

  /* ------------------------------------------------------------- misc ---- */

  ipcMain.handle(IPC.hotkeyCapture, async () => captureNextChord())
  ipcMain.handle(IPC.settingsHotkeyStatus, () => hotkeyStatus())

  /* ------------------------------------------------------------- agent ---- */

  registerBuiltinTools()
  // 气泡里点「允许/拒绝」
  ipcMain.on(IPC.agentApprove, (_e, id: string, allow: boolean) => {
    resolveApproval(String(id ?? ''), Boolean(allow))
  })
  // 测试通道：只有以 BWU_AGENT_TEST=1 启动时才暴露，正常运行时不存在
  if (process.env['BWU_AGENT_TEST'] === '1') {
    ipcMain.handle(IPC.agentTestList, () =>
      listTools().map((t) => ({ id: t.id, name: t.name, risk: t.risk }))
    )
    ipcMain.handle(IPC.agentTestCall, (_e, id: string, args: Record<string, unknown>) =>
      callTool(String(id ?? ''), (args ?? {}) as Record<string, unknown>)
    )
    ipcMain.handle(IPC.agentTestRun, async (_e, text: string, autoApprove?: boolean) => {
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
