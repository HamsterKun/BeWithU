/** Agent 能力入口：注册内置工具、暴露统一调用接口 */
import { getTool, listTools } from './registry'
import { registerInputTools } from './tools/input'
import type { ToolContext, ToolResult } from './types'
import { log } from '../logger'
import { workerPing } from '../services/input-inject'

let registered = false

export function registerBuiltinTools(): void {
  if (registered) return
  registered = true
  registerInputTools()
  // 预热键鼠工作进程（utilityProcess），让第一次注入不用等冷启动
  void workerPing().catch(() => undefined)
  log('agent: 内置工具已注册', listTools().map((t) => t.id).join(', '))
}

export interface CallOptions {
  signal?: AbortSignal
  onLog?: (message: string) => void
}

/** 统一的工具调用入口：参数校验、取消、审计都从这里走 */
export async function callTool(
  id: string,
  args: Record<string, unknown>,
  opts: CallOptions = {}
): Promise<ToolResult> {
  registerBuiltinTools()
  const tool = getTool(id)
  if (!tool) return { ok: false, summary: `没有这个工具：${id}` }
  const callId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ctx: ToolContext = {
    callId,
    signal: opts.signal ?? new AbortController().signal,
    log: (m) => {
      log(`agent[${id}]: ${m}`)
      opts.onLog?.(m)
    }
  }
  const started = Date.now()
  try {
    const res = await tool.run(args, ctx)
    log(`agent: ${id} ${res.ok ? 'ok' : 'fail'} ${Date.now() - started}ms`)
    return res
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log(`agent: ${id} 失败`, message)
    return { ok: false, summary: message }
  }
}

export { listTools, toOpenAiTools } from './registry'
