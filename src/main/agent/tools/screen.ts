/** 截屏工具：保存成 PNG 并返回路径（能不能"看懂"取决于模型是否支持视觉） */
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureScreen } from '../../services/vision'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function registerScreenTools(): void {
  registerTool({
    id: 'screen.capture',
    name: '截屏',
    description:
      '截取当前屏幕并保存为 PNG，返回文件路径和尺寸。注意：这一步只是"拍下来存成文件"，' +
      '你能否真的看到画面取决于当前模型是否支持视觉；不支持时请如实告诉用户。',
    risk: 'low',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      const res = await captureScreen()
      if (!res.ok) {
        const reason = res.reason === 'blank' ? '抓不到画面（游戏独占全屏时常见）' : (res.reason ?? '未知原因')
        return { ok: false, summary: `截图失败：${reason}` }
      }
      const shot = res.shot
      const dir = join(app.getPath('temp'), 'bewithu', 'shots')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `shot-${stamp(new Date())}.png`)
      const base64 = shot.dataUrl.split(',')[1] ?? ''
      writeFileSync(file, Buffer.from(base64, 'base64'))
      const kb = Math.max(1, Math.round(shot.bytes / 1024))
      return {
        ok: true,
        summary:
          `已截屏并保存到 ${file}（${shot.width}x${shot.height}，约 ${kb}KB）。` +
          '如果你看不到图片内容，说明当前模型不支持视觉，请告诉用户可以换成支持看图的模型，或直接打开这个文件。',
        data: { path: file, width: shot.width, height: shot.height, bytes: shot.bytes }
      }
    }
  })
}
