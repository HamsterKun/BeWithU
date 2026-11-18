/** Agent 能力入口：注册内置工具、暴露统一调用接口 */
import { getTool, listTools } from './registry'
import { registerInputTools } from './tools/input'
import { registerShellTools } from './tools/shell'
import { registerFileTools } from './tools/files'
import { registerSystemTools } from './tools/system'
import { registerSkillTools } from './tools/skills'
import { registerWebTools } from './tools/web'
import { registerCustomTools } from './custom-tools'
import { mcpCallTool, mcpListTools } from './mcp'
import { settingsStore } from '../store/settings'
import { registerTool } from './registry'
import type { ToolContext, ToolResult } from './types'
import { log } from '../logger'
import { workerPing } from '../services/input-inject'
import { recordAudit } from './audit'

let registered = false

export function registerBuiltinTools(): void {
  if (registered) return
  registered = true
  registerInputTools()
  registerFileTools()
  registerSystemTools()
  registerShellTools()
  registerSkillTools()
  registerWebTools()
  // 已信任的第三方工具
  registerCustomTools()
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
    recordAudit({
      at: Date.now(),
      callId,
      toolId: id,
      ok: res.ok,
      summary: res.summary.slice(0, 500),
      argsPreview: JSON.stringify(args).slice(0, 300)
    })
    return res
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log(`agent: ${id} 失败`, message)
    return { ok: false, summary: message }
  }
}

export { listTools, toOpenAiTools } from './registry'

/** MCP 工具 id：mcp.<server>.<tool>，wire 名会自动把点换成下划线 */
export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName}`.replace(/[^a-zA-Z0-9_.-]+/g, '_')
}

/**
 * 把已启用的 MCP 服务器的工具注册进来（幂等）。
 * 连不上就跳过并在日志里留痕，不阻塞本次任务。
 */
export async function ensureMcpTools(): Promise<void> {
  const servers = settingsStore.get().mcp.servers.filter((s) => s.enabled)
  if (!servers.length) return
  const results = await Promise.allSettled(servers.map((s) => mcpListTools(s)))
  results.forEach((res, i) => {
    const server = servers[i]
    if (res.status === 'rejected') {
      log(`mcp: ${server.name} 连接失败`, res.reason instanceof Error ? res.reason.message : String(res.reason))
      return
    }
    for (const t of res.value) {
      const id = mcpToolId(server.id, t.name)
      if (getTool(id)) continue
      registerTool({
        id,
        name: `${server.name} · ${t.name}`,
        description: t.description || `来自 MCP 服务「${server.name}」的工具`,
        risk: 'low',
        params: { ...t.inputSchema, type: 'object' },
        run: async (args) => {
          try {
            const r = await mcpCallTool(server, t.name, args)
            return { ok: r.ok, summary: r.summary }
          } catch (e) {
            return { ok: false, summary: e instanceof Error ? e.message : String(e) }
          }
        }
      })
    }
    log('mcp: 已注册工具', `${server.name} x${res.value.length}`)
  })
}
