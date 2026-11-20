import type { HistoryMessage, LlmSettings } from '../../shared/types'
import { streamChat } from './llm'
import { settingsStore } from '../store/settings'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { formatStamp } from './context'

/* 压缩提示词可被用户覆盖，但默认写死一份：上下文压缩需要稳定一致的规则 */
const TIMEOUT_MS = 60000

/**
 * 把「已有摘要 + 待归档对话」压成新摘要。
 * 一律用**当前对话模型**（不再有专用总结模型），温度压低求稳定。
 */
export async function summarizeConversation(opts: {
  summary: string
  messages: HistoryMessage[]
  llm: LlmSettings
  /** 摘要字数上限，由档位决定 */
  maxChars: number
  signal?: AbortSignal
}): Promise<string> {
  const { summary, messages, llm, maxChars } = opts
  if (messages.length === 0) return summary

  // 时间戳进转写：摘要要保留"昨天/上周"这类时间锚点，否则压完就丢了时间线
  const transcript = messages
    .map((m) => `[${formatStamp(m.at)}] ${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n')

  const content =
    `${settingsStore.get().prompts?.summary || DEFAULT_SETTINGS.prompts.summary}${summary.trim() || '（无）'}` +
    `\n\n【新增对话】\n${transcript}` +
    `\n\n【字数要求】不超过 ${maxChars} 字。`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  let out = ''
  try {
    for await (const delta of streamChat({
      llm: { ...llm, temperature: 0.2 },
      messages: [{ role: 'user', content }],
      signal: controller.signal,
      purpose: 'summary'
    })) {
      out += delta
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }

  return out
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*#+\s*/gm, '')
    .trim()
    .slice(0, maxChars)
}
