/** 从 zip 导入工具/Skill：解到临时目录，再走原来的目录导入逻辑 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ExtractedDir {
  dir: string
  cleanup: () => void
}

/** Windows 10+ 自带 bsdtar，支持 zip；解压后如果只有一层目录就自动下钻 */
export async function extractZip(zipPath: string): Promise<ExtractedDir> {
  const base = join(
    app.getPath('temp'),
    `bwu-import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  )
  mkdirSync(base, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    execFile(
      'tar',
      ['-xf', zipPath, '-C', base],
      { timeout: 60000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`解压失败：${String(stderr || err.message).slice(0, 300)}`))
        else resolve()
      }
    )
  })

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
