import type {
  AppInfo,
  AsrModelProgress,
  AudioChunk,
  BallMenuItem,
  BubbleNotice,
  DataDirInfo,
  MemoryInfo,
  Phase,
  PublicSettings,
  ScreenCaptureInfo,
  SecretPath,
  SettingsPatch,
  TestResult
} from './types'

export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',
  settingsChanged: 'settings:changed',
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  settingsTestLlm: 'settings:test-llm',
  settingsTestTts: 'settings:test-tts',
  settingsPreviewVoice: 'settings:preview-voice',
  settingsTestAsr: 'settings:test-asr',
  settingsPickImage: 'settings:pick-image',
  settingsClearHistory: 'settings:clear-history',
  settingsAppInfo: 'settings:app-info',
  settingsRevealSecret: 'settings:reveal-secret',
  memoryGet: 'memory:get',
  memorySummarize: 'memory:summarize',
  visionCapture: 'vision:capture',
  asrModelStatus: 'asr:model-status',
  asrModelDownload: 'asr:model-download',
  asrModelDelete: 'asr:model-delete',
  asrModelProgress: 'asr:model-progress',
  asrLocalWarmup: 'asr:local-warmup',
  visionGrab: 'vision:grab',
  visionGrabResult: 'vision:grab-result',
  settingsRestartHotkey: 'settings:restart-hotkey',
  settingsOpenDataDir: 'settings:open-data-dir',
  settingsFocusTab: 'settings:focus-tab',
  settingsHotkeyStatus: 'settings:hotkey-status',
  hotkeyCapture: 'hotkey:capture',
  dataDirGet: 'data:dir-get',
  dataDirChange: 'data:dir-change',
  dataDirReset: 'data:dir-reset',

  // ball
  ballDragStart: 'ball:drag-start',
  ballDragEnd: 'ball:drag-end',
  ballClick: 'ball:click',
  ballContextMenu: 'ball:context-menu',
  ballBubbleToggle: 'ball:bubble-toggle',
  ballPhase: 'ball:phase',
  ballResetPosition: 'ball:reset-position',

  // bubble
  bubbleUpdate: 'bubble:update',
  bubbleResize: 'bubble:resize',
  bubbleMeasure: 'bubble:measure',
  bubbleClose: 'bubble:close',
  bubblePin: 'bubble:pin',
  bubbleStop: 'bubble:stop',
  contextClear: 'context:clear',
  /** 气泡里打字发送 */
  bubbleSubmit: 'bubble:submit',
  /** 打字时申请/释放键盘焦点 */
  bubbleFocus: 'bubble:focus',
  bubbleBlur: 'bubble:blur',

  // ball menu (自绘右键菜单)
  menuItems: 'menu:items',
  menuMeasure: 'menu:measure',
  menuResize: 'menu:resize',
  menuPick: 'menu:pick',
  menuClose: 'menu:close',

  // voice / conversation
  voiceRecStart: 'voice:rec-start',
  voiceRecStop: 'voice:rec-stop',
  voiceRecCancel: 'voice:rec-cancel',
  voicePcm: 'voice:pcm',
  voiceError: 'voice:error',
  voiceTranscript: 'voice:transcript',
  voiceState: 'voice:state',

  // audio playback (hosted by ball renderer)
  audioChunk: 'audio:chunk',
  audioEnd: 'audio:end',
  audioStop: 'audio:stop',
  audioDrained: 'audio:drained',

  // misc
  hotkeyCaptured: 'hotkey:captured',
  hotkeyStatus: 'hotkey:status',
  appQuit: 'app:quit',
  appHide: 'app:hide',

  // agent（测试通道：仅 BWU_AGENT_TEST=1 时主进程才注册 handler）
  agentTestList: 'agent:test-list',
  agentTestCall: 'agent:test-call'
} as const

export type BubbleUpdate =
  | { type: 'phase'; phase: Phase; note?: string }
  | { type: 'user'; text: string; final: boolean }
  | { type: 'assistant-reset' }
  | { type: 'assistant-delta'; text: string }
  | { type: 'assistant-end' }
  | { type: 'notice'; notice: BubbleNotice }
  | { type: 'pin'; pinned: boolean }
  | { type: 'anchor'; side: 'left' | 'right' }
  | { type: 'meta'; assistantName: string; silent: boolean; hotkey?: string }

export interface GrabResult {
  ok: boolean
  dataUrl?: string
  width?: number
  height?: number
  error?: string
}

export interface BwuApi {
  settings: {
    get(): Promise<PublicSettings>
    update(patch: SettingsPatch): Promise<PublicSettings>
    reset(): Promise<PublicSettings>
    onChanged(cb: (s: PublicSettings) => void): () => void
    testLlm(): Promise<TestResult>
    testTts(text?: string): Promise<TestResult>
    previewVoice(speaker: string, resourceId: string): Promise<TestResult>
    testAsr(): Promise<TestResult>
    pickImage(): Promise<string | null>
    clearHistory(): Promise<void>
    appInfo(): Promise<AppInfo>
    revealSecret(path: SecretPath): Promise<string>
    memoryInfo(): Promise<MemoryInfo>
    summarizeNow(): Promise<TestResult>
    captureTest(): Promise<ScreenCaptureInfo>
    asrModelStatus(): Promise<AsrModelProgress>
    asrModelDownload(): Promise<AsrModelProgress>
    asrModelDelete(): Promise<AsrModelProgress>
    onAsrModelProgress(cb: (p: AsrModelProgress) => void): () => void
    asrLocalWarmup(): Promise<TestResult>
    restartHotkey(): Promise<void>
    openDataDir(): Promise<void>
    dataDirInfo(): Promise<DataDirInfo>
    changeDataDir(): Promise<{ ok: boolean; canceled?: boolean; dir?: string; message?: string }>
    resetDataDir(): Promise<{ ok: boolean; message?: string }>
    open(tab?: string): void
    captureHotkey(): Promise<string>
    onFocusTab(cb: (tab: string) => void): () => void
    onHotkeyCaptured(cb: (chord: string) => void): () => void
  }
  ball: {
    dragStart(): void
    dragEnd(): void
    click(moved: boolean): void
    contextMenu(): void
    toggleBubble(): void
    resetPosition(): void
    reportError(message: string): void
    onPhase(cb: (phase: Phase) => void): () => void
    onSettings(cb: (s: PublicSettings) => void): () => void
    onRecStart(cb: () => void): () => void
    onRecStop(cb: () => void): () => void
    onAudio(cb: (chunk: AudioChunk) => void): () => void
    onAudioEnd(cb: () => void): () => void
    onAudioStop(cb: () => void): () => void
    sendPcm(buf: ArrayBuffer): void
    audioDrained(): void
    /** 主进程让渲染进程用 WGC 抓一帧（普通抓屏黑屏时的兜底） */
    onGrab(cb: () => void): () => void
    grabResult(result: GrabResult): void
  }
  /** 悬浮球右键菜单（自绘窗口） */
  menu: {
    onItems(cb: (items: BallMenuItem[]) => void): () => void
    onMeasure(cb: () => void): () => void
    resize(width: number, height: number): void
    pick(id: string): void
    close(): void
  }
  /** 仅测试用（BWU_AGENT_TEST=1 时主进程才注册） */
  agentTest: {
    list(): Promise<Array<{ id: string; name: string; risk: string }>>
    call(id: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }>
  }
  bubble: {
    onUpdate(cb: (u: BubbleUpdate) => void): () => void
    resize(width: number, height: number): void
    onMeasure(cb: () => void): () => void
    close(): void
    pin(pinned: boolean): void
    stop(): void
    clearContext(): void
    /** 打出来的文字发给主进程，走和语音一样的回答流程 */
    submit(text: string): void
    /** 需要输入时申请键盘焦点（窗口平时不抢焦点） */
    requestFocus(): void
    releaseFocus(): void
  }
  voice: {
    onTranscript(cb: (t: { text: string; final: boolean }) => void): () => void
  }
}

declare global {
  interface Window {
    bwu: BwuApi
  }
}
