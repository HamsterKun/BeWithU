import type { HistoryMessage, LlmSettings } from '../../shared/types'
import { streamChat } from './llm'
import { settingsStore } from '../store/settings'
import { DEFAULT_SETTINGS } from '../../shared/defaults'

/* 总结提示词写死：记忆压缩需要稳定一致的规则，不开放用户自定义 */
const SUMMARY_SYSTEM_PROMPT = `你负责记住「你和这个人之间发生过什么」。把【已有记忆】和【新增对话】合并成一段自然、连贯的回忆，之后的对话会把它当成你已经知道的事。

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

const SUMMARY_MAX_CHARS = 1200

/** 专用总结模型配置完整时用它，否则退回对话模型 */
export function resolveSummaryLlm(llm: LlmSettings): LlmSettings {
  const s = llm.summary
  if (s.enabled && s.baseUrl.trim() && s.model.trim()) {
    return {
      ...llm,
      baseUrl: s.baseUrl.trim(),
      apiKey: s.apiKey,
      model: s.model.trim(),
      temperature: 0.2
    }
  }
  return { ...llm, temperature: 0.2 }
}

export async function summarizeConversation(opts: {
  summary: string
  messages: HistoryMessage[]
  llm: LlmSettings
}): Promise<string> {
  const { summary, messages, llm } = opts
  if (messages.length === 0) return summary

  const transcript = messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n')

  const content =
    `${settingsStore.get().prompts?.summary || SUMMARY_SYSTEM_PROMPT}${summary.trim() || '（无）'}\n\n【新增对话】\n${transcript}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  let out = ''
  try {
    for await (const delta of streamChat({
      llm: resolveSummaryLlm(llm),
      messages: [{ role: 'user', content }],
      signal: controller.signal,
      purpose: 'summary'
    })) {
      out += delta
    }
  } finally {
    clearTimeout(timer)
  }

  return out
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*#+\s*/gm, '')
    .trim()
    .slice(0, SUMMARY_MAX_CHARS)
}
