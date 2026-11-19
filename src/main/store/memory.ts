import { app } from 'electron'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'
import { encodeSecureJson, readSecureJson } from './secure-json'

interface MemoryState {
  summary: string
  updatedAt: number
}

/** 长期记忆：多轮对话被压缩成的摘要，单独存盘 */
class MemoryStore {
  private state: MemoryState = { summary: '', updatedAt: 0 }
  private loaded = false

  private get file(): string {
    return join(app.getPath('userData'), 'memory.json')
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(this.file)) {
        const raw = readSecureJson(this.file)
        if (raw && typeof raw === 'object') {
          const obj = raw as Record<string, unknown>
          this.state = {
            summary: typeof obj.summary === 'string' ? obj.summary : '',
            updatedAt: Number(obj.updatedAt) || 0
          }
        }
      }
    } catch (e) {
      log('memory: 读取失败', e)
    }
  }

  get(): string {
    this.load()
    return this.state.summary
  }

  updatedAt(): number {
    this.load()
    return this.state.updatedAt
  }

  set(summary: string): void {
    this.load()
    this.state = { summary: summary.trim(), updatedAt: Date.now() }
    this.save()
  }

  clear(): void {
    this.load()
    this.state = { summary: '', updatedAt: 0 }
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, encodeSecureJson(this.state), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      log('memory: 保存失败', e)
    }
  }
}

export const memoryStore = new MemoryStore()
