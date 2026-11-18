import type { Settings } from './types'

export const APP_NAME = 'BeWithU'
export const APP_ID = 'com.bewithu.app'

export const DEFAULT_SYSTEM_PROMPT =
  '你是「小伴」，用户的桌面 AI 游戏搭子。说话像真人队友：短句、口语、有情绪，先给结论再补一句理由。' +
  '不要用 Markdown，不要列清单，不要念标题，回答控制在 2-4 句、80 字以内，因为你的话会被语音念出来。' +
  '不要使用 emoji 和颜文字。用户打游戏时可能很急，优先给能马上执行的动作。不知道就说不知道，别编。'

export const DEFAULT_SETTINGS: Settings = {
  llm: {
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.8,
    historyTurns: 8,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    summary: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: ''
    },
    vision: {
      enabled: true
    }
  },
  tts: {
    enabled: false,
    provider: 'volc',
    authMode: 'apikey',
    appId: '',
    accessToken: '',
    apiKey: '',
    resourceId: 'seed-tts-2.0',
    speaker: 'zh_female_vv_uranus_bigtts',
    speed: 0,
    loudness: 0,
    volume: 0.9,
    breeze: {
      apiKey: '',
      voiceId: '',
      modelId: 'breeze-tts-2',
      language: 'zh'
    }
  },
  asr: {
    mode: 'local',
    provider: 'volc',
    authMode: 'apikey',
    appId: '',
    accessToken: '',
    apiKey: '',
    resourceId: 'volc.seedasr.sauc.duration',
    language: 'zh-CN'
  },
  voice: {
    hotkey: 'Mouse4',
    mode: 'hold',
    minHoldMs: 250,
    bargeIn: true
  },
  ball: {
    // 默认皮肤：大肥鱼
    image: 'builtin:dafiyu',
    size: 96,
    opacity: 84,
    x: -1,
    y: -1
  },
  bubble: {
    holdMs: 6000,
    keepOpen: false,
    showWaveform: true
  },
  ui: {
    theme: 'dark',
    muted: false,
    assistantName: '小伴',
    micDeviceId: ''
  },
  agent: {
    // 默认关闭：用户主动开启前，一切照旧（普通聊天）
    enabled: false,
    // Shell 默认关闭；关闭时模型会被引导去提醒用户开权限
    shellEnabled: false,
    maxSteps: 10,
    stepTimeoutMs: 20000,
    audit: true,
    files: { fullAccess: false, dirs: [] },
    disabledTools: [],
    trustedTools: [],
    skillsEnabled: true
  },
  search: {
    enabled: false,
    provider: 'tavily',
    tavilyBaseUrl: 'https://api.tavily.com',
    tavilyApiKey: '',
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekApiKey: '',
    maxResults: 5,
    auto: true
  }
}
