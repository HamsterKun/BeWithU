/** Agent 审计日志：按天写 JSONL，保留 7 天
 *
 * 隐私口径（REVIEW B4）：默认只记元数据——工具 id、成败、耗时、参数名与体积。
 * 结果摘要与参数值可能包含文件正文、脚本或用户输入，只有打开「详细审计」才写，
 * 且写入前对密钥类字段做脱敏。
 */
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { settingsStore } from '../store/settings'
import { log } from '../logger'

export interface AuditEntry {
  at: number
  callId: string
  toolId: string
  ok: boolean
  /** 执行耗时（毫秒） */
  durationMs?: number
  /** 参数名列表：不含值，足够看出调了什么能力 */
  argsKeys?: string[]
  /** 参数字节数（JSON 序列化后） */
  argsBytes?: number
  /** 结果文本长度 */
  summaryBytes?: number
  /** 只有「详细审计」才写：结果摘要（已截断、已脱敏） */
  summary?: string
  /** 只有「详细审计」才写：参数片段（已截断、已脱敏） */
  argsPreview?: string
}

const RETENTION_DAYS = 7
const SUMMARY_MAX = 500
const ARGS_MAX = 300

const SECRET_KEY = /(key|token|secret|passw|authorization|credential|cookie)/i
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi

function dir(): string {
  return join(app.getPath('userData'), 'agent', 'runs')
}

function dayKey(ts = Date.now()): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function prune(): void {
  try {
    const root = dir()
    if (!existsSync(root)) return
    const cutoff = Date.now() - RETENTION_DAYS * 86400_000
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.jsonl')) continue
      const [y, m, d] = name.replace('.jsonl', '').split('-').map(Number)
      const ts = new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
      if (Number.isFinite(ts) && ts < cutoff) unlinkSync(join(root, name))
    }
  } catch (e) {
    log('audit: 清理失败', e)
  }
}

/** 把一段文本里像凭据的部分打码 */
export function redactText(text: string): string {
  return String(text ?? '').replace(BEARER, '$1[已隐藏]')
}

/** 值的深拷贝 + 密钥类字段打码，只在详细审计里用 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[深层结构]'
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (SECRET_KEY.test(k)) out[k] = '[已隐藏]'
      else if (typeof v === 'string' && v.length > 500) out[k] = `${v.slice(0, 500)}…(${v.length} 字)`
      else out[k] = redactValue(v, depth + 1)
    }
    return out
  }
  return value
}

function argsMeta(args: Record<string, unknown> | undefined): { keys: string[]; bytes: number } {
  if (!args) return { keys: [], bytes: 0 }
  let json = ''
  try {
    json = JSON.stringify(args) ?? ''
  } catch {
    json = ''
  }
  return { keys: Object.keys(args).slice(0, 20), bytes: json.length }
}

export interface AuditInput {
  at: number
  callId: string
  toolId: string
  ok: boolean
  durationMs?: number
  args?: Record<string, unknown>
  summary?: string
}

/** 组装一条审计记录（导出便于单测，不落盘） */
export function buildAuditEntry(input: AuditInput, detail: boolean): AuditEntry {
  const meta = argsMeta(input.args)
  const summary = input.summary ?? ''
  const entry: AuditEntry = {
    at: input.at,
    callId: input.callId,
    toolId: input.toolId,
    ok: input.ok,
    durationMs: input.durationMs,
    argsKeys: meta.keys,
    argsBytes: meta.bytes,
    summaryBytes: summary.length
  }
  if (!detail) return entry
  if (summary) entry.summary = redactText(summary).slice(0, SUMMARY_MAX)
  if (input.args) {
    try {
      entry.argsPreview = redactText(JSON.stringify(redactValue(input.args))).slice(0, ARGS_MAX)
    } catch {
      entry.argsPreview = ''
    }
  }
  return entry
}

export function recordAudit(input: AuditInput): void {
  const cfg = settingsStore.get().agent
  if (!cfg.audit) return
  try {
    const entry = buildAuditEntry(input, cfg.auditDetail === true)
    const root = dir()
    mkdirSync(root, { recursive: true })
    prune()
    appendFileSync(join(root, `${dayKey(entry.at)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (e) {
    log('audit: 写入失败', e)
  }
}

/** 最近的调用记录（新的在前） */
export function recentAudit(limit = 50): AuditEntry[] {
  try {
    const root = dir()
    if (!existsSync(root)) return []
    const files = readdirSync(root)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .slice(-RETENTION_DAYS)
    const out: AuditEntry[] = []
    for (const name of files) {
      const lines = readFileSync(join(root, name), 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          out.push(JSON.parse(line) as AuditEntry)
        } catch {
          /* 跳过坏行 */
        }
      }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit)
  } catch (e) {
    log('audit: 读取失败', e)
    return []
  }
}

export function clearAudit(): void {
  try {
    const root = dir()
    if (!existsSync(root)) return
    for (const name of readdirSync(root)) if (name.endsWith('.jsonl')) unlinkSync(join(root, name))
  } catch (e) {
    log('audit: 清空失败', e)
  }
}
