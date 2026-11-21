/**
 * 上下文状态：压缩后的摘要 + 归档游标 + 统计。
 *
 * 关键设计：压缩**不删除**本地对话记录，只把 `archivedUpTo` 往前推。
 * 这样「清空上下文」仍然是唯一的销毁入口，压缩可以回退，气泡里的历史也不会莫名消失。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'
import { encodeSecureJson, readSecureJson } from './secure-json'

export interface ContextStats {
  /** 累计压缩次数 */
  compressions: number
  /** 最近一次压缩前后的估算 token */
  lastBefore: number
  lastAfter: number
}

interface ContextState {
  summary: string
  updatedAt: number
  /** 首条尚未归档消息的绝对位置，历史滚动时保持不变。 */
  archivedUpTo: number
  stats: ContextStats
}

const EMPTY: ContextState = {
  summary: '',
  updatedAt: 0,
  archivedUpTo: 0,
  stats: { compressions: 0, lastBefore: 0, lastAfter: 0 }
}

class ContextStore {
  private state: ContextState = { ...EMPTY, stats: { ...EMPTY.stats } }
  private loaded = false

  private get file(): string {
    return join(app.getPath('userData'), 'context.json')
  }

  /** 旧版本的文件名：只读一次，读完由下一次保存写成 context.json */
  private get legacyFile(): string {
    return join(app.getPath('userData'), 'memory.json')
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = existsSync(this.file)
        ? readSecureJson(this.file)
        : existsSync(this.legacyFile)
          ? readSecureJson(this.legacyFile)
          : null
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>
        const stats = (obj.stats ?? {}) as Record<string, unknown>
        this.state = {
          summary: typeof obj.summary === 'string' ? obj.summary : '',
          updatedAt: Number(obj.updatedAt) || 0,
          archivedUpTo: Math.max(0, Math.floor(Number(obj.archivedUpTo) || 0)),
          stats: {
            compressions: Math.max(0, Math.floor(Number(stats.compressions) || 0)),
            lastBefore: Math.max(0, Math.floor(Number(stats.lastBefore) || 0)),
            lastAfter: Math.max(0, Math.floor(Number(stats.lastAfter) || 0))
          }
        }
      }
    } catch (e) {
      log('context: 读取失败', e)
    }
  }

  getSummary(): string {
    this.load()
    return this.state.summary
  }

  updatedAt(): number {
    this.load()
    return this.state.updatedAt
  }

  archivedUpTo(): number {
    this.load()
    return this.state.archivedUpTo
  }

  stats(): ContextStats {
    this.load()
    return { ...this.state.stats }
  }

  /**
   * 写入新摘要并推进游标。
   * `archivedUpTo` 由调用方按"已归档到第几条"给出，只允许前进。
   */
  setSummary(input: { summary: string; archivedUpTo: number; before: number; after: number }): void {
    this.load()
    this.state = {
      summary: input.summary.trim(),
      updatedAt: Date.now(),
      archivedUpTo: Math.max(this.state.archivedUpTo, Math.max(0, Math.floor(input.archivedUpTo))),
      stats: {
        compressions: this.state.stats.compressions + 1,
        lastBefore: Math.max(0, Math.floor(input.before) || 0),
        lastAfter: Math.max(0, Math.floor(input.after) || 0)
      }
    }
    this.save()
  }

  /** 历史被清空或恢复旧备份时，防止游标越过当前历史末尾。 */
  clampArchived(historyEnd: number): void {
    this.load()
    const max = Math.max(0, Math.floor(historyEnd) || 0)
    if (this.state.archivedUpTo > max) {
      this.state.archivedUpTo = max
      this.save()
    }
  }

  clear(): void {
    this.load()
    this.state = { ...EMPTY, stats: { ...EMPTY.stats } }
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, encodeSecureJson(this.state), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      log('context: 保存失败', e)
    }
  }
}

export const contextStore = new ContextStore()
