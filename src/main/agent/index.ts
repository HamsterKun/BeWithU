/** Agent 能力入口：注册内置工具、暴露统一调用接口 */
import { getTool, listTools } from './registry'
import { registerInputTools } from './tools/input'
import { registerShellTools } from './tools/shell'
import { registerFileTools } from './tools/files'
import { registerSystemTools } from './tools/system'
import { registerScreenTools } from './tools/screen'
import { registerSkillTools } from './tools/skills'
import { registerWebTools } from './tools/web'
import { registerCustomTools } from './custom-tools'
import { disconnectMcp, mcpCallTool, mcpConfigKey, mcpListTools } from './mcp'
import { settingsStore } from '../store/settings'
import { registerTool, unregisterTool } from './registry'
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
  registerScreenTools()
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
  if (opts.signal?.aborted) return { ok: false, summary: '任务已取消，工具未执行' }
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
      durationMs: Date.now() - started,
      args,
      summary: res.summary
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

const mcpOwned = new Map<string, { configKey: string; ids: Set<string> }>()
let mcpRefresh = 0

function unregisterMcpTools(serverId: string): void {
  const owned = mcpOwned.get(serverId)
  if (owned) for (const id of owned.ids) unregisterTool(id)
  mcpOwned.delete(serverId)
}

export function unregisterMcpServer(serverId: string): void {
  unregisterMcpTools(serverId)
  disconnectMcp(serverId)
}

/**
 * 把已启用的 MCP 服务器的工具注册进来（幂等）。
 * 连不上就跳过并在日志里留痕，不阻塞本次任务。
 */
export async function ensureMcpTools(): Promise<void> {
  const refresh = ++mcpRefresh
  const configured = settingsStore.mcpServers()
  const enabled = configured.filter((s) => s.enabled)
  const enabledIds = new Set(enabled.map((s) => s.id))

  for (const serverId of mcpOwned.keys()) {
    if (!enabledIds.has(serverId)) unregisterMcpServer(serverId)
  }

  const configKeys = new Map(enabled.map((server) => [server.id, mcpConfigKey(server)]))
  for (const server of enabled) {
    const configKey = configKeys.get(server.id)!
    const previous = mcpOwned.get(server.id)
    if (previous && previous.configKey !== configKey) unregisterMcpServer(server.id)
  }

  const results = await Promise.allSettled(enabled.map((s) => mcpListTools(s)))
  if (refresh !== mcpRefresh) return
  results.forEach((res, i) => {
    const server = enabled[i]
    const configKey = configKeys.get(server.id)!
    const current = settingsStore.mcpServers().find((s) => s.id === server.id && s.enabled)
    if (!current || mcpConfigKey(current) !== configKey) {
      unregisterMcpServer(server.id)
      return
    }
    unregisterMcpTools(server.id)
    if (res.status === 'rejected') {
      disconnectMcp(server.id)
      log(`mcp: ${server.name} 连接失败`, res.reason instanceof Error ? res.reason.message : String(res.reason))
      return
    }

    const ids = new Set<string>()
    for (const t of res.value) {
      const id = mcpToolId(server.id, t.name)
      if (getTool(id)) continue
      ids.add(id)
      registerTool({
        id,
        name: `${server.name} · ${t.name}`,
        description: t.description || `来自 MCP 服务「${server.name}」的工具`,
        risk: 'high',
        params: { ...t.inputSchema, type: 'object' },
        run: async (args) => {
          const current = settingsStore.mcpServers().find((s) => s.id === server.id && s.enabled)
          if (!current || mcpConfigKey(current) !== configKey) {
            return { ok: false, summary: 'MCP 服务器已禁用或配置已变更，请重新刷新工具' }
          }
          try {
            const r = await mcpCallTool(server, t.name, args)
            return { ok: r.ok, summary: r.summary }
          } catch (e) {
            return { ok: false, summary: e instanceof Error ? e.message : String(e) }
          }
        }
      })
    }

    mcpOwned.set(server.id, { configKey, ids })
    log('mcp: 已注册工具', `${server.name} x${res.value.length}`)
  })
}
