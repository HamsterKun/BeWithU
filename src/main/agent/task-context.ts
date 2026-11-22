import { estimateTokens, IMAGE_TOKENS } from '../services/context'
import type { ChatMessage } from '../services/llm'

export type AgentMessage = ChatMessage
  | { role: 'assistant'; content: string | null; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

function messageTokens(message: AgentMessage): number {
  const content = message.content
  const textTokens = Array.isArray(content)
    ? content.reduce((tokens, part) => tokens + (part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKENS), 0)
    : estimateTokens(content ?? '')
  return 8 + textTokens + ('tool_calls' in message ? estimateTokens(JSON.stringify(message.tool_calls)) : 0)
}

export class AgentTaskContext {
  private readonly checkpoint: ChatMessage = { role: 'user', content: '' }
  private readonly notes: string[] = []
  private folded = 0

  fit(messages: AgentMessage[], currentUser: ChatMessage, screenshot: ChatMessage | undefined, budget: number): void {
    let tokens = messages.reduce((sum, message) => sum + messageTokens(message), 0)
    if (tokens <= budget) return

    // 先收起最早的对话，再把本任务的旧步骤按完整调用批次收拢。
    let start = messages.indexOf(currentUser)
    while (start > 1 && tokens > budget) {
      tokens -= messageTokens(messages[1])
      messages.splice(1, 1)
      start--
    }
    const oldCheckpoint = messages.indexOf(this.checkpoint)
    if (oldCheckpoint >= 0) {
      tokens -= messageTokens(this.checkpoint)
      messages.splice(oldCheckpoint, 1)
    }

    const observationTokens = screenshot ? messageTokens(screenshot) : 0
    const noteReserve = Math.min(800, Math.floor(budget / 8))
    const firstBatch = start + 1
    let keepScreenshot = false
    while (tokens + (keepScreenshot ? observationTokens : 0) > budget - noteReserve && messages.length > firstBatch) {
      const next = messages.findIndex((message, i) => i > firstBatch && 'tool_calls' in message)
      // 优先保留最后的完整调用与响应。它们本身都超过预算时才收拢。
      if (next < 0 && tokens + (keepScreenshot ? observationTokens : 0) <= budget - 90) break
      const removed = messages.splice(firstBatch, next < 0 ? messages.length - firstBatch : next - firstBatch)
      for (const message of removed) {
        tokens -= messageTokens(message)
        if (message === screenshot) keepScreenshot = true
      }
      this.captureNotes(removed)
    }
    if (this.folded) {
      let details = this.notes.join('\n')
      while (estimateTokens(details) > noteReserve - 75 && this.notes.length) {
        this.notes.shift()
        details = this.notes.join('\n')
      }
      this.checkpoint.content =
        `【本任务先前的工具记录】已收拢 ${this.folded} 批调用。以下是仍保留的近期结果，继续前核对必要状态。\n${details}`
      messages.splice(firstBatch, 0, this.checkpoint)
    }
    if (keepScreenshot && screenshot) messages.push(screenshot)
  }

  private captureNotes(batch: AgentMessage[]): void {
    const calls = batch.find((message) => 'tool_calls' in message)
    if (!calls || !('tool_calls' in calls)) return
    this.folded++
    const results = new Map(batch.filter((message) => message.role === 'tool').map((result) => [result.tool_call_id, result.content]))
    for (const call of calls.tool_calls) {
      let detail = '结果已收拢'
      try {
        const result = JSON.parse(results.get(call.id) ?? '{}')
        const metadata = result.data?.result ?? result.data
        const cursor = metadata?.nextOffsetBytes ?? metadata?.nextOffset
        const path = typeof metadata?.path === 'string' ? metadata.path.slice(0, 120) : ''
        detail = `${result.ok === true ? '成功' : '失败'} ${String(result.result ?? '').slice(0, 160)}`
        if (path) detail += ` 路径 ${path}`
        if (typeof cursor === 'number') detail += ` 续读位置 ${cursor}`
      } catch { /* 截断或未知结果保持简短说明 */ }
      this.notes.push(`${call.function.name} ${call.function.arguments.slice(0, 90)} → ${detail.replace(/\s+/g, ' ')}`)
      if (this.notes.length > 30) this.notes.shift()
    }
  }
}
