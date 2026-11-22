import { desktopCapturer, screen, type NativeImage } from 'electron'
import { log } from '../logger'
import { grabViaWgc } from '../vision-grab'
import { registerScreenshot } from '../agent/screenshot-coordinates'

interface CapturedImage {
  dataUrl: string
  width: number
  height: number
  bytes: number
  displayId: string
  /** 截的是哪块屏（用于排查多屏问题） */
  displayLabel: string
  /** thumbnail = 普通抓屏；wgc = 图形捕获兜底 */
  via: 'thumbnail' | 'wgc'
}

export interface ScreenCapture extends CapturedImage {
  captureId: string
  physicalBounds: Electron.Rectangle
}

type CaptureResult<Shot = ScreenCapture> =
  | { ok: true; shot: Shot }
  | { ok: false; reason: 'blank' | 'empty' | 'error'; message: string }

const MAX_WIDTH = 1600

/** 独占全屏的游戏抓出来是一整块黑，先识别出来，别把黑图喂给模型 */
function looksBlank(image: NativeImage): boolean {
  try {
    const small = image.resize({ width: 64, quality: 'good' })
    const size = small.getSize()
    if (size.width < 2 || size.height < 2) return true
    const buf = small.toBitmap()
    let sum = 0
    let max = 0
    let count = 0
    for (let i = 0; i + 3 < buf.length; i += 4) {
      const v = (buf[i] + buf[i + 1] + buf[i + 2]) / 3
      sum += v
      if (v > max) max = v
      count += 1
    }
    if (!count) return true
    return sum / count < 4 && max < 14
  } catch {
    return false
  }
}

function currentDisplay(): Electron.Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/** 第一选择：desktopCapturer 缩略图（快，一般 100ms 内） */
async function captureThumbnail(display: Electron.Display): Promise<CaptureResult<CapturedImage>> {
  try {
    const scale = display.scaleFactor || 1
    const width = Math.min(MAX_WIDTH, Math.round(display.size.width * scale))
    const height = Math.max(
      1,
      Math.round(width * (display.size.height / Math.max(1, display.size.width)))
    )

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    })
    if (!sources.length) {
      return { ok: false, reason: 'empty', message: '没有拿到任何屏幕源' }
    }

    const source = sources.find((s) => s.display_id === String(display.id))
    if (!source) {
      return { ok: false, reason: 'empty', message: '找不到光标所在显示器的抓屏源，已跳过截图' }
    }
    const image = source.thumbnail
    if (!image || image.isEmpty()) {
      return { ok: false, reason: 'empty', message: '缩略图为空' }
    }
    if (looksBlank(image)) {
      return { ok: false, reason: 'blank', message: '抓到的是黑屏' }
    }

    const jpeg = image.toJPEG(78)
    const size = image.getSize()
    return {
      ok: true,
      shot: {
        dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        width: size.width,
        height: size.height,
        bytes: jpeg.length,
        displayId: source.display_id,
        displayLabel: source.name,
        via: 'thumbnail'
      }
    }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** 兜底：让渲染进程走 Windows Graphics Capture 抓一帧（独占全屏通常只有它能出图） */
async function captureWgc(displayId: string, signal?: AbortSignal): Promise<CaptureResult<CapturedImage>> {
  const res = await grabViaWgc(displayId, undefined, signal)
  if (!res || !res.ok || !res.dataUrl) {
    return { ok: false, reason: 'blank', message: res?.error ? `WGC 抓帧失败：${res.error}` : 'WGC 抓帧失败' }
  }
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]*={0,2})$/.exec(res.dataUrl)
  const width = res.width
  const height = res.height
  if (!match || !width || !height || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_WIDTH || height > 12000) {
    return { ok: false, reason: 'empty', message: 'WGC 返回了无效的图像' }
  }
  const base64 = match[2]
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (!bytes || bytes > 32 * 1024 * 1024) {
    return { ok: false, reason: 'empty', message: 'WGC 图像大小无效' }
  }
  return {
    ok: true,
    shot: {
      dataUrl: res.dataUrl,
      width,
      height,
      bytes,
      displayId,
      displayLabel: 'WGC',
      via: 'wgc'
    }
  }
}

/**
 * 截取"用户当前正在看的那块屏"：以光标所在显示器为准。
 * 先走快的缩略图；黑屏（独占全屏）时自动用 WGC 再试一次。
 */
export function displayPhysicalBounds(display: Electron.Display): Electron.Rectangle {
  return process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds
}

function withCaptureId(image: CapturedImage, physicalBounds: Electron.Rectangle): CaptureResult {
  const shot = { ...image, physicalBounds }
  return { ok: true, shot: { ...shot, captureId: registerScreenshot(shot) } }
}

export async function captureScreen(signal?: AbortSignal): Promise<CaptureResult> {
  signal?.throwIfAborted()
  const display = currentDisplay()
  const displayId = String(display.id)
  const physicalBounds = displayPhysicalBounds(display)
  const first = await captureThumbnail(display)
  signal?.throwIfAborted()
  if (first.ok) return withCaptureId(first.shot, physicalBounds)

  const wgc = await captureWgc(displayId, signal)
  signal?.throwIfAborted()
  if (wgc.ok) {
    log('vision: 缩略图不可用，已用 WGC 抓到画面')
    return withCaptureId(wgc.shot, physicalBounds)
  }
  log('vision: 两种抓屏都失败', first.message, wgc.message)
  return first
}
