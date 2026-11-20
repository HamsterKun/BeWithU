/**
 * 模型元信息缓存：供应商在 `/v1/models` 里可能直接给上下文长度，
 * 这比内置表准（表会过期）。拿不到就返回 0，交给 model-window 的内置表兜底。
 *
 * 只在主进程缓存，10 分钟过期；换模型/换服务商时强制刷新一次。
 */
import type { LlmSettings } from '../../shared/types'
import { log } from '../logger'
import { listModelInfo } from './llm'

const TTL_MS = 10 * 60 * 1000

let cache: { key: string; windows: Record<string, number>; at: number } = {
  key: '',
  windows: {},
  at: 0
}

/** 只认 baseUrl + 模型名，不把 apiKey 拼进 key（避免密钥被写进内存日志） */
function cacheKey(llm: LlmSettings): string {
  return `${llm.baseUrl.trim()}@@${llm.model.trim()}`
}

/** 查某个模型的上下文字段，查不到返回 0 */
export function providerWindow(model: string): number {
  const name = String(model ?? '').trim()
  if (!name) return 0
  const n = cache.windows[name]
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function cachedAt(): number {
  return cache.at
}

/**
 * 拉一次模型列表。失败只写日志，不打扰用户 —— 这个信息是"锦上添花"，
 * 拿不到就用内置表，不影响任何功能。
 */
export async function refreshModelInfo(llm: LlmSettings, force = false): Promise<void> {
  if (!llm.baseUrl.trim()) return
  // 没填 Key 又不是本地服务，必然 401：不用去打一次，也别在日志里刷红
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(llm.baseUrl)
  if (!llm.apiKey.trim() && !local) return
  const key = cacheKey(llm)
  if (!force && cache.key === key && Date.now() - cache.at < TTL_MS) return
  try {
    const list = await listModelInfo(llm)
    const windows: Record<string, number> = {}
    for (const item of list) if (item.window > 0) windows[item.id] = item.window
    cache = { key, windows, at: Date.now() }
    const count = Object.keys(windows).length
    log('model-info: 已刷新', count ? `${count} 个模型带上下文长度` : '供应商没有提供上下文长度')
  } catch (e) {
    log('model-info: 获取失败', e instanceof Error ? e.message : e)
  }
}
