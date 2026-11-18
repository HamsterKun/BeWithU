/** Shell 能力：默认关闭；关闭时引导模型去提醒用户开启 */
import { settingsStore } from '../../store/settings'
import { registerTool } from '../registry'
import { checkDangerous } from '../policy'
import { runPowerShell } from '../shell-run'
import type { ToolResult } from '../types'

export function registerShellTools(): void {
  registerTool({
    id: 'shell.ps',
    name: '执行 PowerShell',
    description:
      '在本机执行一段 PowerShell 脚本，可用于读写文件、调用系统命令、处理 Office 文档等。' +
      '需要用户在设置中开启 Shell 能力。',
    risk: 'high',
    params: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '要执行的 PowerShell 脚本（完整的命令文本）' },
        purpose: { type: 'string', description: '一句话说明这段脚本要干什么（会展示给用户）' }
      },
      required: ['script'],
      additionalProperties: false
    },
    async run(args, ctx): Promise<ToolResult> {
      const cfg = settingsStore.get().agent
      if (!cfg.shellEnabled) {
        // 不执行，并把"该怎么做"告诉模型，让它去提醒用户
        return {
          ok: false,
          summary:
            'Shell 能力当前没有开启，无法执行命令。请告诉用户：去「设置 → Agent 能力」里打开「允许执行 PowerShell」，' +
            '开启后我就能直接读写文件、处理文档，不用靠模拟键鼠。'
        }
      }
      const script = String(args.script ?? '').trim()
      if (!script) return { ok: false, summary: '脚本为空' }
      const danger = checkDangerous(script)
      if (!danger.ok) return { ok: false, summary: danger.reason ?? '命令被安全策略拒绝' }

      const res = await runPowerShell(script, { timeoutMs: cfg.stepTimeoutMs, signal: ctx.signal })
      const out = [res.stdout, res.stderr].filter(Boolean).join('\n')
      if (res.timedOut) return { ok: false, summary: `脚本执行超时（${cfg.stepTimeoutMs}ms）` }
      if (res.code !== 0) return { ok: false, summary: `脚本失败（exit ${res.code}）：${out.slice(0, 800)}`, data: { out } }
      return { ok: true, summary: out ? `执行成功，输出：\n${out}` : '执行成功（无输出）', data: { out } }
    }
  })
}
