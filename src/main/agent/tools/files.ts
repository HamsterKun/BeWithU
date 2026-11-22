/** 文件读写工具：默认限制在 桌面/文档/下载 + 用户添加的目录，可开完全访问 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
  const { text, truncated, size } = await readTextPage(file, 0, maxChars, budgetMs)
  return { text, truncated, size }
}

export async function readTextPage(
  file: string, offset: number, maxChars: number, budgetMs = IO_BUDGET_MS, signal?: AbortSignal,
  jsonBudget = Infinity
): Promise<{ text: string; truncated: boolean; size: number; nextOffsetBytes: number | null }> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offsetBytes 必须是非负整数')
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`不是普通文件：${file}`)
    if (offset > info.size) throw new Error(`读取偏移超过文件末尾（${info.size} 字节）`)
    const bytes = Buffer.alloc(Math.min(info.size - offset, maxChars * 4 + 4))
    let filled = 0
    const deadline = Date.now() + budgetMs
    while (filled < bytes.length) {
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw new Error('读取超时：文件太大或磁盘太慢')
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, offset + filled)
      if (!bytesRead) break
      filled += bytesRead
    }
    signal?.throwIfAborted()
    if (filled !== bytes.length) throw new Error('文件在读取中发生变化，请重新读取')
    let decoded: string
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      decoded = decoder.decode(bytes, { stream: offset + filled < info.size })
    } catch {
      throw new Error('无法读取 UTF-8 文本，请使用上一页返回的 nextOffsetBytes')
    }
    let escaped = 0
    let end = 0
    for (const char of decoded) {
      escaped += JSON.stringify(char).length - 2
      if (end + char.length > maxChars || escaped > jsonBudget) break
      end += char.length
    }
    const text = decoded.slice(0, end)
    const next = offset + Buffer.byteLength(text)
    const truncated = next < info.size
    return { text, truncated, size: info.size, nextOffsetBytes: truncated ? next : null }
  } finally {
    await handle.close()
  }
}

/** 分页列目录：用目录迭代器，最多走 limit 条，不把整个目录读进来 */
export async function listDirPage(
  dir: string,
  offset: number,
  limit: number,
  budgetMs = IO_BUDGET_MS,
  signal?: AbortSignal
): Promise<{ entries: Array<{ name: string; dir: boolean }>; more: boolean }> {
  const deadline = Date.now() + budgetMs
  const entries: Array<{ name: string; dir: boolean }> = []
  let seen = 0
  let more = false
  const handle = await opendir(dir)
  try {
    for await (const dirent of handle) {
      signal?.throwIfAborted()
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
    async run(args, ctx): Promise<ToolResult> {
      const dir = await resolveAgentPath(String(args.dir ?? ''))
      const limit = Math.min(DIR_PAGE_MAX, Math.max(1, Math.floor(Number(args.limit) || DIR_PAGE)))
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      let page: Awaited<ReturnType<typeof listDirPage>>
      try {
        page = await listDirPage(dir, offset, limit, IO_BUDGET_MS, ctx?.signal)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`目录不存在：${dir}`)
        throw e
      }
      let bytes = 100 + JSON.stringify(dir).length
      const entries: Array<(typeof page.entries)[number] & { size?: number }> = []
      for (const entry of page.entries) {
        ctx?.signal.throwIfAborted()
        const info = entry.dir ? undefined : await stat(join(dir, entry.name)).catch(() => undefined)
        const item = { ...entry, size: info?.size }
        bytes += JSON.stringify(item).length + 1
        if (bytes > 9500 && entries.length) break
        entries.push(item)
      }
      ctx?.signal.throwIfAborted()
      const more = page.more || entries.length < page.entries.length
      const nextOffset = more ? offset + entries.length : null
      const range =
        entries.length === 0
          ? `从第 ${offset + 1} 项起没有更多`
          : `第 ${offset + 1}–${offset + entries.length} 项${more ? '（还有更多，请将 nextOffset 传给 offset）' : ''}`
      return {
        ok: true,
        summary: `${dir} ${range}`,
        data: { dir, offset, limit, more, nextOffset, entries }
      }
    }
  })

  registerTool({
    id: 'file.read',
    name: '读取文件',
    description: '分页读取 UTF-8 文本。默认从头开始，若有 nextOffsetBytes，将它传给 offsetBytes 读下一页。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        maxChars: { type: 'number', description: '每页字符上限，默认 20000；结果过大时自动缩短本页' },
        offsetBytes: { type: 'integer', description: '从指定字节开始，使用上一页的 nextOffsetBytes，默认 0' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      const file = await resolveAgentPath(String(args.path ?? ''))
      const max = Math.min(MAX_READ, Math.max(2, Math.floor(Number(args.maxChars) || MAX_READ)))
      const offset = Number(args.offsetBytes ?? 0)
      let page: Awaited<ReturnType<typeof readTextPage>>
      try {
        page = await readTextPage(file, offset, max, IO_BUDGET_MS, ctx?.signal, Math.max(32, 10000 - JSON.stringify(file).length))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`文件不存在：${file}`)
        throw e
      }
      const { text, truncated } = page
      const note = truncated ? '，当前页之后还有内容，可用 nextOffsetBytes 继续读' : ''
      return {
        ok: true,
        summary: `已读取 ${basename(file)}（${text.length} 字${note}）`,
        data: { path: file, offsetBytes: offset, ...page }
      }
    }
  })

  registerTool({
    id: 'file.write',
    name: '写入文件',
    description: '覆盖或追加 UTF-8 文本，也可用 replace 精确替换唯一出现的 oldText。覆盖和替换已有文件前保留 .bak。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '要写入的文本' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'replace'], description: '默认 overwrite' },
        oldText: { type: 'string', description: 'replace 必填，要替换的完整原文，须恰好出现一次' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      if (typeof args.path !== 'string' || !args.path.trim() || typeof args.content !== 'string') {
        return { ok: false, summary: '需要提供文件路径和文本 content' }
      }
      const file = await resolveAgentPath(String(args.path ?? ''), { allowMissing: true })
      const content = args.content
      if (content.length > MAX_WRITE) return { ok: false, summary: `内容太长（上限 ${MAX_WRITE} 字）` }
      const mode = args.mode ?? 'overwrite'
      if (mode !== 'overwrite' && mode !== 'append' && mode !== 'replace') {
        return { ok: false, summary: '不支持的写入模式' }
      }
      const parent = dirname(file)
      await resolveAgentPath(parent, { allowMissing: true })
      const backup = mode === 'append' ? '' : await resolveAgentPath(`${file}.bak`, { allowMissing: true })
      ctx?.signal.throwIfAborted()
      const exists = existsSync(file)
      let output = content
      if (mode === 'replace') {
        const old = args.oldText
        if (!exists || typeof old !== 'string' || !old) {
          return { ok: false, summary: 'replace 需要已有文件及非空的 oldText' }
        }
        if ((await stat(file)).size > 4 * 1024 * 1024) return { ok: false, summary: '精确替换支持 4 MiB 以内的文本文件' }
        // 从最后一次校验到完成写入没有异步间隔，避免本应用的其他写入同时替换该文件。
        await resolveAgentPath(file)
        ctx?.signal.throwIfAborted()
        const original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file))
        const match = original.indexOf(old)
        if (match === -1 || original.indexOf(old, match + 1) !== -1) {
          return { ok: false, summary: 'oldText 必须在文件中恰好出现一次，请重新读取并提供更精确的原文' }
        }
        output = original.slice(0, match) + content + original.slice(match + old.length)
      }
      mkdirSync(parent, { recursive: true })
      if (mode === 'append') {
        writeFileSync(file, output, { encoding: 'utf8', flag: 'a' })
      } else {
        const temporary = join(parent, `.bewithu-${randomUUID()}.tmp`)
        try {
          writeFileSync(temporary, output, { encoding: 'utf8', flag: 'wx' })
          if (exists) copyFileSync(file, backup)
          renameSync(temporary, file)
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary)
        }
      }
      const savedBackup = exists ? backup : ''
      return {
        ok: true,
        summary: `已处理 ${basename(file)}（${mode}，新文本 ${content.length} 字）${savedBackup ? `，原文件备份为 ${basename(savedBackup)}` : ''}`,
        data: { path: file, backup: savedBackup }
      }
    }
  })
}
