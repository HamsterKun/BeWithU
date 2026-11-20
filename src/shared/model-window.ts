/**
 * 模型上下文窗口。
 *
 * `/v1/models` 只返回 id，不返回上下文长度，所以只能按名字猜。
 * 这里的数字一律取**保守值**：猜小了只是少用点容量（用户可手动指定），
 * 猜大了会直接吃 `context_length_exceeded`。表会过期，所以永远允许手动覆盖。
 */

export const DEFAULT_MODEL_WINDOW = 128000

interface WindowRule {
  re: RegExp
  window: number
}

/** 顺序有意义：先匹配的先命中（越具体的写在越前面） */
const RULES: WindowRule[] = [
  // —— DeepSeek ——
  // 内置表只是兜底：优先用供应商在 /v1/models 里给的值
  { re: /deepseek-(chat|reasoner|v3)/i, window: 128000 },
  // —— OpenAI ——
  { re: /gpt-5|gpt-4\.1|gpt-4o|o3|o4/i, window: 128000 },
  { re: /gpt-4-turbo|gpt-4-1106|gpt-4-0125/i, window: 128000 },
  { re: /gpt-3\.5|gpt-35/i, window: 16000 },
  // —— Anthropic ——
  { re: /claude/i, window: 200000 },
  // —— 火山方舟 / 豆包 ——
  { re: /doubao-seed|doubao-1\.5|doubao-pro/i, window: 256000 },
  { re: /doubao/i, window: 128000 },
  // —— 通义千问 ——
  { re: /qwen-max|qwen2\.5-max/i, window: 32000 },
  { re: /qwen/i, window: 128000 },
  // —— Kimi / Moonshot ——
  { re: /kimi-k2|moonshot-v1-128k/i, window: 128000 },
  { re: /moonshot/i, window: 128000 },
  // —— 智谱 ——
  { re: /glm-4\.6|glm-4-plus|glm-4-long/i, window: 200000 },
  { re: /glm/i, window: 128000 },
  // —— Google ——
  { re: /gemini/i, window: 1000000 },
  // —— 本地小模型 ——
  { re: /llama|mistral|qwen2|phi|gemma/i, window: 32000 }
]

/** 供应商在 /v1/models 里可能给的上下文字段，按常见程度排 */
const WINDOW_FIELDS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_input_tokens',
  'max_context_tokens',
  'context'
]

/**
 * 从一条模型记录里抠出上下文长度。字段名各家不同（OpenRouter 用 context_length、
 * 火山用 context、有些塞在 meta/limits 里），拿不到就返回 0，交给内置表兜底。
 */
export function pickProviderWindow(raw: Record<string, unknown>): number {
  const sources: Record<string, unknown>[] = [raw]
  for (const key of ['meta', 'limits', 'capabilities']) {
    const nested = raw[key]
    if (nested && typeof nested === 'object') sources.push(nested as Record<string, unknown>)
  }
  for (const src of sources) {
    for (const field of WINDOW_FIELDS) {
      const n = Number(src[field])
      // 小于 8k 的多半是别的含义（如 max_tokens 输出上限），不当上下文用
      if (Number.isFinite(n) && n >= 8000) return Math.floor(n)
    }
  }
  return 0
}

export interface ResolvedWindow {
  window: number
  /**
   * manual：用户填的；provider：/v1/models 里供应商给的；
   * table：按模型名匹配；fallback：都没匹配上
   */
  source: 'manual' | 'provider' | 'table' | 'fallback'
}

/**
 * 解析当前模型的窗口，优先级：手动 > 供应商上报 > 内置表 > 兜底 128k。
 * 供应商给的是它自己的真实上限，比内置表可信（表会过期）。
 */
export function resolveModelWindow(model: string, manual = 0, provider = 0): ResolvedWindow {
  const m = Math.floor(Number(manual) || 0)
  if (m >= 8000) return { window: m, source: 'manual' }
  const p = Math.floor(Number(provider) || 0)
  if (p >= 8000) return { window: p, source: 'provider' }
  const name = String(model ?? '').trim()
  if (name) {
    for (const rule of RULES) {
      if (rule.re.test(name)) return { window: rule.window, source: 'table' }
    }
  }
  return { window: DEFAULT_MODEL_WINDOW, source: 'fallback' }
}
