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
  timer?: NodeJS.Timeout
}

let pending: PendingGrab | null = null

export function isWgcPermissionRequest(): boolean {
  return pending !== null
}

export function getPendingWgcPermission(): { displayId: string; isActive: () => boolean } | null {
  const request = pending
  if (!request || request.permissionConsumed) return null
  return { displayId: request.displayId, isActive: () => pending === request }
}

export function consumeWgcPermission(): void {
  if (pending) pending.permissionConsumed = true
}

export function resolveGrab(result: GrabResult): void {
  const request = pending
  if (!request || !result || result.requestId !== request.id || typeof result.ok !== 'boolean') return
  if (result.ok && (!request.permissionConsumed || typeof result.dataUrl !== 'string' || result.dataUrl.length > 12 * 1024 * 1024)) return
  pending = null
  clearTimeout(request.timer)
  request.resolve(result)
}

/** Request a single WGC frame from the Ball renderer for one fixed display. */
export function grabViaWgc(displayId: string, timeoutMs = 5000): Promise<GrabResult | null> {
  if (pending) return Promise.resolve(null)
  const win = getBallWindow()
  if (!win || !displayId) return Promise.resolve(null)

  return new Promise((resolve) => {
    const request: PendingGrab = {
      id: randomUUID(),
      displayId,
      resolve,
      permissionConsumed: false
    }
    pending = request
    request.timer = setTimeout(() => {
      if (pending !== request) return
      pending = null
      log('vision: WGC 抓帧超时')
      resolve(null)
    }, timeoutMs)
    try {
      win.webContents.send(IPC.visionGrab, { requestId: request.id, displayId })
    } catch {
      pending = null
      clearTimeout(request.timer)
      resolve(null)
    }
  })
}
