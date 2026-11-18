/**
 * Agent 用的 LLM 调用：一次性（非流式）请求 tool_calls。
 * 流式已经在普通聊天里用；Agent 需要完整的 tool_calls 结构，非流式更简单可靠。
 */
import { readFileSync } from 'node:fs'
import type { LlmSettings } from '../../shared/types'
import { settingsStore } from '../store/settings'
import { log } from '../logger'
import type { ChatMessage } from '../services/llm'

export interface AgentToolCall {
  id: string
  name: string
  args: string
}

export interface AgentTurnResult {
  text: string
  toolCalls: AgentToolCall[]
}

interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

function endpoint(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(url)) return url
  if (/\/v\d+$/i.test(url)) return `${url}/chat/completions`
  return `${url}/v1/chat/completions`
}

/* ---------------------------------------------------------------- mock ---- */

interface MockResponse {
  text?: string
  toolCalls?: Array<{ name: string; args: unknown }>
}
interface MockScript {
  /** 默认序列 */
  responses?: MockResponse[]
  /** 按用户任务的命中关键字选择序列（先匹配先赢） */
  scenarios?: Record<string, MockResponse[]>
}
let mockScript: MockScript | null = null
const mockCursors = new Map<string, number>()
const mockWrapped = new Set<string>()

/** 测试模式：BWU_AGENT_MOCK 指向 JSON 脚本，按场景/顺序返回预设响应 */
function mockTurn(scenario?: string): AgentTurnResult | null {
  if (!process.env['BWU_AGENT_MOCK']) return null
  if (!mockScript) {
    try {
      mockScript = JSON.parse(readFileSync(process.env['BWU_AGENT_MOCK'], 'utf8')) as MockScript
    } catch (e) {
      log('agent: mock 读取失败', e)
      mockScript = {}
    }
  }
  let key = '__default__'
  let queue: MockResponse[] = mockScript.responses ?? []
  if (scenario && mockScript.scenarios) {
    for (const [k, v] of Object.entries(mockScript.scenarios)) {
      if (scenario.includes(k)) {
        key = k
        queue = v
        break
      }
    }
  }
  const index = mockCursors.get(key) ?? 0
  mockCursors.set(key, index + 1)
  let r = queue[index]
  if (!r) {
    // 同一个场景再跑一次时回绕到开头（只回绕一次，避免脚本只有工具调用时死循环）
    if (!mockWrapped.has(key) && queue.length) {
      mockWrapped.add(key)
      mockCursors.set(key, 1)
      r = queue[0]
    }
  }
  if (!r) return { text: '（mock 脚本已结束）', toolCalls: [] }
  return {
    text: r.text ?? '',
    toolCalls: (r.toolCalls ?? []).map((c, i) => ({
      id: `mock-${key}-${index}-${i}`,
      name: c.name,
      args: JSON.stringify(c.args ?? {})
    }))
  }
}

/* ------------------------------------------------------------ real call ---- */

export async function chatWithTools(opts: {
  messages: unknown[]
  tools: ToolSpec[]
  signal?: AbortSignal
  /** 测试用：当前任务文本，用来选 mock 场景 */
  scenario?: string
}): Promise<AgentTurnResult> {
  const mocked = mockTurn(opts.scenario)
  if (mocked) return mocked

  const s = settingsStore.get()
  const llm: LlmSettings = s.llm
  if (!llm.baseUrl.trim() || !llm.model.trim() || !llm.apiKey.trim()) {
    throw new Error('还没配置大模型（Base URL / 模型名 / API Key）')
  }
  const body: Record<string, unknown> = {
    model: llm.model,
    messages: opts.messages,
    temperature: llm.temperature,
    stream: false
  }
  if (opts.tools.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  const res = await fetch(endpoint(llm.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`大模型请求失败（HTTP ${res.status}）：${detail.slice(0, 300)}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
      }
    }>
  }
  const msg = data.choices?.[0]?.message
  const text = typeof msg?.content === 'string' ? msg.content : ''
  const toolCalls: AgentToolCall[] = (msg?.tool_calls ?? []).map((c, i) => ({
    id: c.id || `call-${i}`,
    name: c.function?.name ?? '',
    args: c.function?.arguments ?? '{}'
  }))
  return { text, toolCalls }
}
