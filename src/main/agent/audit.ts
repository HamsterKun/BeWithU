/** Agent 审计日志：按天写 JSONL，保留 7 天 */
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
  summary: string
  argsPreview?: string
}

const RETENTION_DAYS = 7

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

export function recordAudit(entry: AuditEntry): void {
  if (!settingsStore.get().agent.audit) return
  try {
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
