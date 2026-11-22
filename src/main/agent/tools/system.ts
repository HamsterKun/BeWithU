/** 应用启动 / 系统通知 / 定时提醒 / 打开网页 */
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'
import { reminders, showNotification } from '../reminders'
import { formatStamp } from '../../services/context'

const APP_MAP: Record<string, string> = {
  记事本: 'notepad.exe',
  notepad: 'notepad.exe',
  计算器: 'calc.exe',
  calc: 'calc.exe',
  画图: 'mspaint.exe',
  mspaint: 'mspaint.exe',
  资源管理器: 'explorer.exe',
  explorer: 'explorer.exe',
  任务管理器: 'taskmgr.exe',
  taskmgr: 'taskmgr.exe',
  控制面板: 'control.exe',
  写字板: 'write.exe'
}

async function launch(exe: string, signal: AbortSignal): Promise<number | undefined> {
  signal.throwIfAborted()
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      child.kill()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('spawn', () => {
      signal.removeEventListener('abort', abort)
      child.unref()
      resolve(child.pid)
    })
  })
}

export function registerSystemTools(): void {
  reminders()
  registerTool({
    id: 'app.launch',
    name: '打开应用',
    description: '启动一个程序。常用：记事本 / 计算器 / 画图 / 资源管理器 / 任务管理器，或传完整 exe 路径。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '应用名或 exe 路径' }
      },
      required: ['name'],
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      const raw = String(args.name ?? '').trim()
      if (!raw) return { ok: false, summary: '没有指定要打开的应用' }
      const exe = Object.hasOwn(APP_MAP, raw.toLowerCase()) ? APP_MAP[raw.toLowerCase()] : raw
      try {
        const pid = await launch(exe, ctx.signal)
        return { ok: true, summary: `已启动 ${raw} 的进程`, data: { pid } }
      } catch (e) {
        return { ok: false, summary: `启动失败：${e instanceof Error ? e.message : String(e)}` }
      }
    }
  })

  registerTool({
    id: 'notify',
    name: '系统通知',
    description: '弹一条桌面通知（用于提醒用户）。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['title'],
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      const title = String(args.title ?? 'BeWithU')
      await showNotification(title, String(args.body ?? ''), ctx.signal)
      return { ok: true, summary: `系统已接收通知：${title}` }
    }
  })

  registerTool({
    id: 'remind',
    name: '定时提醒',
    description: '设置、列出或取消定时提醒。默认 schedule，应用关闭后到期的提醒会在下次启动补发。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['schedule', 'list', 'cancel'], description: '默认 schedule' },
        id: { type: 'string', description: 'cancel 要取消的提醒 ID' },
        minutes: { type: 'number', description: '多少分钟后提醒' },
        text: { type: 'string', description: '提醒内容' }
      },
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      ctx.signal.throwIfAborted()
      const store = reminders()
      const action = args.action ?? 'schedule'
      if (action === 'list') {
        const records = store.list().map((item) => ({ ...item, dueLocal: formatStamp(item.dueAt) }))
        return { ok: true, summary: `有 ${records.length} 条待发送提醒`, data: { reminders: records } }
      }
      if (action === 'cancel') {
        const id = String(args.id ?? '')
        return store.cancel(id)
          ? { ok: true, summary: '已取消提醒', data: { id } }
          : { ok: false, summary: '找不到此待发送提醒，请先列出提醒并核对 id' }
      }
      if (action !== 'schedule' || !Number.isFinite(args.minutes)) {
        return { ok: false, summary: '请提供有效的操作和提醒分钟数' }
      }
      const minutes = Math.max(1, Math.min(24 * 60, Math.round(Number(args.minutes))))
      const text = String(args.text ?? '').trim() || '时间到了'
      const reminder = store.add(minutes, text)
      return { ok: true, summary: `已设置 ${minutes} 分钟后的提醒：${text}`, data: reminder }
    }
  })

  registerTool({
    id: 'web.open',
    name: '打开网页',
    description: '用默认浏览器打开一个网址（仅 http/https）。',
    risk: 'low',
    params: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, summary: '只支持 http(s) 链接' }
      ctx.signal.throwIfAborted()
      await shell.openExternal(url)
      return { ok: true, summary: `已在浏览器打开 ${url}` }
    }
  })
}
