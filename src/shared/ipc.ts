import type {
  AgentCustomTool,
  AgentSkill,
  AppInfo,
  AsrModelProgress,
  AudioChunk,
  BallMenuItem,
  BubbleNotice,
  DataDirInfo,
  McpServerConfig,
  MemoryInfo,
  UsageSummary,
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
  agentProgress: 'agent:progress',
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
  agentTestCall: 'agent:test-call',
  // 审批：气泡里点允许/拒绝
  agentApprove: 'agent:approve',
  // 测试用：跑一次 Agent 任务
  agentTestRun: 'agent:test-run',
  agentTestClassify: 'agent:test-classify',
  agentTestBubble: 'agent:test-bubble',
  agentTestProgress: 'agent:test-progress',
  agentTestImportTool: 'agent:test-import-tool',
  agentTestTrustTool: 'agent:test-trust-tool',
  agentTestImportSkill: 'agent:test-import-skill',
  agentTestMcp: 'agent:test-mcp',
  agentTestImportToolZip: 'agent:test-import-tool-zip',
  agentTestImportSkillZip: 'agent:test-import-skill-zip',
  // Agent 设置页
  agentToolsList: 'agent:tools-list',
  agentRuns: 'agent:runs',
  agentRunsClear: 'agent:runs-clear',
  agentOpenToolsDir: 'agent:open-tools-dir',
  agentCustomList: 'agent:custom-list',
  agentCustomImport: 'agent:custom-import',
  agentCustomTrust: 'agent:custom-trust',
  agentCustomDelete: 'agent:custom-delete',
  agentSkillsList: 'agent:skills-list',
  agentSkillImport: 'agent:skill-import',
  agentSkillDelete: 'agent:skill-delete',
  agentSkillOpenDir: 'agent:skill-open-dir',
  agentCustomImportZip: 'agent:custom-import-zip',
  agentSkillImportZip: 'agent:skill-import-zip',
  mcpList: 'mcp:list',
  mcpAdd: 'mcp:add',
  mcpRemove: 'mcp:remove',
  mcpTest: 'mcp:test',
  llmModels: 'llm:models',
  usageStats: 'usage:stats',
  usageClear: 'usage:clear',
  searchTest: 'search:test',
  appPickDir: 'app:pick-dir'
} as const

export interface AgentProgress {
  active: boolean
  step: number
  total: number
  /** thinking=模型在思考，working=正在调用工具 */
  mode?: 'thinking' | 'working'
  text?: string
}

export type BubbleUpdate =
  | { type: 'reasoning-reset' }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'agent-step'; index: number; total: number; text: string; done: boolean; ok?: boolean }
  | { type: 'approve'; req: { id: string; title: string; detail: string } | null }
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
    pickDir(): Promise<string | null>
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
    onAgent(cb: (p: AgentProgress) => void): () => void
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
  /** Agent 设置页数据 */
  agentTools: {
    list(): Promise<Array<{ id: string; name: string; risk: string; enabled: boolean }>>
    runs(): Promise<Array<{ at: number; toolId: string; ok: boolean; summary: string }>>
    clearRuns(): Promise<boolean>
    openDir(): Promise<void>
    customList(): Promise<AgentCustomTool[]>
    importCustom(): Promise<{ ok: boolean; tool?: AgentCustomTool; error?: string } | null>
    importCustomZip(): Promise<{ ok: boolean; tool?: AgentCustomTool; error?: string } | null>
    trustCustom(id: string, trusted: boolean): Promise<AgentCustomTool[]>
    deleteCustom(id: string): Promise<AgentCustomTool[]>
  }
  /** Skill 管理 */
  agentSkills: {
    list(): Promise<AgentSkill[]>
    import(): Promise<{ ok: boolean; skill?: AgentSkill; error?: string } | null>
    importZip(): Promise<{ ok: boolean; skill?: AgentSkill; error?: string } | null>
    remove(id: string): Promise<AgentSkill[]>
    openDir(): Promise<void>
  }
  /** MCP 服务器 */
  mcp: {
    list(): Promise<McpServerConfig[]>
    add(cfg: Omit<McpServerConfig, 'id' | 'enabled'>): Promise<McpServerConfig[]>
    remove(id: string): Promise<McpServerConfig[]>
    test(id: string): Promise<{ ok: boolean; message: string; tools?: string[] }>
  }
  /** 联网搜索测试 */
  searchTest(query: string): Promise<{ ok: boolean; message: string }>
  /** 拉取可用模型 */
  llmModels(): Promise<{ ok: boolean; models?: string[]; error?: string }>
  /** 用量统计 */
  usageStats(): Promise<UsageSummary>
  clearUsage(): Promise<UsageSummary>
  /** Agent 审批（气泡里点允许/拒绝） */
  agent: {
    approve(id: string, allow: boolean): void
  }
  /** 仅测试用（BWU_AGENT_TEST=1 时主进程才注册） */
  agentTest: {
    list(): Promise<Array<{ id: string; name: string; risk: string }>>
    call(id: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }>
    importTool(dir: string): Promise<unknown>
    trustTool(id: string, trusted: boolean): Promise<unknown>
    importSkill(dir: string): Promise<unknown>
    importToolZip(path: string): Promise<unknown>
    importSkillZip(path: string): Promise<unknown>
    mcpTools(): Promise<string[]>
    classify(text: string): Promise<{ route: 'chat' | 'task'; reason: string }>
    bubbleVisible(): Promise<boolean>
    progress(p: { active: boolean; mode?: 'thinking' | 'working'; step?: number; total?: number }): Promise<boolean>
    run(
      text: string,
      autoApprove?: boolean
    ): Promise<{
      text: string
      steps: number
      stopped: boolean
      tools: Array<{ toolId: string; ok: boolean; summary: string }>
    }>
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
