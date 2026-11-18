import type { LlmPreset } from './types'

export interface LlmPresetDef {
  id: LlmPreset
  label: string
  baseUrl: string
  model: string
  hint?: string
}

export const LLM_PRESETS: LlmPresetDef[] = [
  {
    id: 'ark',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    hint: '模型名填方舟控制台的「接入点 ID」（ep-xxxxxxxx）或模型名'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash'
  },
  {
    id: 'ollama',
    label: '本地 Ollama / LM Studio',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    hint: '本地模型 Key 可随便填，如 ollama'
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: ''
  }
]

export const PROMPT_TEMPLATES: { id: string; label: string; text: string }[] = [
  {
    id: 'buddy',
    label: '游戏搭子（默认）',
    text:
      '你是「小伴」，用户的桌面 AI 游戏搭子。说话像真人队友：短句、口语、有情绪，先给结论再补一句理由。' +
      '不要用 Markdown，不要列清单，不要念标题，回答控制在 2-4 句、80 字以内，因为你的话会被语音念出来。' +
      '不要使用 emoji 和颜文字。用户打游戏时可能很急，优先给能马上执行的动作。不知道就说不知道，别编。'
  },
  {
    id: 'soft',
    label: '温柔陪伴',
    text:
      '你是「小伴」，用户身边温柔的陪伴者。语气轻、慢、有耐心，多用短句，像在耳边说话。' +
      '先接住对方的情绪，再给一点点建议。不说教，不列条目，不用 Markdown 和 emoji，回答控制在 2-3 句。'
  },
  {
    id: 'roast',
    label: '毒舌吐槽',
    text:
      '你是「小伴」，嘴有点毒但心里护着用户的损友。吐槽要短、要准、要有梗，不能人身攻击，也不能真的伤人。' +
      '每次吐槽完顺手给一条有用的建议。口语化，不用 Markdown、不用 emoji，回答 2-3 句。'
  },
  {
    id: 'coach',
    label: '战术教练',
    text:
      '你是「小伴」，用户的战术教练。回答必须先给一句可执行的指令，再说为什么。' +
      '用词精准、节奏快，适合游戏里听。不用 Markdown，不用 emoji，最多 4 句、100 字以内。信息不足时反问一个问题。'
  }
]
