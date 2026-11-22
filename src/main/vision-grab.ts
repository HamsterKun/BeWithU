import { randomUUID } from 'node:crypto'
import type { GrabResult } from '../shared/ipc'
import { IPC } from '../shared/ipc'
import { getBallWindow } from './windows'
import { log } from './logger'

interface PendingGrab {
  id: string
  displayId: string
  resolve: (result: GrabResult | null) => void
  permissionConsumed: boolean
  cancelled: boolean
}

let pending: PendingGrab | null = null

export function isWgcPermissionRequest(): boolean {
  return pending !== null
}

export function getPendingWgcPermission(): { displayId: string; isActive: () => boolean } | null {
  const request = pending
  if (!request || request.permissionConsumed || request.cancelled) return null
  return { displayId: request.displayId, isActive: () => pending === request && !request.cancelled }
}

export function consumeWgcPermission(): void {
  if (pending) pending.permissionConsumed = true
}

export function resolveGrab(result: GrabResult): void {
  const request = pending
  if (!request || !result || result.requestId !== request.id || typeof result.ok !== 'boolean') return
  if (result.ok && (!request.permissionConsumed || typeof result.dataUrl !== 'string' || result.dataUrl.length > 12 * 1024 * 1024)) return
  pending = null
  request.resolve(result)
}

/** Request a single WGC frame from the Ball renderer for one fixed display. */
export function grabViaWgc(displayId: string, timeoutMs = 5000, signal?: AbortSignal): Promise<GrabResult | null> {
  if (pending || signal?.aborted) return Promise.resolve(null)
  const win = getBallWindow()
  if (!win || !displayId) return Promise.resolve(null)

  return new Promise((resolve) => {
    const done = (result: GrabResult | null): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (pending === request) pending = null
      resolve(result)
    }
    const abort = (): void => {
      // 保留当前请求占位，避免迟到的渲染进程抓帧占用下一次请求的权限。
      request.cancelled = true
      resolve(null)
    }
    const request: PendingGrab = {
      id: randomUUID(),
      displayId,
      resolve: done,
      permissionConsumed: false,
      cancelled: false
    }
    pending = request
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      log('vision: WGC 抓帧超时')
      done(null)
    }, timeoutMs)
    try {
      win.webContents.send(IPC.visionGrab, { requestId: request.id, displayId })
    } catch {
      done(null)
    }
  })
}
