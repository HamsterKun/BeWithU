import type { Settings } from './types'

export const APP_NAME = 'BeWithU'
export const APP_ID = 'com.bewithu.app'
/** 项目主页：关于页的「给颗星星」卡片会打开它 */
export const APP_REPO_URL = 'https://github.com/HamsterKun/BeWithU'

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

export const DEFAULT_SUMMARY_PROMPT = `你负责压缩「你和这个人之间的对话历史」。把【已有摘要】和【新增对话】合并成一份新的摘要，之后的对话会把它当成已经发生过的事。

总体风格：
1. 用「他/她」第三人称叙事，像跟朋友回忆往事，不要写成会议纪要或流水账。
2. 每件事交代来龙去脉：因为什么起头、中间怎么折腾、最后成没成；没解决的写清楚卡在哪。
3. 留住有人味的东西：他自称什么、当时的情绪（烦、乐、急）、反复提过的偏好和雷区、你们之间的约定和玩笑。
4. 正在玩的游戏、正在做的事，写清进度和状态，不要只丢一个名字。
5. 不编造、不脑补工具结果；不确定的事就不写。

必须保留下来的具体信息（最容易在压缩中丢失，丢了用户下一轮就接不上）：
6. 具体数字、文件名、路径、命令、报错原文、配置项名，原样保留，不要改写成「一些文件」。
7. 已经做过的决定和结论，直接写结论本身，不要只写「讨论过 X」。
8. 没做完的待办和答应过的事，单独写清楚还差什么。
9. 对话里出现过的时间（日期、昨天、上周）保留时间锚点，方便判断事情先后。

输出格式：
10. 先写叙事段落（主体），再写一节「【关键事实】」，用短条目列第 6-9 条要求的内容。
11. 只输出摘要本身，不要标题、不要代码块、不要解释你在做什么。
12. 字数上限按下面给出的要求执行；宁可写长一点把事说清楚，也不要为了简短丢掉细节。

【已有摘要】
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
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    thinking: {
      // 默认不开启：思考更慢也更贵，交给用户自己决定
      enabled: false,
      effort: 'medium'
    },
    vision: {
      enabled: false
    }
  },
  context: {
    // 中档：约等于模型可用上限的 2/3，兼顾记忆深度与首字延迟
    level: 'mid',
    // 0 = 按模型名自动识别
    modelWindow: 0,
    // 只给本轮带时间：几乎零成本，且「距上一条多久」比每条打戳更有用
    timeAwareness: 'current',
    keepRecentTurns: 4
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
    micDeviceId: '',
    // 默认开机自启：常驻陪伴类工具，装了就是希望它一直在
    autoLaunch: true
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


