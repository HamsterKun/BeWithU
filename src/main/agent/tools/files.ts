/** 文件读写工具：默认限制在 桌面/文档/下载 + 用户添加的目录，可开完全访问 */
import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { settingsStore } from '../../store/settings'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'

const MAX_READ = 20000
const MAX_WRITE = 200000

function allowedRoots(): string[] {
  const cfg = settingsStore.get().agent
  const home = app.getPath('home')
  const defs = [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads')]
  return [...defs, ...cfg.files.dirs].map((d) => resolve(d))
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realPathWithMissingTail(path: string): string {
  const abs = resolve(path)
  let cursor = abs
  const tail: string[] = []
  while (true) {
    try {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink()) throw new Error(`不允许通过符号链接访问：${cursor}`)
      if (tail.length && !stat.isDirectory()) throw new Error(`路径的上级不是目录：${cursor}`)
      return resolve(realpathSync(cursor), ...tail)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`无法解析路径：${abs}`)
    tail.unshift(basename(cursor))
    cursor = parent
  }
}

export async function resolveAgentPath(p: string, options: { allowMissing?: boolean } = {}): Promise<string> {
  const cfg = settingsStore.get().agent
  const abs = resolve(p)
  if (cfg.files.fullAccess) return abs
  const targetReal = realPathWithMissingTail(abs)
  const inAllowedDir = allowedRoots().some((root) => {
    if (!isWithin(root, abs)) return false
    try {
      const canonical = realPathWithMissingTail(root)
      if (!isWithin(canonical, targetReal)) return false
      for (let cursor = abs; relative(root, cursor) !== ''; cursor = dirname(cursor)) {
        if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) return false
      }
      return true
    } catch {
      return false
    }
  })
  if (!inAllowedDir) {
    throw new Error(
      `路径不在允许范围内：${abs}\n可以在「设置 → Agent 能力」里添加这个目录，或者开启「完全访问」。`
    )
  }
  if (!options.allowMissing && !existsSync(abs)) throw new Error(`路径不存在：${abs}`)
  return targetReal
}

export function registerFileTools(): void {
  registerTool({
    id: 'file.list',
    name: '列出目录',
    description: '列出某个目录下的文件和子目录（名称、大小、是否目录）。',
    risk: 'low',
    params: {
      type: 'object',
      properties: { dir: { type: 'string', description: '目录路径，如 C:\\Users\\me\\Desktop' } },
      required: ['dir'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      const dir = await resolveAgentPath(String(args.dir ?? ''))
      if (!existsSync(dir)) return { ok: false, summary: `目录不存在：${dir}` }
      const entries = readdirSync(dir, { withFileTypes: true }).slice(0, 200)
      const lines = entries.map((e) => {
        if (e.isDirectory()) return `[目录] ${e.name}`
        try {
          const st = statSync(join(dir, e.name))
          return `[文件] ${e.name} (${(st.size / 1024).toFixed(1)}KB)`
        } catch {
          return `[文件] ${e.name}`
        }
      })
      return {
        ok: true,
        summary: `${dir} 下共 ${entries.length} 项：\n${lines.join('\n') || '（空目录）'}`,
        data: { dir, entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })) }
      }
    }
  })

  registerTool({
    id: 'file.read',
    name: '读取文件',
    description: '读取一个文本文件的内容（最多 2 万字）。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        maxChars: { type: 'number', description: '最多读取多少字符，默认 20000' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      const file = await resolveAgentPath(String(args.path ?? ''))
      if (!existsSync(file)) return { ok: false, summary: `文件不存在：${file}` }
      const max = Math.min(MAX_READ, Math.max(200, Number(args.maxChars) || MAX_READ))
      const text = readFileSync(file, 'utf8').slice(0, max)
      return {
        ok: true,
        summary: `已读取 ${basename(file)}（${text.length} 字）：\n${text}`,
        data: { path: file, text }
      }
    }
  })

  registerTool({
    id: 'file.write',
    name: '写入文件',
    description: '把文本写入文件（覆盖或追加）。已存在时自动备份为 .bak。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '要写入的文本' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: '默认 overwrite' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      const file = await resolveAgentPath(String(args.path ?? ''), { allowMissing: true })
      const content = String(args.content ?? '')
      if (content.length > MAX_WRITE) return { ok: false, summary: `内容太长（上限 ${MAX_WRITE} 字）` }
      const mode = args.mode === 'append' ? 'append' : 'overwrite'
      mkdirSync(resolve(file, '..'), { recursive: true })
      await resolveAgentPath(resolve(file, '..'))
      let backup = ''
      if (existsSync(file) && mode === 'overwrite') {
        await resolveAgentPath(file)
        backup = `${file}.bak`
        await resolveAgentPath(backup, { allowMissing: true })
        copyFileSync(file, backup)
      }
      writeFileSync(file, content, { encoding: 'utf8', flag: mode === 'append' ? 'a' : 'w' })
      return {
        ok: true,
        summary: `已${mode === 'append' ? '追加' : '写入'} ${basename(file)}（${content.length} 字）${backup ? `，原文件备份为 ${basename(backup)}` : ''}`,
        data: { path: file, backup }
      }
    }
  })
}
