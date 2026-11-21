/* 共享类型：主进程 / preload / 渲染进程共用，禁止引入 electron 依赖 */

export type LlmPreset = 'ark' | 'deepseek' | 'openai' | 'moonshot' | 'zhipu' | 'ollama' | 'custom'
export type TtsAuthMode = 'console' | 'apikey'
/** 语音合成服务商：火山引擎 / Breeze Blue */
export type TtsProvider = 'volc' | 'breeze'
export type VoiceMode = 'hold' | 'toggle'
export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting'

export interface VisionSettings {
  /** 每次说话自动截一张当前屏幕发给模型 */
  enabled: boolean
}

export type ThinkingEffort = 'low' | 'medium' | 'high'

export interface ThinkingSettings {
  /** 是否请求模型的思考/推理能力 */
  enabled: boolean
  /** 思考强度：低/中/高（默认 medium） */
  effort: ThinkingEffort
}

export interface LlmSettings {
  preset: LlmPreset
  baseUrl: string
  /** 密钥，落盘加密，渲染进程永远拿不到明文 */
  apiKey: string
  model: string
  temperature: number
  systemPrompt: string
  vision: VisionSettings
  thinking: ThinkingSettings
}

/** 上下文长度档位：低=可用上限的 1/3，中=2/3，高=可用上限 */
export type ContextLevel = 'low' | 'mid' | 'high'

/**
 * 时间感知粒度：
 * - off：不带任何时间
 * - current：只给「本轮消息」带时间与间隔（默认，几乎零成本）
 * - full：每条历史消息都带（约 +8 token/条）
 */
export type TimeAwareness = 'off' | 'current' | 'full'

export interface ContextSettings {
  level: ContextLevel
  /** 0 = 按模型名自动识别；>0 = 用户手动指定模型窗口 */
  modelWindow: number
  timeAwareness: TimeAwareness
  /** 压缩时逐字保留的最近轮数（1–12） */
  keepRecentTurns: number
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
  positioned: boolean
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
  /** 开机自启动（默认开）；便携版不会注册 */
  autoLaunch: boolean
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
  /**
   * 详细审计：默认只记元数据（工具、成败、耗时、参数名与体积）。
   * 打开后才把结果摘要和参数片段（脱敏后）写进本地 JSONL。
   */
  auditDetail: boolean
  files: AgentFileSettings
  /** 被禁用的工具 id */
  disabledTools: string[]
  /** 已信任的自定义工具 id（未信任的不注册，模型看不到也调不到） */
  trustedTools: string[]
  /** 是否把 Skill 摘要注入系统提示词 */
  skillsEnabled: boolean
}

export interface DayUsage {
  chat: { input: number; output: number; calls: number }
  summary: { input: number; output: number; calls: number }
  tts: { chars: number; calls: number }
  asr: { seconds: number; calls: number }
}

export interface UsageSummary {
  today: DayUsage
  month: DayUsage
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  /** stdio：本地进程；http：远程 JSON-RPC / SSE */
  transport: 'stdio' | 'http'
  command: string
  /** 命令行参数，支持引号 */
  args: string
  url: string
  /** 每行一个 "Key: Value"；公开设置只返回空值并通过 headersConfigured 指示状态 */
  headers: string
  headersConfigured?: boolean
}

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpStatus {
  id: string
  ok: boolean
  message: string
  tools: string[]
}

export interface McpSettings {
  servers: McpServerConfig[]
}

export interface SearchSettings {
  /** 总开关：关掉后 web.search 会引导用户去打开 */
  enabled: boolean
  provider: 'tavily' | 'deepseek'
  tavilyBaseUrl: string
  tavilyApiKey: string
  deepseekBaseUrl: string
  deepseekApiKey: string
  /** 一次返回几条 */
  maxResults: number
  /** 闲聊模式（未开 Agent）时，遇到时效性问题自动搜 */
}

export interface PromptSettings {
  /** Agent 工具使用规则；支持 {{max_steps}} 与 {{shell_rule}} 占位符 */
  agent: string
  /** 模型跑完工具却没写收尾时的补问指令 */
  closing: string
  /** 长期记忆总结提示词 */
  summary: string
  /** 附截图时追加在用户消息后面的说明 */
  visionNote: string
}

export interface Settings {
  llm: LlmSettings
  /** 上下文管理：永远开启，不再提供总开关 */
  context: ContextSettings
  tts: TtsSettings
  asr: AsrSettings
  voice: VoiceSettings
  ball: BallSettings
  bubble: BubbleSettings
  ui: UiSettings
  agent: AgentSettings
  prompts: PromptSettings
  search: SearchSettings
  mcp: McpSettings
  meta?: MetaSettings
}

export type SecretPath =
  | 'llm.apiKey'
  | 'tts.accessToken'
  | 'tts.apiKey'
  | 'tts.breeze.apiKey'
  | 'asr.accessToken'
  | 'asr.apiKey'
  | 'search.tavilyApiKey'
  | 'search.deepseekApiKey'
  | `mcp.${string}.headers`

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

/**
 * 自动更新状态。安装版走 electron-updater（下载→退出时安装）；
 * 便携版没法原地替换文件，只能提示去 release 页手动下。
 */
export type UpdateKind = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  kind: UpdateKind
  /** 新版本号 */
  version?: string
  /** 下载进度 0–100 */
  percent?: number
  /** 已下载/总字节，用于显示「12.3 MB / 129 MB」 */
  transferred?: number
  total?: number
  /** 出错时的短句，直接给用户看 */
  message?: string
  /** true = 便携版，点了只能跳下载页 */
  portable?: boolean
}

/** 日志行（级别是按关键字推断的，日志格式本身不带级别字段） */
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogLine {
  /** 原始时间戳（ISO），解析不出来就是空串 */
  at: string
  level: LogLevel
  text: string
}

export interface LogTail {
  path: string
  /** 日志文件总大小（字节） */
  sizeBytes: number
  /** 文件里的总行数（只数读过的那一段） */
  total: number
  /** 过滤后返回的行数 */
  shown: number
  lines: LogLine[]
}

/** 设置页「上下文」分区用：只给统计，不给摘要正文（可能几万字） */
export interface ContextInfo {
  /** 摘要字数（0 = 还没有摘要） */
  summaryChars: number
  updatedAt: number
  /** 已归档进摘要的消息条数 */
  archived: number
  /** 还没归档、会原文发出去的消息条数 */
  pending: number
  /** 估算的当前占用 tokens */
  used: number
  /** 当前档位预算 */
  budget: number
  level: ContextLevel
  window: number
  windowSource: 'manual' | 'provider' | 'table' | 'fallback'
  /** 累计压缩次数与最近一次的前后体积 */
  compressions: number
  lastBefore: number
  lastAfter: number
  /** 最近一次请求的缓存命中（服务端不返回就是 null） */
  cacheHit: { hit: number; total: number } | null
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
  /** 按键监听是否已降级（降级时只能用切换模式） */
  hotkeyFallback?: boolean
  /** 系统加密（DPAPI）是否可用；不可用时历史与记忆退回明文并提示 */
  secureStorage?: boolean
  platform: string
  logPath?: string
  /** 便携版：开机自启动与自动更新都不可用 */
  portable?: boolean
}
