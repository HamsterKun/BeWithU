import { randomUUID } from 'node:crypto'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface CaptureGeometry {
  displayId: string
  width: number
  height: number
  physicalBounds: Bounds
}

const recent = new Map<string, CaptureGeometry>()

export function registerScreenshot({ displayId, width, height, physicalBounds }: CaptureGeometry): string {
  const id = randomUUID()
  recent.set(id, { displayId, width, height, physicalBounds })
  if (recent.size > 32) recent.delete(recent.keys().next().value!)
  return id
}

export function screenshotPoint(
  id: string,
  x: number,
  y: number,
  currentBounds: (displayId: string) => Bounds | undefined
): { x: number; y: number } {
  const shot = recent.get(id)
  if (!shot) throw new Error('截图已失效，请重新调用 screen.capture')
  const bounds = shot.physicalBounds
  const current = currentBounds(shot.displayId)
  if (!current || current.x !== bounds.x || current.y !== bounds.y ||
      current.width !== bounds.width || current.height !== bounds.height) {
    throw new Error('显示器布局已变化，请重新截图再点击')
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= shot.width || y >= shot.height) {
    throw new Error(`点击坐标超出截图范围（${shot.width}×${shot.height}）`)
  }
  return {
    x: bounds.x + Math.floor(((x + 0.5) * bounds.width) / shot.width),
    y: bounds.y + Math.floor(((y + 0.5) * bounds.height) / shot.height)
  }
}
