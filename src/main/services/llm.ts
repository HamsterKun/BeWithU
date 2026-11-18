import type { LlmSettings } from '../../shared/types'
import { log } from '../logger'
import { recordTokens } from '../store/usage'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

function endpoint(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (!url) throw new Error('还没填 Base URL')
  if (/\/chat\/completions$/.test(url)) return url
  return `${url}/chat/completions`
}

/** 面向用户的错误提示：只说清怎么处理，状态码与服务端原文只进日志 */
function friendlyError(status: number): string {
  if (status === 401 || status === 403) return 'API Key 无效，或没有使用该模型的权限'
  if (status === 404) return '请求地址不正确，请检查 Base URL'
  if (status === 429) return '请求过于频繁或额度不足，请稍后再试'
  if (status >= 500) return '服务暂时不可用，请稍后再试'
  return '请求失败，请稍后再试'
}

/** 从各种 baseUrl 推导出 /models 端点 */
export function modelsEndpoint(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(url)) return url.replace(/\/chat\/completions$/i, '/models')
  if (/\/v\d+$/i.test(url)) return `${url}/models`
  return `${url}/v1/models`
}

/** 拉取服务商支持的模型列表（OpenAI 兼容的 GET /models） */
export async function listModels(llm: LlmSettings): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const headers: Record<string, string> = {}
    if (llm.apiKey.trim()) headers.Authorization = `Bearer ${llm.apiKey.trim()}`
    const res = await fetch(modelsEndpoint(llm.baseUrl), { headers, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return (json.data ?? [])
      .map((d) => String(d.id ?? ''))
      .filter(Boolean)
      .sort()
  } finally {
    clearTimeout(timer)
  }
}

export async function* streamChat(opts: {
  llm: LlmSettings
  messages: ChatMessage[]
  signal: AbortSignal
  /** 记账用：闲聊还是记忆总结 */
  purpose?: 'chat' | 'summary'
}): AsyncGenerator<string> {
  const { llm, messages, signal } = opts
  if (!llm.model.trim()) throw new Error('还没填模型名')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  }
  if (llm.apiKey.trim()) headers.Authorization = `Bearer ${llm.apiKey.trim()}`

  const res = await fetch(endpoint(llm.baseUrl), {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: llm.model.trim(),
      messages,
      stream: true,
      temperature: llm.temperature,
      // 有些服务端只有带上这个才会在最后一个 chunk 里返回 usage
      stream_options: { include_usage: true }
      // 不传 max_tokens：交给提示词软控制，硬截断会让回答断在半句话上
    })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log('llm: http error', res.status, body.replace(/\s+/g, ' ').slice(0, 400))
    throw new Error(friendlyError(res.status))
  }
  if (!res.body) throw new Error('服务端没有返回数据流')

  const decoder = new TextDecoder()
  let buffer = ''
  const body = res.body as unknown as AsyncIterable<Uint8Array>

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const json = JSON.parse(data)
        const choice = json.choices?.[0]
        const delta = choice?.delta?.content ?? choice?.message?.content ?? ''
        if (typeof delta === 'string' && delta) yield delta
        if (choice?.finish_reason === 'error') throw new Error('模型返回错误')
        // usage 可能在最后一个 chunk（choices 为空）
        if (json.usage) {
          recordTokens(
            opts.purpose ?? 'chat',
            Number(json.usage.prompt_tokens) || 0,
            Number(json.usage.completion_tokens) || 0
          )
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }
}

export async function testLlm(llm: LlmSettings): Promise<{ ok: boolean; message: string; latencyMs?: number; sample?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  const started = Date.now()
  try {
    let text = ''
    for await (const delta of streamChat({
      llm: { ...llm, temperature: 0.2 },
      messages: [
        { role: 'system', content: '你是连通性测试助手。' },
        { role: 'user', content: '只回复四个字：连接成功' }
      ],
      signal: controller.signal
    })) {
      text += delta
      if (text.length > 60) break
    }
    const latency = Date.now() - started
    if (!text.trim()) return { ok: false, message: '已连接，但没有收到回复', latencyMs: latency }
    return { ok: true, message: `连接成功 · ${latency}ms`, latencyMs: latency, sample: text.trim().slice(0, 60) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log('llm test 失败', msg)
    return { ok: false, message: controller.signal.aborted ? '连接超时，请检查网络或地址' : msg }
  } finally {
    clearTimeout(timer)
  }
}
