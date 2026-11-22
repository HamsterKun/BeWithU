import type { ToolResult } from './types'

function clipString(value: string, budget: number): string {
  if (JSON.stringify(value).length <= budget) return value
  let low = 0
  let high = Math.min(value.length, budget)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (JSON.stringify(value.slice(0, middle) + '…').length <= budget) low = middle
    else high = middle - 1
  }
  return value.slice(0, low).replace(/[\uD800-\uDBFF]$/u, '') + '…'
}

/** 保留 JSON 的形状，在序列化前逐项裁剪。 */
function bounded(value: unknown, budget: number, depth = 0): { value: unknown; trimmed: boolean } {
  if (typeof value === 'string') {
    const text = clipString(value, budget)
    return { value: text, trimmed: text !== value }
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return { value, trimmed: false }
  if (typeof value === 'bigint') return bounded(value.toString(), budget, depth)
  if (value instanceof Date) return bounded(value.toJSON(), budget, depth)
  if (!value || typeof value !== 'object' || depth === 6) return { value: null, trimmed: true }

  const isArray = Array.isArray(value)
  const output = Object.create(null) as Record<string, unknown>
  const values: unknown[] = []
  const entries = Object.entries(value)
  // 先保留路径、分页游标等短字段，再分配正文的空间。
  if (!isArray) {
    const weight = ([key, item]: [string, unknown]): number => {
      if (key === 'structuredContent') return 1000
      if (typeof item === 'string') return item.length
      return typeof item === 'object' ? 10000 : 0
    }
    entries.sort((a, b) => weight(a) - weight(b))
  }
  let remaining = budget - 2
  let trimmed = entries.length > 500
  for (const [key, item] of entries.slice(0, 500)) {
    if (!isArray && item === undefined) continue
    const overhead = isArray ? 1 : JSON.stringify(key).length + 2
    if (remaining - overhead < 16) {
      trimmed = true
      break
    }
    const part = bounded(item, remaining - overhead, depth + 1)
    remaining -= JSON.stringify(part.value).length + overhead
    if (isArray) values.push(part.value)
    else output[key] = part.value
    trimmed ||= part.trimmed
  }
  return { value: isArray ? values : output, trimmed }
}

export function serializeToolResult(result: ToolResult, summary = result.summary): string {
  const text = clipString(summary, result.data === undefined ? 10500 : 1600)
  const data = result.data === undefined ? undefined : bounded(result.data, 10500)
  return JSON.stringify({
    ok: result.ok,
    result: text,
    data: data?.value,
    truncated: text !== summary || data?.trimmed || undefined
  })
}
