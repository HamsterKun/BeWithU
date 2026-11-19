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


/** 已经确认不吃思考参数的服务端（baseUrl|model），后面不再带参数 */
const thinkingBlocked = new Set<string>()

function thinkingKey(llm: LlmSettings): string {
  return `${llm.baseUrl.trim().toLowerCase()}|${llm.model.trim().toLowerCase()}`
}

/**
 * 思考模式参数：不同厂商写法不一样，这里按"最常见 → 特定厂商"叠加，
 * 服务端不认识时会返回 400，由调用处自动去掉参数重试。
 */
export function thinkingParams(llm: LlmSettings): Record<string, unknown> {
  const t = llm.thinking
  if (!t?.enabled) return {}
  const key = thinkingKey(llm)
  if (thinkingBlocked.has(key)) return {}
  const probe = `${llm.model} ${llm.baseUrl}`.toLowerCase()
  const params: Record<string, unknown> = {}
  // OpenAI / OpenRouter / vLLM 都认这个
  params.reasoning_effort = t.effort
  // 千问 / 阿里云百炼
  if (/qwen|dashscope|aliyun/.test(probe)) params.enable_thinking = true
  // OpenRouter / Anthropic 风格
  if (/openrouter|anthropic/.test(probe)) params.thinking = { type: 'enabled' }
  return params
}

/** 400 的报错看起来像"不认识这个参数"吗 */
export function looksLikeParamReject(body: string): boolean {
  return /reasoning_effort|enable_thinking|thinking|unknown|unsupported|unrecognized|invalid[ _]?(request|param)/i.test(
    body
  )
}

export function markThinkingBlocked(llm: LlmSettings): void {
  thinkingBlocked.add(thinkingKey(llm))
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
  /** 思考内容增量（不参与播报） */
  onReasoning?: (text: string) => void
}): AsyncGenerator<string> {
  const { llm, messages, signal } = opts
  if (!llm.model.trim()) throw new Error('还没填模型名')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  }
  if (llm.apiKey.trim()) headers.Authorization = `Bearer ${llm.apiKey.trim()}`

  const payload = {
    model: llm.model.trim(),
    messages,
    stream: true,
    temperature: llm.temperature,
    // 有些服务端只有带上这个才会在最后一个 chunk 里返回 usage
    stream_options: { include_usage: true }
    // 不传 max_tokens：交给提示词软控制，硬截断会让回答断在半句话上
  }
  const send = (extra: Record<string, unknown>): Promise<Response> =>
    fetch(endpoint(llm.baseUrl), {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ ...payload, ...extra })
    })

  const extra = thinkingParams(llm)
  let res = await send(extra)
  if (!res.ok && res.status === 400 && Object.keys(extra).length) {
    const body = await res.text().catch(() => '')
    if (looksLikeParamReject(body)) {
      // 服务端不认思考参数：记住这个端点，去掉参数重试一次
      markThinkingBlocked(llm)
      log('llm: 服务端不支持思考参数，已降级重试', body.replace(/\s+/g, ' ').slice(0, 200))
      res = await send({})
    } else {
      log('llm: http error', res.status, body.replace(/\s+/g, ' ').slice(0, 400))
      throw new Error(friendlyError(res.status))
    }
  }

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
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
        if (typeof reasoning === 'string' && reasoning) opts.onReasoning?.(reasoning)
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
