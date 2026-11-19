/** 文件读写工具：默认限制在 桌面/文档/下载 + 用户添加的目录，可开完全访问 */
import { app } from 'electron'
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { open, opendir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { settingsStore } from '../../store/settings'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'

const MAX_READ = 20000
const MAX_WRITE = 200000
const DIR_PAGE = 200
const DIR_PAGE_MAX = 500
/** 单个文件/目录操作的时间预算：大文件、慢盘不能把主进程钉死 */
const IO_BUDGET_MS = 8000

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

/**
 * 只读文件开头的一段文本：按字节设上限，并给自己一个时间预算，
 * 这样读大文件不会把 Electron 主进程卡住（REVIEW A8）。
 */
export async function readTextPrefix(
  file: string,
  maxChars: number,
  budgetMs = IO_BUDGET_MS
): Promise<{ text: string; truncated: boolean; size: number }> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`不是普通文件：${file}`)
    // UTF-8 一个字符最多 4 字节，多留几个字节够判断"后面还有内容"
    const maxBytes = Math.min(info.size, maxChars * 4 + 4)
    const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1024, maxBytes)))
    const parts: Buffer[] = []
    let filled = 0
    let text = ''
    const deadline = Date.now() + budgetMs
    while (filled < maxBytes) {
      if (Date.now() > deadline) throw new Error('读取超时：文件太大或磁盘太慢')
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - filled), filled)
      if (!bytesRead) break
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)))
      filled += bytesRead
      text = Buffer.concat(parts).toString('utf8')
      if (text.length > maxChars) break
    }
    const cut = text.length > maxChars
    if (cut) text = text.slice(0, maxChars)
    // 字节截断可能切在多字节字符中间，去掉尾部替换字符
    if (filled < info.size || cut) text = text.replace(/\uFFFD+$/u, '')
    return { text, truncated: filled < info.size || cut, size: info.size }
  } finally {
    await handle.close()
  }
}

/** 分页列目录：用目录迭代器，最多走 limit 条，不把整个目录读进来 */
export async function listDirPage(
  dir: string,
  offset: number,
  limit: number,
  budgetMs = IO_BUDGET_MS
): Promise<{ entries: Array<{ name: string; dir: boolean }>; more: boolean }> {
  const deadline = Date.now() + budgetMs
  const entries: Array<{ name: string; dir: boolean }> = []
  let seen = 0
  let more = false
  const handle = await opendir(dir)
  try {
    for await (const dirent of handle) {
      if (Date.now() > deadline) throw new Error('列目录超时：目录太大或磁盘太慢')
      if (seen++ < offset) continue
      if (entries.length >= limit) {
        more = true
        break
      }
      entries.push({ name: dirent.name, dir: dirent.isDirectory() })
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return { entries, more }
}

export function registerFileTools(): void {
  registerTool({
    id: 'file.list',
    name: '列出目录',
    description: '列出某个目录下的文件和子目录（名称、大小、是否目录），可用 offset/limit 翻页。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '目录路径，如 C:\\Users\\me\\Desktop' },
        offset: { type: 'number', description: '从第几项开始，默认 0' },
        limit: { type: 'number', description: '最多列多少项，默认 200，上限 500' }
      },
      required: ['dir'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      const dir = await resolveAgentPath(String(args.dir ?? ''))
      const limit = Math.min(DIR_PAGE_MAX, Math.max(1, Math.floor(Number(args.limit) || DIR_PAGE)))
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      let page: Awaited<ReturnType<typeof listDirPage>>
      try {
        page = await listDirPage(dir, offset, limit)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`目录不存在：${dir}`)
        throw e
      }
      const lines = await Promise.all(
        page.entries.map(async (e) => {
          if (e.dir) return `[目录] ${e.name}`
          try {
            const st = await stat(join(dir, e.name))
            return `[文件] ${e.name} (${(st.size / 1024).toFixed(1)}KB)`
          } catch {
            return `[文件] ${e.name}`
          }
        })
      )
      const range =
        page.entries.length === 0
          ? `从第 ${offset + 1} 项起没有更多`
          : `第 ${offset + 1}–${offset + page.entries.length} 项${page.more ? '（还有更多，可用 offset 继续翻）' : ''}`
      return {
        ok: true,
        summary: `${dir} ${range}：\n${lines.join('\n') || '（空目录）'}`,
        data: { dir, offset, limit, more: page.more, entries: page.entries }
      }
    }
  })

  registerTool({
    id: 'file.read',
    name: '读取文件',
    description: '读取一个文本文件的内容（最多 2 万字，只读开头部分，不会整文件载入内存）。',
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
      const max = Math.min(MAX_READ, Math.max(200, Number(args.maxChars) || MAX_READ))
      let prefix: Awaited<ReturnType<typeof readTextPrefix>>
      try {
        prefix = await readTextPrefix(file, max)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`文件不存在：${file}`)
        throw e
      }
      const { text, truncated, size } = prefix
      const note = truncated ? `，文件共 ${(size / 1024).toFixed(1)}KB，只读了前面部分` : ''
      return {
        ok: true,
        summary: `已读取 ${basename(file)}（${text.length} 字${note}）：\n${text}`,
        data: { path: file, text, truncated, size }
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
