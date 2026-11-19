import type { Settings } from './types'

export const APP_NAME = 'BeWithU'
export const APP_ID = 'com.bewithu.app'

export const DEFAULT_SYSTEM_PROMPT =
  '你是「小伴」，用户的桌面 AI 游戏搭子。说话像真人队友：短句、口语、有情绪，先给结论再补一句理由。' +
  '不要用 Markdown，不要列清单，不要念标题，回答控制在 2-4 句、80 字以内，因为你的话会被语音念出来。' +
  '不要使用 emoji 和颜文字。用户打游戏时可能很急，优先给能马上执行的动作。不知道就说不知道，别编。'

export const DEFAULT_AGENT_PROMPT = `【你现在可以使用工具直接操作这台电脑】
工作规则：
1. 改文件、处理文档、批量操作时优先用文件工具或 shell，不要用模拟键鼠去打字编辑文本；键鼠只用来操作图形界面（点按钮、切窗口、拖拽）。
2. 一步只做一件小事，看结果再决定下一步；不要重复同样的失败尝试。
3. 本次任务最多 {{max_steps}} 步，做完用 1-3 句话汇报结果。
{{shell_rule}}
5. 不要编造工具结果，只根据工具返回汇报。
6. 调用工具之前不要写"我先把…打开"这类过程叙述；直接用工具，最后一次性汇报结果。
7. 汇报时不要复述用户的原话，不要描述你的思考过程或用了哪个工具。`

export const DEFAULT_CLOSING_PROMPT =
  '现在用 1-3 句话直接告诉用户结果（做了什么、结果如何、下一步建议），不要再调用任何工具。'

export const DEFAULT_SUMMARY_PROMPT = `你负责记住「你和这个人之间发生过什么」。把【已有记忆】和【新增对话】合并成一段自然、连贯的回忆，之后的对话会把它当成你已经知道的事。

怎么写：
1. 像跟朋友回忆往事那样说话，用「他/她」叙事，不要写成「- 」条目、备忘录或会议纪要。
2. 每件事都要交代来龙去脉：因为什么起头、中间怎么折腾的、最后成了没有；没解决的写清楚卡在哪。
3. 留住有人味的东西：他怎么称呼自己、当时什么情绪（烦、乐、急）、反复提过的偏好和雷区、你们之间的约定和玩笑。
4. 正在玩的游戏、正在做的事，要写清进度和状态，不要只丢一个名字。
5. 宁可少写几件事，也要把写下的那几件说清楚；不要为了凑字数罗列。
6. 不编造、不脑补工具结果，不确定的事就不写。
7. 全文 300 字以内，只输出这段回忆本身：不要标题、不要 Markdown、不要分点符号。

【已有记忆】
`

export const DEFAULT_VISION_NOTE = '（附上我此刻的屏幕截图）'

export const DEFAULT_SETTINGS: Settings = {
  llm: {
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    // 模型名不预填：让用户自己「获取列表」或手填
    model: '',
    temperature: 0.8,
    historyTurns: 8,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    summary: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: ''
    },
    thinking: {
      // 默认不开启：思考更慢也更贵，交给用户自己决定
      enabled: false,
      effort: 'medium'
    },
    vision: {
      enabled: false
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
    opacity: 100,
    x: -1,
    y: -1
  },
  bubble: {
    holdMs: 6000,
    keepOpen: false,
    showWaveform: true
  },
  ui: {
    theme: 'light',
    muted: false,
    assistantName: '小伴',
    micDeviceId: ''
  },
  prompts: {
    agent: DEFAULT_AGENT_PROMPT,
    closing: DEFAULT_CLOSING_PROMPT,
    summary: DEFAULT_SUMMARY_PROMPT,
    visionNote: DEFAULT_VISION_NOTE
  },
  agent: {
    // 默认关闭：用户主动开启前，一切照旧（普通聊天）
    enabled: false,
    // Shell 默认关闭；关闭时模型会被引导去提醒用户开权限
    shellEnabled: false,
    maxSteps: 30,
    stepTimeoutMs: 20000,
    audit: true,
    auditDetail: false,
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
  },
  mcp: { servers: [] }
}


