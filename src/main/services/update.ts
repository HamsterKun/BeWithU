/**
 * 自动更新。
 *
 * 安装版（NSIS）走 electron-updater：检查 → 后台差分下载 → 退出时静默装好，下次启动即新版。
 * 便携版每次运行都解压到临时目录，没有「原位」可换，所以只做「检查 + 提示去下载」。
 */
import { BrowserWindow, app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../../shared/ipc'
import { APP_REPO_URL } from '../../shared/defaults'
import { isNewer } from '../../shared/version'
import type { UpdateStatus } from '../../shared/types'
import { log } from '../logger'
import { isPortable } from '../platform'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 启动后延后检查，别和窗口/录音抢资源 */
const START_DELAY_MS = Number(process.env.BWU_UPDATE_DELAY || 10000)
const RELEASES_PAGE = `${APP_REPO_URL}/releases/latest`
const API_URL =
  process.env.BWU_UPDATE_API || 'https://api.github.com/repos/HamsterKun/BeWithU/releases/latest'

let status: UpdateStatus = { kind: 'idle' }
let started = false
let inflight: Promise<UpdateStatus> | null = null

/**
 * 开发模式下默认不联网检查，只有显式给了本地 feed（BWU_UPDATE_CONFIG）
 * 或假 API（BWU_UPDATE_API）才启用 —— 免得开发机上天天打 GitHub。
 */
function updateEnabled(): boolean {
  return app.isPackaged || Boolean(process.env.BWU_UPDATE_CONFIG) || Boolean(process.env.BWU_UPDATE_API)
}

export function currentStatus(): UpdateStatus {
  return { ...status, portable: isPortable() }
}

function setStatus(next: UpdateStatus): void {
  status = next
  const payload = currentStatus()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateChanged, payload)
  }
}

/** 把 electron-updater 的原始报错翻成用户能看懂的一句话 */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  log('update: 失败', msg)
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return '网络不通，稍后再试'
  if (/404|Cannot find latest\.yml|not found/i.test(msg)) return '没有找到更新清单，可能是这个版本还没发布'
  if (/sha512|checksum/i.test(msg)) return '安装包校验失败，已放弃这次更新'
  if (/EACCES|EPERM|EBUSY/i.test(msg)) return '没有权限写入更新文件，请检查杀毒软件或磁盘权限'
  return '检查更新失败，稍后再试'
}

function configureUpdater(): void {
  autoUpdater.autoDownload = false
  // 用户点「稍后」直接退出也能装上，符合「无需重装」的预期
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  // 默认会往 stdout 打一堆英文日志，我们有自己的 logger
  autoUpdater.logger = null

  if (!app.isPackaged && process.env.BWU_UPDATE_CONFIG) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.updateConfigPath = process.env.BWU_UPDATE_CONFIG
  }

  autoUpdater.on('checking-for-update', () => setStatus({ kind: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    log('update: 有新版本', info.version)
    setStatus({ kind: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    log('update: 已是最新', info?.version ?? app.getVersion())
    setStatus({ kind: 'idle' })
  })
  autoUpdater.on('download-progress', (p) => {
    setStatus({
      kind: 'downloading',
      version: status.version,
      percent: Math.max(0, Math.min(100, Math.round(p.percent))),
      transferred: p.transferred,
      total: p.total
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log('update: 下载完成，等待重启', info.version)
    setStatus({ kind: 'ready', version: info.version })
  })
  autoUpdater.on('error', (e) => setStatus({ kind: 'error', message: friendlyError(e) }))
}

/**
 * 便携版没有 app-update.yml，用 GitHub Releases API 直接比版本。
 * 只读 tag_name，不下载任何东西。
 */
async function checkPortable(silent: boolean): Promise<UpdateStatus> {
  setStatus({ kind: 'checking' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BeWithU' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { tag_name?: string }
    const latest = String(json.tag_name ?? '').replace(/^[vV]/, '')
    if (latest && isNewer(latest, app.getVersion())) {
      setStatus({ kind: 'available', version: latest, portable: true })
    } else {
      setStatus({ kind: 'idle' })
    }
  } catch (e) {
    const aborted = controller.signal.aborted
    const message = aborted ? '检查更新超时，稍后再试' : friendlyError(e)
    // 后台自动检查失败不该打扰用户（离线、API 被墙都很常见），只有手动检查才报错
    setStatus(silent ? { kind: 'idle' } : { kind: 'error', message })
  } finally {
    clearTimeout(timer)
  }
  return currentStatus()
}

/**
 * 检查更新（安装版走 updater，便携版走 API）。
 * silent = 后台自动检查：失败时静默回到 idle，不弹错误横幅。
 */
export function check(opts: { silent?: boolean } = {}): Promise<UpdateStatus> {
  if (!updateEnabled()) return Promise.resolve(currentStatus())
  if (inflight) return inflight
  const silent = opts.silent === true
  inflight = (async () => {
    try {
      if (isPortable()) return await checkPortable(silent)
      await autoUpdater.checkForUpdates()
    } catch (e) {
      const message = friendlyError(e)
      setStatus(silent ? { kind: 'idle' } : { kind: 'error', message })
    } finally {
      inflight = null
    }
    return currentStatus()
  })()
  return inflight
}

/** 开始下载（只有安装版可用） */
export async function download(): Promise<UpdateStatus> {
  if (isPortable() || !updateEnabled()) return currentStatus()
  if (status.kind === 'downloading' || status.kind === 'ready') return currentStatus()
  try {
    setStatus({ kind: 'downloading', version: status.version, percent: 0 })
    await autoUpdater.downloadUpdate()
  } catch (e) {
    setStatus({ kind: 'error', message: friendlyError(e) })
  }
  return currentStatus()
}

/** 重启并安装（便携版点了只会去下载页） */
export function install(): void {
  if (isPortable()) {
    void openReleasePage()
    return
  }
  if (status.kind !== 'ready') return
  log('update: 用户选择立即重启')
  // 第二个参数 true = 装完自动启动
  autoUpdater.quitAndInstall(false, true)
}

export function openReleasePage(): Promise<void> {
  return shell.openExternal(RELEASES_PAGE)
}

export function initUpdate(): void {
  if (started) return
  started = true
  if (!updateEnabled()) {
    log('update: 开发模式，未启用自动更新')
    return
  }
  if (isPortable()) {
    log('update: 便携版，只做检查与跳转')
  } else {
    configureUpdater()
  }
  setTimeout(() => void check({ silent: true }), START_DELAY_MS)
  setInterval(() => void check({ silent: true }), CHECK_INTERVAL_MS)
}
