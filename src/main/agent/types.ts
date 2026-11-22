/** Agent 工具系统的公共类型 */

export type ToolRisk = 'low' | 'high'

export interface ToolContext {
  /** 本次调用的唯一 id，审计日志用它串起来 */
  callId: string
  /** 用户打断 / 任务取消时会被 abort */
  signal: AbortSignal
  log: (message: string) => void
}

export interface ToolResult {
  ok: boolean
  /** 回给模型的一句话结论（会被播报/显示，尽量短） */
  summary: string
  /** 供工具调用方使用的结构化附加数据 */
  data?: unknown
  /** 截屏工具返回给视觉模型的画面 */
  screenshot?: { dataUrl: string }
  /** 外部工具返回的图像 */
  images?: { dataUrl: string }[]
}

export type JsonSchema = Record<string, unknown>

export interface ToolDef {
  id: string
  name: string
  description: string
  /** low = 静默执行；high = 需要用户确认 */
  risk: ToolRisk
  /** OpenAI function calling 的 parameters */
  params: JsonSchema
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}
