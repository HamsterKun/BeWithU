import { app, dialog } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { log } from './logger'

/** 指针文件始终放在系统默认的 %APPDATA%，只记录"数据实际放在哪" */
function pointerFile(): string {
  return join(app.getPath('appData'), 'BeWithU', 'data-dir.txt')
}

/** 必须在 app ready 之前调用：先确定 userData 再初始化任何 store */
export function applyCustomDataDir(): void {
  try {
    const file = pointerFile()
    if (!existsSync(file)) return
    const dir = readFileSync(file, 'utf8').trim()
    if (!dir || !existsSync(dir)) return
    app.setPath('userData', dir)
    console.log('[data-dir] using custom dir:', dir)
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
  return resolve(currentDataDir()).toLowerCase() !== resolve(defaultDataDir()).toLowerCase()
}

/** 数据目录占用（MB），用于设置页展示 */
export function dirSizeMB(dir: string): number {
  return dirSize(dir) / 1024 / 1024
}

/** 只搬我们自己的数据，Chromium 的缓存目录留在原处由系统回收 */
const ITEMS = ['settings.json', 'secrets.bin', 'history.json', 'memory.json', 'models', 'logs']

function dirSize(dir: string): number {
  try {
    if (!existsSync(dir)) return 0
    const st = statSync(dir)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const name of readdirSync(dir)) {
      total += dirSize(join(dir, name))
    }
    return total
  } catch {
    return 0
  }
}

/**
 * 把当前数据搬到 target，并写入指针文件。
 * 校验通过后才删除源文件；任何一步失败都不会动指针，用户可以继续用原目录。
 */
export async function migrateDataDir(target: string): Promise<{ moved: string[]; bytes: number }> {
  const from = currentDataDir()
  const to = resolve(target)
  if (resolve(from).toLowerCase() === to.toLowerCase()) throw new Error('和目标目录相同')
  if (to.toLowerCase().startsWith(resolve(from).toLowerCase())) throw new Error('不能选当前数据目录的子目录')
  if (resolve(from).toLowerCase().startsWith(to)) throw new Error('不能选当前数据目录的上级目录')

  mkdirSync(to, { recursive: true })
  const moved: string[] = []
  let bytes = 0

  for (const item of ITEMS) {
    const src = join(from, item)
    if (!existsSync(src)) continue
    const dest = join(to, item)
    cpSync(src, dest, { recursive: true, force: true })
    const a = dirSize(src)
    const b = dirSize(dest)
    if (b < a) throw new Error(`复制 ${item} 校验失败（${b}/${a} 字节）`)
    bytes += a
    moved.push(item)
  }

  mkdirSync(join(app.getPath('appData'), 'BeWithU'), { recursive: true })
  writeFileSync(pointerFile(), to, 'utf8')

  // 指针写成功后再清理源数据
  for (const item of moved) {
    try {
      rmSync(join(from, item), { recursive: true, force: true })
    } catch (e) {
      log('data-dir: 清理旧文件失败', item, e instanceof Error ? e.message : e)
    }
  }

  log('data-dir: 已迁移', `${from} -> ${to}`, `${(bytes / 1024 / 1024).toFixed(1)}MB`)
  return { moved, bytes }
}

export function resetDataDir(): void {
  try {
    const file = pointerFile()
    if (existsSync(file)) rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
}

/** 搬回系统默认目录，然后删掉指针文件 */
export async function moveBackToDefault(): Promise<void> {
  if (!isCustomDataDir()) {
    resetDataDir()
    return
  }
  await migrateDataDir(defaultDataDir())
  resetDataDir()
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
