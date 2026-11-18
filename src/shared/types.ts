/* 共享类型：主进程 / preload / 渲染进程共用，禁止引入 electron 依赖 */

export type LlmPreset = 'ark' | 'deepseek' | 'openai' | 'moonshot' | 'zhipu' | 'ollama' | 'custom'
export type TtsAuthMode = 'console' | 'apikey'
/** 语音合成服务商：火山引擎 / Breeze Blue */
export type TtsProvider = 'volc' | 'breeze'
export type VoiceMode = 'hold' | 'toggle'
export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting'

export interface SummaryModelSettings {
  /** 开启后用专用（更快的）模型做记忆总结，否则复用对话模型 */
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
}

export interface VisionSettings {
  /** 每次说话自动截一张当前屏幕发给模型 */
  enabled: boolean
}

export interface LlmSettings {
  preset: LlmPreset
  baseUrl: string
  /** 密钥，落盘加密，渲染进程永远拿不到明文 */
  apiKey: string
  model: string
  temperature: number
  historyTurns: number
  systemPrompt: string
  summary: SummaryModelSettings
  vision: VisionSettings
}

export interface BreezeTtsSettings {
  /** Breeze Blue API Key */
  apiKey: string
  /** 音色 ID，形如 voc_xxxxxxxx */
  voiceId: string
  /** breeze-tts-2 / breeze-tts-2-multilingual */
  modelId: string
  /** ISO 639-1 两位语言码，留空交给服务端判断 */
  language: string
}

export interface TtsSettings {
  /** 关闭后只出文字，不再调用语音合成接口 */
  enabled: boolean
  provider: TtsProvider
  authMode: TtsAuthMode
  appId: string
  accessToken: string
  apiKey: string
  resourceId: string
  speaker: string
  /** [-50, 100] */
  speed: number
  /** [-50, 100] */
  loudness: number
  /** 播放增益 0~1 */
  volume: number
  breeze: BreezeTtsSettings
}

export interface AsrSettings {
  /** local = 本地 sherpa-onnx（SenseVoice）；volc = 火山流式识别 */
  mode: 'local' | 'volc'
  provider: 'volc'
  /** 新版控制台只有 API Key；旧版控制台用 AppID + Access Token */
  authMode: 'console' | 'apikey'
  appId: string
  accessToken: string
  apiKey: string
  resourceId: string
  language: string
}

export interface VoiceSettings {
  /** 和弦文本，如 "Mouse4" / "Alt+X" / "Ctrl+Shift+Space" */
  hotkey: string
  mode: VoiceMode
  minHoldMs: number
  bargeIn: boolean
}

export interface BallSettings {
  /** "builtin:dafiyu" 之类的内置皮肤 id，或 data:image/... 自定义图片 */
  image: string
  /** 直径 px，64~160 */
  size: number
  /** 0~100 */
  opacity: number
  x: number
  y: number
}

export interface BubbleSettings {
  /** 播完后停留时长 ms */
  holdMs: number
  keepOpen: boolean
  showWaveform: boolean
}

export interface UiSettings {
  theme: 'dark' | 'light'
  muted: boolean
  assistantName: string
  micDeviceId: string
}

export interface MetaSettings {
  /** 一次性迁移标记：新版默认关闭语音合成 */
  ttsDefaultOffApplied?: boolean
}

/** 悬浮球右键菜单项（自绘菜单，避免原生菜单在置顶透明窗口上点外部不关闭） */
export interface BallMenuItem {
  id: string
  label: string
  /** 分割线 */
  separator?: boolean
  /** 危险操作（退出等） */
  danger?: boolean
  /** 勾选状态（静音等） */
  checked?: boolean
}

/** Agent 文件访问设置 */
export interface AgentFileSettings {
  /** 完全访问：允许对任意用户目录读写 */
  fullAccess: boolean
  /** 额外允许的目录（绝对路径）；为空时用 桌面/文档/下载 */
  dirs: string[]
}

/** Agent 能力设置 */
export interface AgentCustomTool {
  id: string
  name: string
  description: string
  risk: 'low' | 'high'
  permissions: string[]
  entry: string
  dir: string
  trusted: boolean
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  whenToUse: string
  path: string
  chars: number
}

export interface AgentSettings {
  /** 总开关：关闭时完全走原来的聊天流程 */
  enabled: boolean
  /**
   * Shell 能力：默认关闭。关闭时模型调 shell 会被告知"没有权限"并提醒用户开启；
   * 开启后为完全信任模式（只拦截 rm -rf 这类极高危命令）。
   */
  shellEnabled: boolean
  /** 单轮最多步数（默认 10） */
  maxSteps: number
  /** 单步超时（毫秒） */
  stepTimeoutMs: number
  /** 审计日志 */
  audit: boolean
  files: AgentFileSettings
  /** 被禁用的工具 id */
  disabledTools: string[]
  /** 已信任的自定义工具 id（未信任的不注册，模型看不到也调不到） */
  trustedTools: string[]
  /** 是否把 Skill 摘要注入系统提示词 */
  skillsEnabled: boolean
}

export interface Settings {
  llm: LlmSettings
  tts: TtsSettings
  asr: AsrSettings
  voice: VoiceSettings
  ball: BallSettings
  bubble: BubbleSettings
  ui: UiSettings
  agent: AgentSettings
  meta?: MetaSettings
}

export type SecretPath =
  | 'llm.apiKey'
  | 'llm.summary.apiKey'
  | 'tts.accessToken'
  | 'tts.apiKey'
  | 'tts.breeze.apiKey'
  | 'asr.accessToken'
  | 'asr.apiKey'

export interface PublicSettings extends Settings {
  secretSet: Record<SecretPath, boolean>
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type SettingsPatch = DeepPartial<Settings> & { clearSecrets?: SecretPath[] }

export interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
  sample?: string
}

export interface BubbleNotice {
  kind: 'info' | 'error' | 'success'
  text: string
  action?: 'open-settings' | 'open-voice'
}

export interface AudioChunk {
  seq: number
  /** Int16 PCM, 单声道 */
  pcm: ArrayBuffer
  sampleRate: number
  last: boolean
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
  at: number
}

export interface DataDirInfo {
  dir: string
  defaultDir: string
  custom: boolean
  /** 数据目录占用（MB） */
  sizeMB: number
}

export interface AsrModelProgress {
  state: 'idle' | 'downloading' | 'ready' | 'error'
  file: string
  bytes: number
  total: number
  error?: string
}

export interface MemoryInfo {
  summary: string
  updatedAt: number
  /** 待总结的对话条数 / 触发阈值 */
  pending: number
  threshold: number
}

export interface ScreenCaptureInfo {
  ok: boolean
  message: string
  width: number
  height: number
  bytes: number
  displayLabel: string
  dataUrl: string
}

export interface AppInfo {
  version: string
  userData: string
  hotkeyActive: boolean
  hotkeyMessage?: string
  hotkeyPretty?: string
  platform: string
  logPath?: string
}
