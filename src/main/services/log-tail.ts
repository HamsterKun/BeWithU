/**
 * 日志尾部读取：只读文件最后一段，避免把几 MB 日志整个读进主进程（A8 的教训）。
 * 纯 fs 实现，不依赖 electron，方便单测。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { LogLevel, LogTail } from '../../shared/types'

/** 最多读这么多字节（约 8k 行），再多没意义 */
const MAX_BYTES = 512 * 1024
const DEFAULT_LINES = 200

/**
 * 日志本身没有级别字段，只能按内容推断。
 * 宁可少判，也不要给正常日志染红：只在出现明确的失败词时才标 error。
 */
export function classify(text: string): LogLevel {
  if (/(失败|错误|异常|崩溃|error|fail|exception|EACCES|ENOENT|ECONN)/i.test(text)) return 'error'
  if (/(超时|重试|降级|警告|timeout|warn|retry)/i.test(text)) return 'warn'
  return 'info'
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+([\s\S]*)$/

export function readLogTail(
  file: string,
  opts: { lines?: number; keyword?: string; onlyProblems?: boolean } = {}
): LogTail {
  const empty: LogTail = { path: file, sizeBytes: 0, total: 0, shown: 0, lines: [] }
  if (!file || !existsSync(file)) return empty

  let sizeBytes = 0
  try {
    sizeBytes = statSync(file).size
  } catch {
    return empty
  }
  if (sizeBytes === 0) return { ...empty, sizeBytes }

  let raw = ''
  try {
    const start = Math.max(0, sizeBytes - MAX_BYTES)
    const buf = readFileSync(file)
    const slice = buf.subarray(start)
    raw = slice.toString('utf8')
    // 从中间截断时，第一行多半是半截，丢掉
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1)
  } catch {
    return { ...empty, sizeBytes }
  }

  const keyword = String(opts.keyword ?? '').trim().toLowerCase()
  const parsed: LogTail['lines'] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = LINE_RE.exec(line)
    const at = m ? m[1] : ''
    const text = m ? m[2] : line
    const level = classify(text)
    if (opts.onlyProblems && level === 'info') continue
    if (keyword && !line.toLowerCase().includes(keyword)) continue
    parsed.push({ at, level, text })
  }

  const total = parsed.length
  const wanted = Math.max(1, Math.min(Math.floor(Number(opts.lines) || DEFAULT_LINES), 2000))
  const lines = parsed.slice(-wanted)
  return { path: file, sizeBytes, total, shown: lines.length, lines }
}
