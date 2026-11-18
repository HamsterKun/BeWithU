import type { HistoryMessage, LlmSettings } from '../../shared/types'
import { streamChat } from './llm'

/* 总结提示词写死：记忆压缩需要稳定一致的规则，不开放用户自定义 */
const SUMMARY_SYSTEM_PROMPT = `你是一个"对话记忆压缩器"。把【已有摘要】与【新增对话】合并成一份新的记忆摘要，供之后的对话继续参考。

硬性要求：
1. 用第三人称、要点式记录，每条一行，以「- 」开头。
2. 必须保留：用户怎么称呼、身份与偏好、明确说过不喜欢的事、正在玩的游戏与进度、约定过的事、最近的计划、还没解决的问题。
3. 丢弃：寒暄、重复内容、模型的自我解释、一次性的闲聊废话。
4. 不要编造或脑补，不确定的信息宁可不写。
5. 全文不超过 300 字，宁可省略细节也不要超长。
6. 只输出摘要正文，不要标题、不要前后缀、不要 Markdown 代码块围栏。

【已有摘要】
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
    `${SUMMARY_SYSTEM_PROMPT}${summary.trim() || '（无）'}\n\n【新增对话】\n${transcript}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  let out = ''
  try {
    for await (const delta of streamChat({
      llm: resolveSummaryLlm(llm),
      messages: [{ role: 'user', content }],
      signal: controller.signal
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
