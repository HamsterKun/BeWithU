import { app, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from '../logger'
import { encodeSecureJson, readSecureJson } from '../store/secure-json'

interface Reminder {
  id: string
  dueAt: number
  text: string
}

export async function showNotification(title: string, body: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!Notification.isSupported()) throw new Error('当前系统不支持桌面通知')
  const notification = new Notification({ title, body })
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      notification.off('show', shown)
      notification.off('failed', failed)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const shown = (): void => finish()
    const failed = (_event: Electron.Event, error: string): void => finish(new Error(`通知发送失败：${error}`))
    const cancel = (): void => {
      finish(signal?.reason)
      notification.close()
    }
    const timeout = setTimeout(() => finish(new Error('系统没有确认通知是否发送成功')), 4000)
    signal?.addEventListener('abort', cancel, { once: true })
    notification.once('show', shown)
    notification.once('failed', failed)
    try {
      notification.show()
    } catch (error) {
      finish(error)
    }
  })
}

export class ReminderStore {
  private readonly file: string
  private readonly records = new Map<string, Reminder>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly sending = new Map<string, AbortController>()

  constructor(file: string) {
    this.file = file
    const data = readSecureJson(file)
    if (!Array.isArray(data)) return
    for (const reminder of data) {
      if (typeof reminder?.id !== 'string' || !Number.isFinite(reminder.dueAt) || typeof reminder.text !== 'string') continue
      this.records.set(reminder.id, reminder)
    }
    for (const reminder of this.records.values()) this.schedule(reminder)
  }

  private save(records: Reminder[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, encodeSecureJson(records), { encoding: 'utf8', flag: 'wx' })
      renameSync(temp, this.file)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  list(): Reminder[] {
    return [...this.records.values()].sort((a, b) => a.dueAt - b.dueAt)
  }

  add(minutes: number, text: string): Reminder {
    const reminder = { id: randomUUID(), dueAt: Date.now() + minutes * 60000, text }
    this.save([...this.records.values(), reminder])
    this.records.set(reminder.id, reminder)
    this.schedule(reminder)
    return reminder
  }

  cancel(id: string): boolean {
    if (!this.records.has(id)) return false
    this.save(this.list().filter((item) => item.id !== id))
    this.records.delete(id)
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.sending.get(id)?.abort()
    return true
  }

  private schedule(reminder: Reminder, delay = reminder.dueAt - Date.now()): void {
    const timer = setTimeout(() => void this.deliver(reminder), Math.max(0, Math.min(delay, 0x7fffffff)))
    timer.unref()
    this.timers.set(reminder.id, timer)
  }

  private async deliver(reminder: Reminder): Promise<void> {
    this.timers.delete(reminder.id)
    if (!this.records.has(reminder.id)) return
    if (reminder.dueAt > Date.now()) {
      this.schedule(reminder)
      return
    }
    const controller = new AbortController()
    this.sending.set(reminder.id, controller)
    try {
      await showNotification('提醒', reminder.text, controller.signal)
      if (this.records.has(reminder.id)) {
        this.sending.delete(reminder.id)
        this.cancel(reminder.id)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      log('agent: 提醒投递失败，稍后重试', error instanceof Error ? error.message : String(error))
      this.schedule(reminder, 5 * 60000)
    } finally {
      this.sending.delete(reminder.id)
    }
  }
}

let store: ReminderStore | undefined

export function reminders(): ReminderStore {
  return store ??= new ReminderStore(join(app.getPath('userData'), 'agent', 'reminders.json'))
}
