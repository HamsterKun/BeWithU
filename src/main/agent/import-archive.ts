/** 从 zip 导入工具/Skill：解到临时目录，再走原来的目录导入逻辑 */
import { app } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ExtractedDir {
  dir: string
  cleanup: () => void
}

/**
 * 解包资源上限。默认值能放下正常的工具/Skill 包，又能挡住压缩炸弹：
 * 一个 1MB 的 zip 可以解出几十 GB，所以必须在真正写盘之前就把体积量出来。
 */
export interface ExtractLimits {
  /** 条目（文件 + 目录）总数 */
  maxEntries: number
  /** 解压后总字节数 */
  maxTotalBytes: number
  /** 单个文件字节数 */
  maxFileBytes: number
  /** 目录层级深度 */
  maxDepth: number
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: 2000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxDepth: 8
}

const TAR_TIMEOUT_MS = 60000

/**
 * 固定用系统自带的 tar，不从 PATH 里找：PATH 上的同名程序可以被安装包/当前目录劫持，
 * 而这里正是处理不可信输入的入口。非 Windows 环境退回 PATH 上的 tar。
 */
function tarBin(): string {
  const systemTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(systemTar) ? systemTar : 'tar'
}

function shortStderr(stderr: string, fallback: string): string {
  return String(stderr || fallback).trim().slice(0, 300)
}

/**
 * 只看清单，不解压。用于查条目数、文件类型和越级路径。
 * 注意：清单里的日期字段会随系统 locale 变化，所以这里**不解析尺寸**，
 * 只依赖「一行一个条目、行首是权限位」这两个稳定的特征。
 */
function listArchive(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      tarBin(),
      ['-tvf', zipPath, '--numeric-owner'],
      { timeout: TAR_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`读取压缩包失败：${shortStderr(stderr, err.message)}`))
        else resolve(String(stdout ?? '').split(/\r?\n/).filter((line) => line.trim()))
      }
    )
  })
}

/**
 * 用 `-xO` 把内容流到 stdout，边读边计数，超限立刻杀进程。
 * 这样量到的是**真实解压字节数**，不依赖清单里的尺寸字段，也完全不落盘。
 */
function measureUncompressedSize(zipPath: string, limit: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(tarBin(), ['-xOf', zipPath], { windowsHide: true })
    let total = 0
    let stderr = ''
    let aborted = false

    const timer = setTimeout(() => {
      aborted = true
      child.kill()
      reject(new Error('读取压缩包超时，已拒绝导入'))
    }, TAR_TIMEOUT_MS)

    child.stdout?.on('data', (buf: Buffer) => {
      if (aborted) return
      total += buf.length
      if (total > limit) {
        aborted = true
        clearTimeout(timer)
        child.kill()
        reject(new Error(`压缩包解压后体积过大（超过 ${limit} 字节），已拒绝导入`))
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8')
    })
    child.on('error', (e) => {
      if (aborted) return
      aborted = true
      clearTimeout(timer)
      reject(new Error(`读取压缩包失败：${e.message}`))
    })
    child.on('close', (code) => {
      if (aborted) return
      clearTimeout(timer)
      if (code === 0) resolve(total)
      else reject(new Error(`读取压缩包失败：${shortStderr(stderr, `tar 退出码 ${code}`)}`))
    })
  })
}

/** 解压前查清单：条目数、是否有链接/特殊文件、有无越级路径和绝对路径 */
async function assertArchiveWithinLimits(zipPath: string, limits: ExtractLimits): Promise<void> {
  const lines = await listArchive(zipPath)
  if (lines.length > limits.maxEntries) {
    throw new Error(`压缩包条目太多（${lines.length} > ${limits.maxEntries}），已拒绝导入`)
  }
  for (const line of lines) {
    const kind = line[0]
    if (kind !== '-' && kind !== 'd') {
      throw new Error('压缩包里含有链接或特殊文件（非普通文件/目录），已拒绝导入')
    }
    // 清单里保留的是归档内的原始路径，越级/绝对路径在这里就能看出来
    if (line.includes('../') || line.includes('..\\')) {
      throw new Error('压缩包里含有向上越级的路径，已拒绝导入')
    }
  }
  await measureUncompressedSize(zipPath, limits.maxTotalBytes)
}

function extractArchive(zipPath: string, base: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      tarBin(),
      ['-xf', zipPath, '-C', base],
      { timeout: TAR_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`解压失败：${shortStderr(stderr, err.message)}`))
        else resolve()
      }
    )
  })
}

/**
 * 解压之后再按真实文件系统复核一遍：确认没有符号链接/junction、
 * 没有特殊文件，实际条目数、体积和层级也在上限内。
 */
function assertTreeWithinLimits(root: string, limits: ExtractLimits): void {
  let count = 0
  let total = 0
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number }
    if (depth > limits.maxDepth) throw new Error(`目录层级过深（超过 ${limits.maxDepth} 层），已拒绝导入`)
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) throw new Error('压缩包里含有符号链接，已拒绝导入')
      if (st.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!st.isFile()) throw new Error('压缩包里含有特殊文件（非普通文件），已拒绝导入')
      count++
      total += st.size
      if (count > limits.maxEntries) throw new Error(`解压后条目太多（超过 ${limits.maxEntries}），已拒绝导入`)
      if (st.size > limits.maxFileBytes) {
        throw new Error(`解压后有单个文件过大（超过 ${limits.maxFileBytes} 字节），已拒绝导入`)
      }
      if (total > limits.maxTotalBytes) throw new Error('解压后总体积过大，已拒绝导入')
    }
  }
}

/** Windows 10+ 自带 bsdtar，支持 zip；解压后如果只有一层目录就自动下钻 */
export async function extractZip(
  zipPath: string,
  overrides: Partial<ExtractLimits> = {}
): Promise<ExtractedDir> {
  const limits: ExtractLimits = { ...DEFAULT_LIMITS, ...overrides }
  const base = join(
    app.getPath('temp'),
    `bwu-import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  )
  mkdirSync(base, { recursive: true })

  // 任何一步失败都要把已经落盘的临时目录清掉，不留在 temp 里
  try {
    await assertArchiveWithinLimits(zipPath, limits)
    await extractArchive(zipPath, base)
    assertTreeWithinLimits(base, limits)
  } catch (e) {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw e
  }

  let dir = base
  const entries = readdirSync(base)
  if (entries.length === 1) {
    const only = join(base, entries[0])
    try {
      if (statSync(only).isDirectory()) dir = only
    } catch {
      /* ignore */
    }
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(base, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
