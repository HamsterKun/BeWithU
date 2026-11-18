/** 工具注册表：内置工具 + （后续）用户导入的工具都注册到这里 */
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
  const map = new Map<string, string>()
  for (const id of ids) {
    const wire = wireToolName(id)
    const prev = map.get(wire)
    if (prev && prev !== id) {
      // 撞名（a.b 与 a_b）：先注册的优先，另一个模型永远调不到——记日志方便排查
      console.warn(`[agent] 工具名转换冲突：${prev} / ${id} → ${wire}`)
      continue
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
  return listTools()
    .filter((t) => !onlyIds || onlyIds.includes(t.id))
    .map((t) => ({
      type: 'function' as const,
      function: { name: wireToolName(t.id), description: t.description, parameters: t.params }
    }))
}
