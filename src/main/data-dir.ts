import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, cpSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 指针文件始终放在系统默认的 %APPDATA%，只记录数据实际存放的位置。 */
function pointerFile(): string {
  return join(app.getPath('appData'), 'BeWithU', 'data-dir.txt')
}

/** 必须在 app ready 之前调用：先确定 userData 再初始化任何 store。 */
export function applyCustomDataDir(): void {
  try {
    const file = checkedPointerFile()
    if (!lstatSync(file, { throwIfNoEntry: false })) return
    const dir = readFileSync(file, 'utf8')
    if (!isAbsolute(dir)) throw new Error('数据目录指针不是绝对路径')
    const actual = canonicalDirectory(dir, false)
    app.setPath('userData', actual)
    console.log('[data-dir] using custom dir:', actual)
  } catch (e) {
    console.error('[data-dir] apply failed', e)
  }
}

export function currentDataDir(): string {
  return app.getPath('userData')
}

export function defaultDataDir(): string {
  return join(app.getPath('appData'), app.getName())
}

export function isCustomDataDir(): boolean {
  try {
    return relative(canonicalDirectory(currentDataDir()), canonicalDirectory(defaultDataDir())) !== ''
  } catch {
    return relative(resolve(currentDataDir()), resolve(defaultDataDir())) !== ''
  }
}

/** 应用自有数据。Chromium 数据及指针文件不属于迁移内容。 */
const ITEMS = ['settings.json', 'secrets.bin', 'history.json', 'memory.json', 'usage.json', 'models', 'logs', 'agent']

interface ManifestEntry {
  path: string
  kind: 'file' | 'directory'
  size: number
  hash?: string
}

function hashFile(file: string, buffer: Buffer): string {
  const fd = openSync(file, 'r')
  try {
    const hash = createHash('sha256')
    let len: number
    while ((len = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, len))
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function manifest(root: string, buffer?: Buffer): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  const visit = (path: string, optional = false): void => {
    const stat = lstatSync(path, { bigint: false, throwIfNoEntry: false })
    if (!stat && !optional) throw new Error(`迁移期间文件已移除：${path}`)
    if (!stat) return
    const rel = relative(root, path)
    if (stat.isSymbolicLink()) throw new Error(`数据目录含符号链接，拒绝迁移：${rel}`)
    if (stat.isFile()) {
      entries.push({ path: rel, kind: 'file', size: stat.size, hash: buffer && hashFile(path, buffer) })
      return
    }
    if (!stat.isDirectory()) throw new Error(`数据目录含不支持的文件类型：${rel}`)
    entries.push({ path: rel, kind: 'directory', size: 0 })
    for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  for (const item of ITEMS) visit(join(root, item), true)
  return entries
}

/** 设置页只统计文件大小，不读取文件内容。 */
export function dirSizeMB(dir: string): number {
  try {
    return manifest(canonicalDirectory(dir)).reduce((sum, entry) => sum + entry.size, 0) / 1024 / 1024
  } catch {
    return 0
  }
}

function isPathWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 检查包括断开的链接在内的路径组件，解析已存在祖先的真实路径。 */
function canonicalDirectory(path: string, allowMissing = true): string {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  const canonicalParent = parent === absolute ? absolute : canonicalDirectory(parent, allowMissing)
  const stat = lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat) {
    if (!allowMissing || parent === absolute) throw new Error(`数据目录不存在：${absolute}`)
    return join(canonicalParent, basename(absolute))
  }
  if (stat.isSymbolicLink()) throw new Error(`数据目录路径包含符号链接：${absolute}`)
  if (!stat.isDirectory()) throw new Error(`数据路径不是目录：${absolute}`)
  return realpathSync.native(absolute)
}

function checkedPointerFile(): string {
  const file = join(canonicalDirectory(dirname(pointerFile())), basename(pointerFile()))
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) throw new Error('数据目录指针不是普通文件')
  return file
}

function commitPointer(file: string, target: string | null): void {
  if (target === null) {
    if (lstatSync(file, { throwIfNoEntry: false })) unlinkSync(file)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'wx')
  try {
    try {
      writeFileSync(fd, target, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // 同目录原子替换。替换失败时保留旧指针，避免先改名旧指针的空窗。
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 保留原始错误 */ }
    throw e
  }
}

function renameToVacant(from: string, to: string): void {
  if (lstatSync(to, { throwIfNoEntry: false })) throw new Error(`路径已存在，拒绝覆盖：${to}`)
  renameSync(from, to)
}

let restartPending = false

/** 复制完成后仅提交下次启动的路径。旧目录保留，便于回退或找回重启前新增的数据。 */
export async function migrateDataDir(target: string): Promise<{ moved: string[]; bytes: number }> {
  return migrate(target, false)
}

function migrate(target: string, returningToDefault: boolean): { moved: string[]; bytes: number } {
  if (restartPending) throw new Error('数据目录已切换，请先重启应用')
  if (!isAbsolute(target)) throw new Error('请选择绝对路径作为数据目录')
  const from = canonicalDirectory(currentDataDir(), false)
  const to = canonicalDirectory(target)
  if (isPathWithin(from, to) || isPathWithin(to, from)) {
    throw new Error('目标不能是当前数据目录或其上级、子目录')
  }
  const pointer = checkedPointerFile()
  const defaultRoot = canonicalDirectory(defaultDataDir())
  if (!returningToDefault && relative(to, defaultRoot) === '') {
    throw new Error('请使用“恢复默认”切换回系统默认目录')
  }
  if (relative(to, defaultRoot) !== '' && (isPathWithin(defaultRoot, to) || isPathWithin(to, defaultRoot))) {
    throw new Error('目标不能是默认数据目录的上级或子目录')
  }
  if (!returningToDefault && (isPathWithin(to, pointer) || isPathWithin(dirname(pointer), to))) {
    throw new Error('目标不能与数据目录指针位置重叠')
  }

  const existed = lstatSync(to, { throwIfNoEntry: false })
  if (existed && !returningToDefault && readdirSync(to).length > 0) {
    throw new Error('自定义目标目录必须为空，以免混合不同的数据')
  }

  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const source = manifest(from, buffer)
  const moved = ITEMS.filter((item) => source.some((entry) => entry.path === item))
  const bytes = source.reduce((sum, entry) => sum + entry.size, 0)
  let createdTarget = false
  let staging: string | undefined
  let backup: string | undefined
  const backedUp: string[] = []
  const installed: string[] = []
  let committed = false
  let rollbackFailed = false
  let assertTargetUnchanged: (() => void) | undefined
  try {
    if (!existed) {
      mkdirSync(dirname(to), { recursive: true })
      mkdirSync(to)
      createdTarget = true
    }
    const targetPath = canonicalDirectory(to, false)
    if (relative(targetPath, to) !== '') throw new Error('目标路径在迁移期间发生变化')
    const identity = lstatSync(to, { bigint: true })
    assertTargetUnchanged = (): void => {
      const current = lstatSync(to, { bigint: true })
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino ||
          relative(canonicalDirectory(to, false), to) !== '') {
        throw new Error('目标路径在迁移期间发生变化')
      }
    }
    const stage = mkdtempSync(join(to, '.bewithu-staging-'))
    staging = stage
    for (const item of moved) {
      cpSync(join(from, item), join(staging, item), {
        recursive: true, force: false, errorOnExist: true,
        filter: (src) => {
          const stat = lstatSync(src)
          if (!stat.isDirectory() && !stat.isFile()) throw new Error(`数据包含不支持的文件类型：${src}`)
          return true
        }
      })
    }
    const expected = JSON.stringify(source)
    if (JSON.stringify(manifest(staging, buffer)) !== expected || JSON.stringify(manifest(from, buffer)) !== expected) {
      throw new Error('数据复制校验失败，或源数据在迁移期间发生变化')
    }

    assertTargetUnchanged()
    if (!returningToDefault && readdirSync(to).some((name) => name !== basename(stage))) {
      throw new Error('自定义目标目录必须为空，以免混合不同的数据')
    }
    if (returningToDefault) {
      // 显式恢复默认时，将原默认应用数据整体归档。现有 Chromium 缓存保持原位。
      const previous = ITEMS.filter((item) => lstatSync(join(to, item), { throwIfNoEntry: false }))
      if (previous.length > 0) {
        backup = mkdtempSync(join(to, '.bewithu-backup-'))
        for (const item of previous) {
          renameToVacant(join(to, item), join(backup, item))
          backedUp.push(item)
        }
      }
    }
    for (const item of moved) {
      renameToVacant(join(staging, item), join(to, item))
      installed.push(item)
    }
    assertTargetUnchanged()
    if (checkedPointerFile() !== pointer) throw new Error('数据目录指针路径在迁移期间发生变化')
    commitPointer(pointer, returningToDefault ? null : to)
    committed = true
    restartPending = true
  } catch (e) {
    const rollbackErrors: unknown[] = []
    if (staging && (installed.length || backedUp.length)) {
      try {
        assertTargetUnchanged?.()
        canonicalDirectory(staging, false)
        if (backup) canonicalDirectory(backup, false)
        for (const item of installed.reverse()) {
          try { renameToVacant(join(to, item), join(staging, item)) } catch (err) { rollbackErrors.push(err) }
        }
        for (const item of backedUp.reverse()) {
          try { renameToVacant(join(backup!, item), join(to, item)) } catch (err) { rollbackErrors.push(err) }
        }
      } catch (err) {
        rollbackErrors.push(err)
      }
    }
    if (rollbackErrors.length > 0) {
      rollbackFailed = true
      console.error('[data-dir] rollback failed:', e, rollbackErrors)
      throw new Error(`数据迁移失败且目标目录未完全回滚，源数据仍保留。请检查：${to}`, { cause: e })
    }
    throw e
  } finally {
    if (!rollbackFailed) {
      try {
        assertTargetUnchanged?.()
        if (staging) {
          canonicalDirectory(staging, false)
          if (committed) rmdirSync(staging)
          else rmSync(staging, { recursive: true, force: true })
        }
        if (!committed && backup) rmdirSync(backup)
        if (!committed && createdTarget) rmdirSync(to)
      } catch (e) {
        console.error('[data-dir] cleanup failed:', e)
      }
    }
  }
  console.log('[data-dir] source retained:', from, 'new data:', to, 'previous default backup:', backup ?? 'none')
  return { moved, bytes }
}

/** 将当前应用数据复制回默认目录，旧默认数据另存为备份。 */
export async function moveBackToDefault(): Promise<void> {
  if (restartPending) throw new Error('数据目录已切换，请先重启应用')
  if (!isCustomDataDir()) {
    commitPointer(checkedPointerFile(), null)
    restartPending = true
    return
  }
  migrate(defaultDataDir(), true)
}

export async function pickDataDir(parent: Electron.BrowserWindow | null): Promise<string | null> {
  const res = parent
    ? await dialog.showOpenDialog(parent, {
        title: '选择数据存放目录',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '迁移到这里'
      })
    : await dialog.showOpenDialog({
        title: '选择数据存放目录',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '迁移到这里'
      })
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
}
