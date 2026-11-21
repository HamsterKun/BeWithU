import { setTimeout as sleep } from 'node:timers/promises'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'

export const DELAY_TOOL_ID = 'delay'
// Node 的定时器超过这个值会退回到 1ms，必须在执行前拒绝。
const MAX_DELAY_MS = 2_147_483_647
const MAX_DELAY_SECONDS = MAX_DELAY_MS / 1000

export function validDelaySeconds(value: unknown): value is number {
  return typeof value === 'number' && value >= 0.001 && value <= MAX_DELAY_SECONDS
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseDelayFollowUp(value: unknown): { name: string; arguments: Record<string, unknown> } | null {
  if (!isObject(value) || typeof value.name !== 'string' || !isObject(value.arguments)) return null
  return { name: value.name, arguments: value.arguments }
}

export function registerDelayTool(): void {
  registerTool({
    id: DELAY_TOOL_ID,
    name: '延时等待',
    description: '阻塞当前 Agent 任务，等待指定秒数。如果要在等待结束后立即执行另一个工具，在 then 中提供本轮已开放的工具名和参数。后续工具仍需按原规则确认。适用于当前任务内等待，取消任务会取消等待。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        seconds: { type: 'number', minimum: 0.001, maximum: MAX_DELAY_SECONDS, description: '等待秒数，支持小数' },
        then: {
          type: 'object',
          description: '可选。等待结束后立即发起的工具调用，无需再询问模型',
          properties: {
            name: { type: 'string', description: '工具列表中公布的函数名，例如 file_read；不能是 delay' },
            arguments: { type: 'object', description: '按目标工具的参数定义传入，无参数时传 {}' }
          },
          required: ['name', 'arguments'],
          additionalProperties: false
        }
      },
      required: ['seconds'],
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      const seconds = args.seconds
      if (!validDelaySeconds(seconds)) return { ok: false, summary: `等待秒数必须在 0.001 到 ${MAX_DELAY_SECONDS} 之间` }
      try {
        await sleep(Math.min(MAX_DELAY_MS, Math.ceil(seconds * 1000)), undefined, { signal: ctx.signal })
      } catch (error) {
        if (ctx.signal.aborted) return { ok: false, summary: '等待已取消' }
        throw error
      }
      return { ok: true, summary: `已等待 ${seconds} 秒` }
    }
  })
}
