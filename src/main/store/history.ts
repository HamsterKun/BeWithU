import { app } from 'electron'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryMessage } from '../../shared/types'
import { log } from '../logger'
import { encodeSecureJson, readSecureJson } from './secure-json'

const MAX_MESSAGES = 200

class HistoryStore {
  private messages: HistoryMessage[] = []
  private firstIndex = 0
  private loaded = false

  private get file(): string {
    return join(app.getPath('userData'), 'history.json')
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(this.file)) {
        const raw = readSecureJson(this.file)
        const stored = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? raw as { firstIndex?: unknown; messages?: unknown }
          : undefined
        const messages = stored?.messages ?? raw
        if (Array.isArray(messages)) {
          this.messages = messages.filter((m): m is HistoryMessage => Boolean(m) && typeof (m as HistoryMessage).content === 'string')
          const first = stored?.firstIndex
          if (typeof first === 'number' && Number.isSafeInteger(first) && first >= 0) this.firstIndex = first
          // 已满的旧数组无法确定摘要游标对应哪条消息，保留的消息重新进入上下文，避免静默跳过。
          else if (!stored && this.messages.length >= MAX_MESSAGES) this.firstIndex = MAX_MESSAGES
          this.trim(Math.max(0, this.messages.length - MAX_MESSAGES))
        }
      }
    } catch (e) {
      log('history: 读取失败', e)
    }
  }

  add(role: 'user' | 'assistant', content: string): void {
    this.load()
    const text = content.trim()
    if (!text) return
    this.messages.push({ role, content: text, at: Date.now() })
    this.trim(Math.max(0, this.messages.length - MAX_MESSAGES))
    this.save()
  }

  /** 最近 n 轮（用户+助手 = 2n 条） */
  recent(turns: number): HistoryMessage[] {
    this.load()
    const n = Math.max(0, Math.floor(turns)) * 2
    return n === 0 ? [] : this.messages.slice(-n)
  }

  /** 绝对位置 from 起的保留消息，归档游标可跨过多次滚动。 */
  since(from: number): HistoryMessage[] {
    this.load()
    const start = Math.max(0, (Math.floor(from) || 0) - this.firstIndex)
    return this.messages.slice(start)
  }

  at(index: number): number {
    this.load()
    const item = this.messages[Math.floor(index) - this.firstIndex]
    return item ? item.at : 0
  }

  all(): HistoryMessage[] {
    this.load()
    return this.messages.slice()
  }

  count(): number {
    this.load()
    return this.messages.length
  }

  startIndex(): number {
    this.load()
    return this.firstIndex
  }

  endIndex(): number {
    this.load()
    return this.firstIndex + this.messages.length
  }

  private trim(n: number): void {
    const dropped = Math.min(Math.floor(n) || 0, this.messages.length)
    if (dropped <= 0) return
    this.messages = this.messages.slice(dropped)
    this.firstIndex += dropped
  }

  /** 摘要完成后丢弃已归档的前 n 条（保留总结期间新产生的消息） */
  drop(n: number): void {
    this.load()
    if (n <= 0) return
    this.trim(n)
    this.save()
  }

  clear(): void {
    this.load()
    this.messages = []
    this.firstIndex = 0
    this.save()
  }

  private save(): void {
    try {
      const dir = app.getPath('userData')
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, encodeSecureJson({ firstIndex: this.firstIndex, messages: this.messages }), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      log('history: 保存失败', e)
    }
  }
}

export const historyStore = new HistoryStore()
