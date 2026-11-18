/** 应用启动 / 系统通知 / 定时提醒 / 打开网页 */
import { Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'
import { log } from '../../logger'

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

function toast(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch (e) {
    log('agent: 通知失败', e)
  }
}

export function registerSystemTools(): void {
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
    async run(args): Promise<ToolResult> {
      const raw = String(args.name ?? '').trim()
      if (!raw) return { ok: false, summary: '没有指定要打开的应用' }
      const exe = APP_MAP[raw] ?? raw
      try {
        if (existsSync(exe)) {
          spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
        } else if (!exe.includes('\\') && !exe.includes('/')) {
          spawn(exe, [], { detached: true, stdio: 'ignore', shell: true }).unref()
        } else {
          return { ok: false, summary: `找不到程序：${exe}` }
        }
        return { ok: true, summary: `已启动 ${raw}` }
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
    async run(args): Promise<ToolResult> {
      toast(String(args.title ?? 'BeWithU'), String(args.body ?? ''))
      return { ok: true, summary: `已弹出通知：${String(args.title ?? '')}` }
    }
  })

  registerTool({
    id: 'remind',
    name: '定时提醒',
    description: 'N 分钟后弹通知提醒用户。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: '多少分钟后提醒' },
        text: { type: 'string', description: '提醒内容' }
      },
      required: ['minutes', 'text'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      const minutes = Math.max(1, Math.min(24 * 60, Math.round(Number(args.minutes) || 1)))
      const text = String(args.text ?? '').trim() || '时间到了'
      setTimeout(() => toast('提醒', text), minutes * 60 * 1000)
      return { ok: true, summary: `已设置 ${minutes} 分钟后的提醒：${text}` }
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
    async run(args): Promise<ToolResult> {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, summary: '只支持 http(s) 链接' }
      await shell.openExternal(url)
      return { ok: true, summary: `已在浏览器打开 ${url}` }
    }
  })
}
