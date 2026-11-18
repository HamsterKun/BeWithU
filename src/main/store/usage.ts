/**
 * 用量统计：按天记账，存 <userData>/usage.json
 * - chat / summary：token（输入、输出、调用次数）
 * - tts：合成字数
 * - asr：识别音频秒数（云端按时长计费）
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'
import type { DayUsage, UsageSummary } from '../../shared/types'

export type { DayUsage, UsageSummary } from '../../shared/types'

export type UsageKind = 'chat' | 'summary' | 'tts' | 'asr'

type UsageFile = Record<string, DayUsage>

function file(): string {
  return join(app.getPath('userData'), 'usage.json')
}

function emptyDay(): DayUsage {
  return {
    chat: { input: 0, output: 0, calls: 0 },
    summary: { input: 0, output: 0, calls: 0 },
    tts: { chars: 0, calls: 0 },
    asr: { seconds: 0, calls: 0 }
  }
}

let data: UsageFile | null = null
let saveTimer: NodeJS.Timeout | null = null

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function load(): UsageFile {
  if (data) return data
  try {
    const raw = existsSync(file()) ? readFileSync(file(), 'utf8') : '{}'
    data = JSON.parse(raw.replace(/^\uFEFF/, '')) as UsageFile
    if (!data || typeof data !== 'object') data = {}
  } catch {
    data = {}
  }
  return data
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(file(), JSON.stringify(load()), 'utf8')
    } catch (e) {
      log('usage: 保存失败', e)
    }
  }, 800)
}

function day(): DayUsage {
  const d = load()
  const key = today()
  if (!d[key]) d[key] = emptyDay()
  const cur = d[key]
  // 兼容旧文件缺字段
  cur.chat ??= { input: 0, output: 0, calls: 0 }
  cur.summary ??= { input: 0, output: 0, calls: 0 }
  cur.tts ??= { chars: 0, calls: 0 }
  cur.asr ??= { seconds: 0, calls: 0 }
  return cur
}

export function recordTokens(kind: 'chat' | 'summary', input: number, output: number): void {
  if (!Number.isFinite(input) && !Number.isFinite(output)) return
  const d = day()
  d[kind].input += Math.max(0, Math.round(input || 0))
  d[kind].output += Math.max(0, Math.round(output || 0))
  d[kind].calls += 1
  persist()
}

export function recordTtsChars(chars: number): void {
  const d = day()
  d.tts.chars += Math.max(0, Math.round(chars || 0))
  d.tts.calls += 1
  persist()
}

export function recordAsrSeconds(seconds: number): void {
  const d = day()
  d.asr.seconds += Math.max(0, Math.round((seconds || 0) * 10) / 10)
  d.asr.calls += 1
  persist()
}

/** 今日 + 本月累计 */
export function usageSummary(): UsageSummary {
  const d = load()
  const monthPrefix = today().slice(0, 7)
  const month = emptyDay()
  for (const [key, v] of Object.entries(d)) {
    if (!key.startsWith(monthPrefix)) continue
    month.chat.input += v.chat?.input ?? 0
    month.chat.output += v.chat?.output ?? 0
    month.chat.calls += v.chat?.calls ?? 0
    month.summary.input += v.summary?.input ?? 0
    month.summary.output += v.summary?.output ?? 0
    month.summary.calls += v.summary?.calls ?? 0
    month.tts.chars += v.tts?.chars ?? 0
    month.tts.calls += v.tts?.calls ?? 0
    month.asr.seconds += v.asr?.seconds ?? 0
    month.asr.calls += v.asr?.calls ?? 0
  }
  return { today: { ...emptyDay(), ...(d[today()] ?? emptyDay()) }, month }
}

export function clearUsage(): void {
  data = {}
  persist()
}
