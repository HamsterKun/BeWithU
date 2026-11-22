/** 工具注册表：内置工具 + （后续）用户导入的工具都注册到这里 */
import { createHash } from 'node:crypto'
import type { ToolDef } from './types'

const registry = new Map<string, ToolDef>()

export function registerTool(def: ToolDef): void {
  if (registry.has(def.id)) throw new Error(`工具 id 重复：${def.id}`)
  registry.set(def.id, def)
}

export function getTool(id: string): ToolDef | undefined {
  return registry.get(id)
}

export function unregisterTool(id: string): void {
  registry.delete(id)
}

export function listTools(): ToolDef[] {
  return [...registry.values()]
}

/**
 * OpenAI / DeepSeek 等服务的函数名只允许 [a-zA-Z0-9_-]，
 * 我们内部 id 用点分层（input.type），发给模型前必须换成下划线。
 * 反向映射用 wireToReal()。
 */
export function wireToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** wire 名 → 内部 id（给工具调用结果用） */
export function buildWireMap(ids: string[]): Map<string, string> {
  const reserved = new Set(ids.map(wireToolName))
  const map = new Map<string, string>()
  for (const id of ids) {
    const base = wireToolName(id) || 'tool'
    let wire = base
    if (wire.length > 64 || map.has(wire)) {
      let attempt = 0
      do {
        const suffix = createHash('sha256').update(`${id}:${attempt++}`).digest('hex').slice(0, 12)
        wire = `${base.slice(0, 51)}_${suffix}`
      } while (reserved.has(wire) || map.has(wire))
    }
    map.set(wire, id)
  }
  return map
}

/** 转成 OpenAI function calling 的 tools 数组 */
export function toOpenAiTools(onlyIds?: string[]): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  const ids = onlyIds ?? listTools().map((tool) => tool.id)
  return Array.from(buildWireMap(ids)).flatMap(([name, id]) => {
    const tool = getTool(id)
    return tool ? [{
      type: 'function' as const,
      function: { name, description: tool.description, parameters: tool.params }
    }] : []
  })
}
