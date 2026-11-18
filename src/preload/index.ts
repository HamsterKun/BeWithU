import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AgentProgress, type BubbleUpdate } from '../shared/ipc'
import type {
  AudioChunk,
  BallMenuItem,
  Phase,
  PublicSettings,
  SettingsPatch,
  TestResult
} from '../shared/types'

function on<T = unknown>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

contextBridge.exposeInMainWorld('bwu', {
  settings: {
    get: () => invoke<PublicSettings>(IPC.settingsGet),
    update: (patch: SettingsPatch) => invoke<PublicSettings>(IPC.settingsUpdate, patch),
    reset: () => invoke<PublicSettings>(IPC.settingsReset),
    onChanged: (cb: (s: PublicSettings) => void) => on<PublicSettings>(IPC.settingsChanged, cb),
    testLlm: () => invoke<TestResult>(IPC.settingsTestLlm),
    testTts: (text?: string) => invoke<TestResult>(IPC.settingsTestTts, text),
    previewVoice: (speaker: string, resourceId: string) =>
      invoke<TestResult>(IPC.settingsPreviewVoice, speaker, resourceId),
    testAsr: () => invoke<TestResult>(IPC.settingsTestAsr),
    pickImage: () => invoke<string | null>(IPC.settingsPickImage),
    clearHistory: () => invoke<void>(IPC.settingsClearHistory),
    appInfo: () => invoke(IPC.settingsAppInfo),
    revealSecret: (path: string) => invoke<string>(IPC.settingsRevealSecret, path),
    memoryInfo: () => invoke(IPC.memoryGet),
    summarizeNow: () => invoke<TestResult>(IPC.memorySummarize),
    captureTest: () => invoke(IPC.visionCapture),
    asrModelStatus: () => invoke(IPC.asrModelStatus),
    asrModelDownload: () => invoke(IPC.asrModelDownload),
    asrModelDelete: () => invoke(IPC.asrModelDelete),
    onAsrModelProgress: (cb: (p: unknown) => void) => on(IPC.asrModelProgress, cb),
    asrLocalWarmup: () => invoke<TestResult>(IPC.asrLocalWarmup),
    restartHotkey: () => invoke<void>(IPC.settingsRestartHotkey),
    openDataDir: () => invoke<void>(IPC.settingsOpenDataDir),
    dataDirInfo: () => invoke(IPC.dataDirGet),
    changeDataDir: () => invoke(IPC.dataDirChange),
    resetDataDir: () => invoke(IPC.dataDirReset),
    open: (tab?: string) => invoke<void>(IPC.settingsOpen, tab),
    captureHotkey: () => invoke<string>(IPC.hotkeyCapture),
    onFocusTab: (cb: (tab: string) => void) => on<string>(IPC.settingsFocusTab, cb),
    onHotkeyCaptured: (cb: (chord: string) => void) => on<string>('hotkey:captured', cb)
  },
  ball: {
    dragStart: () => ipcRenderer.send(IPC.ballDragStart),
    dragEnd: () => ipcRenderer.send(IPC.ballDragEnd),
    click: (moved: boolean) => ipcRenderer.send(IPC.ballClick, moved),
    contextMenu: () => ipcRenderer.send(IPC.ballContextMenu),
    toggleBubble: () => ipcRenderer.send(IPC.ballBubbleToggle),
    resetPosition: () => ipcRenderer.send(IPC.ballResetPosition),
    reportError: (message: string) => ipcRenderer.send(IPC.voiceError, message),
    onPhase: (cb: (p: Phase) => void) => on<Phase>(IPC.ballPhase, cb),
    onAgent: (cb: (p: AgentProgress) => void) => on<AgentProgress>(IPC.agentProgress, cb),
    onSettings: (cb: (s: PublicSettings) => void) => on<PublicSettings>(IPC.settingsChanged, cb),
    onRecStart: (cb: () => void) => on(IPC.voiceRecStart, cb),
    onRecStop: (cb: () => void) => on(IPC.voiceRecStop, cb),
    onAudio: (cb: (c: AudioChunk) => void) => on<AudioChunk>(IPC.audioChunk, cb),
    onAudioEnd: (cb: () => void) => on(IPC.audioEnd, cb),
    onAudioStop: (cb: () => void) => on(IPC.audioStop, cb),
    sendPcm: (buf: ArrayBuffer) => ipcRenderer.send(IPC.voicePcm, buf),
    audioDrained: () => ipcRenderer.send(IPC.audioDrained),
    onGrab: (cb: () => void) => on(IPC.visionGrab, cb),
    grabResult: (result: unknown) => ipcRenderer.send(IPC.visionGrabResult, result)
  },
  menu: {
    onItems: (cb: (items: BallMenuItem[]) => void) => on<BallMenuItem[]>(IPC.menuItems, cb),
    onMeasure: (cb: () => void) => on(IPC.menuMeasure, cb),
    resize: (w: number, h: number) => ipcRenderer.send(IPC.menuResize, w, h),
    pick: (id: string) => ipcRenderer.send(IPC.menuPick, id),
    close: () => ipcRenderer.send(IPC.menuClose)
  },
  /** Agent 设置页数据 */
  agentTools: {
    list: () => ipcRenderer.invoke(IPC.agentToolsList),
    runs: () => ipcRenderer.invoke(IPC.agentRuns),
    clearRuns: () => ipcRenderer.invoke(IPC.agentRunsClear),
    openDir: () => ipcRenderer.invoke(IPC.agentOpenToolsDir)
  },
  /** Agent 审批 */
  agent: {
    approve: (id: string, allow: boolean) => ipcRenderer.send(IPC.agentApprove, id, allow)
  },
  /** 仅测试用：BWU_AGENT_TEST=1 启动时才由主进程注册 handler */
  agentTest: {
    list: () => ipcRenderer.invoke(IPC.agentTestList),
    call: (id: string, args: Record<string, unknown>) => ipcRenderer.invoke(IPC.agentTestCall, id, args),
    run: (text: string, autoApprove?: boolean) => ipcRenderer.invoke(IPC.agentTestRun, text, autoApprove)
  },
  bubble: {
    onUpdate: (cb: (u: BubbleUpdate) => void) => on<BubbleUpdate>(IPC.bubbleUpdate, cb),
    resize: (w: number, h: number) => ipcRenderer.send(IPC.bubbleResize, w, h),
    onMeasure: (cb: () => void) => on(IPC.bubbleMeasure, cb),
    close: () => ipcRenderer.send(IPC.bubbleClose),
    pin: (pinned: boolean) => ipcRenderer.send(IPC.bubblePin, pinned),
    stop: () => ipcRenderer.send(IPC.bubbleStop),
    clearContext: () => ipcRenderer.send(IPC.contextClear),
    submit: (text: string) => ipcRenderer.send(IPC.bubbleSubmit, text),
    requestFocus: () => ipcRenderer.send(IPC.bubbleFocus),
    releaseFocus: () => ipcRenderer.send(IPC.bubbleBlur)
  },
  voice: {
    onTranscript: (cb: (t: { text: string; final: boolean }) => void) => on(IPC.voiceTranscript, cb)
  }
})
