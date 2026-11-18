/** 键鼠 / 窗口类工具（注入实际在 utilityProcess 里执行） */
import {
  assertForeground,
  clickMouse,
  cursorPos,
  dragMouse,
  findWindowByTitle,
  focusWindowByTitle,
  foregroundWindowTitle,
  isInputAvailable,
  inputUnavailableReason,
  moveMouse,
  screenMetrics,
  sessionLocked,
  scrollMouse,
  sendKeys,
  typeText
} from '../../services/input-inject'
import { registerTool } from '../registry'
import type { ToolResult } from '../types'

function needInput(): void {
  if (!isInputAvailable()) throw new Error(inputUnavailableReason())
}

async function needUnlocked(): Promise<void> {
  if (await sessionLocked()) throw new Error('屏幕已锁定，无法操作电脑')
}

function num(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须是数字`)
  return Math.round(n)
}

export function registerInputTools(): void {
  registerTool({
    id: 'input.type',
    name: '输入文字',
    description: '把一段文字输入到当前活动窗口的光标处，支持中文/英文/符号。不要用于密码框。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文字（最多 2000 字）' },
        expectTitle: {
          type: 'string',
          description: '可选。要求当前前台窗口标题包含该文字，否则拒绝输入（防止打错窗口）'
        }
      },
      required: ['text'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      needInput()
      const text = String(args.text ?? '')
      if (!text) return { ok: false, summary: '没有可输入的内容' }
      await needUnlocked()
      if (args.expectTitle) await assertForeground(String(args.expectTitle))
      const res = await typeText(text)
      return {
        ok: true,
        summary: `已在「${res.target || '当前窗口'}」输入 ${res.length} 个字符`
      }
    }
  })

  registerTool({
    id: 'input.key',
    name: '按键',
    description: '发送一组按键或组合键，例如 "enter"、"tab"、"ctrl+s"、"alt+tab"、"f5"。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: '组合键字符串，用 + 连接，如 "ctrl+shift+s"' },
        expectTitle: { type: 'string', description: '可选。要求前台窗口标题匹配，否则拒绝' }
      },
      required: ['keys'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      needInput()
      const keys = String(args.keys ?? '')
      await needUnlocked()
      if (args.expectTitle) await assertForeground(String(args.expectTitle))
      await sendKeys(keys)
      return { ok: true, summary: `已发送按键 ${keys}` }
    }
  })

  registerTool({
    id: 'input.mouse_move',
    name: '移动鼠标',
    description: '把鼠标移动到屏幕上的物理像素坐标 (x, y)。坐标以虚拟桌面左上角为原点。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '物理像素 X' },
        y: { type: 'number', description: '物理像素 Y' }
      },
      required: ['x', 'y'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      needInput()
      const x = num(args.x, 'x')
      const y = num(args.y, 'y')
      await moveMouse(x, y)
      return { ok: true, summary: `鼠标已移动到 (${x}, ${y})` }
    }
  })

  registerTool({
    id: 'input.click',
    name: '鼠标点击',
    description: '在指定位置（或当前位置）点击鼠标，支持左/右/中键与多击。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '可选，物理像素 X' },
        y: { type: 'number', description: '可选，物理像素 Y' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
        count: { type: 'number', description: '点击次数 1-3，默认 1' }
      },
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      needInput()
      const button = (args.button === 'right' || args.button === 'middle' ? args.button : 'left') as
        | 'left'
        | 'right'
        | 'middle'
      const count = Math.max(1, Math.min(3, num(args.count ?? 1, 'count')))
      const hasPos = args.x !== undefined && args.y !== undefined
      await needUnlocked()
      await clickMouse({
        x: hasPos ? num(args.x, 'x') : undefined,
        y: hasPos ? num(args.y, 'y') : undefined,
        button,
        count
      })
      const where = hasPos ? `(${num(args.x, 'x')}, ${num(args.y, 'y')})` : '当前位置'
      return { ok: true, summary: `已在${where}点击 ${count} 次（${button}）` }
    }
  })

  registerTool({
    id: 'input.scroll',
    name: '滚动滚轮',
    description: '滚动鼠标滚轮，正数向上、负数向下，单位是"格"。',
    risk: 'high',
    params: {
      type: 'object',
      properties: { amount: { type: 'number', description: '滚轮格数，负值向下' } },
      required: ['amount'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      needInput()
      const amount = num(args.amount, 'amount')
      await scrollMouse(amount)
      return { ok: true, summary: `滚轮${amount > 0 ? '上滚' : '下滚'} ${Math.abs(amount)} 格` }
    }
  })

  registerTool({
    id: 'input.drag',
    name: '拖拽',
    description: '按住左键从一点拖到另一点（物理像素坐标），用于拖文件、选文本。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        from: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }
      },
      required: ['from', 'to'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      needInput()
      const f = (args.from ?? {}) as Record<string, unknown>
      const t = (args.to ?? {}) as Record<string, unknown>
      const from = { x: num(f.x, 'from.x'), y: num(f.y, 'from.y') }
      const to = { x: num(t.x, 'to.x'), y: num(t.y, 'to.y') }
      await dragMouse(from, to)
      return { ok: true, summary: `已从 (${from.x}, ${from.y}) 拖到 (${to.x}, ${to.y})` }
    }
  })

  registerTool({
    id: 'window.foreground',
    name: '当前窗口',
    description: '获取当前前台窗口的标题，用于确认焦点在哪。',
    risk: 'low',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      needInput()
      const title = await foregroundWindowTitle()
      return { ok: true, summary: `当前前台窗口：${title || '未知'}`, data: { title } }
    }
  })

  registerTool({
    id: 'window.focus',
    name: '切换窗口',
    description: '按标题把某个窗口切到前台（标题需精确匹配）。输入/点击前建议先切窗口。',
    risk: 'low',
    params: {
      type: 'object',
      properties: { title: { type: 'string', description: '窗口标题（精确匹配）' } },
      required: ['title'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      needInput()
      const title = String(args.title ?? '').trim()
      if (!title) return { ok: false, summary: '需要提供窗口标题' }
      if (!(await findWindowByTitle(title))) return { ok: false, summary: `没有找到标题为「${title}」的窗口` }
      const res = await focusWindowByTitle(title)
      return res.focused
        ? { ok: true, summary: `已切换到「${title}」` }
        : { ok: false, summary: `尝试切换「${title}」失败（当前前台：${res.foreground || '未知'}）` }
    }
  })

  registerTool({
    id: 'input.cursor',
    name: '鼠标位置',
    description: '获取当前鼠标的物理像素坐标。',
    risk: 'low',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      needInput()
      const p = await cursorPos()
      return { ok: true, summary: `鼠标在 (${p.x}, ${p.y})`, data: p }
    }
  })

  registerTool({
    id: 'input.screen_info',
    name: '屏幕信息',
    description: '获取虚拟桌面（所有显示器合并）的物理像素尺寸与原点，用于坐标换算。',
    risk: 'low',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      needInput()
      const m = await screenMetrics()
      return {
        ok: true,
        summary: `虚拟桌面 ${m.width}x${m.height}，原点 (${m.x}, ${m.y})`,
        data: m
      }
    }
  })

  // 测试专用：移动鼠标后立刻回读，验证注入链路（正常运行时不注册）
  if (process.env['BWU_AGENT_TEST'] === '1') {
    registerTool({
      id: 'input.self_test',
      name: '注入自检',
      description: '测试专用：把鼠标移动到指定坐标并回读，验证键鼠注入链路。',
      risk: 'low',
      params: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
        additionalProperties: false
      },
      async run(args): Promise<ToolResult> {
        needInput()
        const x = num(args.x, 'x')
        const y = num(args.y, 'y')
        const samples: Array<{ x: number; y: number }> = []
        for (let i = 0; i < 3; i++) {
          await moveMouse(x, y)
          await new Promise((r) => setTimeout(r, 30))
          const p = await cursorPos()
          samples.push(p)
          if (Math.abs(p.x - x) <= 2 && Math.abs(p.y - y) <= 2) {
            return { ok: true, summary: `注入通路正常，光标到达 (${p.x}, ${p.y})`, data: { samples } }
          }
        }
        return {
          ok: false,
          summary: `光标没有到达目标 (${x}, ${y})，实际 ${JSON.stringify(samples)}`,
          data: { samples }
        }
      }
    })
  }
}
