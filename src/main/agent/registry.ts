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

export function listTools(): ToolDef[] {
  return [...registry.values()]
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
      function: { name: t.id, description: t.description, parameters: t.params }
    }))
}
