/** 截屏工具：保存本地副本，并返回 Agent 可使用的画面。 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureScreen } from '../../services/vision'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'
import { rememberScreenshot } from '../screenshot-coordinates'

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function registerScreenTools(): void {
  registerTool({
    id: 'screen.capture',
    name: '截屏',
    description:
      '截取鼠标所在显示器并保存。开启屏幕理解时，模型可直接看到图片。基于这张图点击时，将 captureId 和图中像素坐标 x、y 一起传给 input.click。',
    risk: 'low',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx): Promise<ToolResult> {
      const res = await captureScreen(ctx.signal)
      ctx.signal.throwIfAborted()
      if (!res.ok) {
        const reason = res.message || '未知原因'
        return { ok: false, summary: `截图失败：${reason}` }
      }
      const shot = res.shot
      const dir = join(app.getPath('temp'), 'bewithu', 'shots')
      mkdirSync(dir, { recursive: true })
      const id = randomUUID()
      const ext = shot.dataUrl.startsWith('data:image/jpeg;') ? 'jpg' : 'png'
      const file = join(dir, `shot-${stamp(new Date())}-${id.slice(0, 8)}.${ext}`)
      const base64 = shot.dataUrl.split(',')[1] ?? ''
      writeFileSync(file, Buffer.from(base64, 'base64'))
      const kb = Math.max(1, Math.round(shot.bytes / 1024))
      if (shot.physicalBounds) rememberScreenshot(id, { ...shot, physicalBounds: shot.physicalBounds })
      return {
        ok: true,
        summary: `已截屏并保存到 ${file}（${shot.width}x${shot.height}，约 ${kb}KB）`,
        data: {
          path: file, width: shot.width, height: shot.height, bytes: shot.bytes, displayId: shot.displayId,
          ...(shot.physicalBounds && { captureId: id, physicalBounds: shot.physicalBounds })
        },
        screenshot: { dataUrl: shot.dataUrl }
      }
    }
  })
}
