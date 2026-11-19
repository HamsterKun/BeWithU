import { app } from 'electron'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryMessage } from '../../shared/types'
import { log } from '../logger'
import { encodeSecureJson, readSecureJson } from './secure-json'

const MAX_MESSAGES = 200

class HistoryStore {
  private messages: HistoryMessage[] = []
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
        if (Array.isArray(raw)) {
          this.messages = raw
            .filter((m): m is HistoryMessage => Boolean(m) && typeof (m as HistoryMessage).content === 'string')
            .slice(-MAX_MESSAGES)
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
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES)
    this.save()
  }

  /** 最近 n 轮（用户+助手 = 2n 条） */
  recent(turns: number): HistoryMessage[] {
    this.load()
    const n = Math.max(0, Math.floor(turns)) * 2
    return n === 0 ? [] : this.messages.slice(-n)
  }

  all(): HistoryMessage[] {
    this.load()
    return this.messages.slice()
  }

  count(): number {
    this.load()
    return this.messages.length
  }

  /** 摘要完成后丢弃已归档的前 n 条（保留总结期间新产生的消息） */
  drop(n: number): void {
    this.load()
    if (n <= 0) return
    this.messages = this.messages.slice(n)
    this.save()
  }

  clear(): void {
    this.messages = []
    this.save()
  }

  private save(): void {
    try {
      const dir = app.getPath('userData')
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, encodeSecureJson(this.messages), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      log('history: 保存失败', e)
    }
  }
}

export const historyStore = new HistoryStore()
