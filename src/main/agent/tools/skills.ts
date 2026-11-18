/** Skill 工具：模型按需读取技能全文（渐进披露的第二层） */
import { registerTool } from '../registry'
import { readSkillBody, scanSkills } from '../skills'
import type { ToolResult } from '../types'

const MAX_BODY = 8000

export function registerSkillTools(): void {
  registerTool({
    id: 'skill.read',
    name: '读取技能',
    description:
      '按名称读取一个技能的完整步骤说明。系统提示里会列出「可用技能」，需要时再调用它取全文，照着做。',
    risk: 'low',
    params: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名称（就是列表里显示的那个）' } },
      required: ['name'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      const name = String(args.name ?? '').trim()
      const res = readSkillBody(name)
      if (!res) {
        const names = scanSkills().map((s) => s.name)
        return {
          ok: false,
          summary: names.length
            ? `没有找到技能「${name}」。可用技能：${names.join('、')}`
            : '当前没有任何技能可用'
        }
      }
      const body = res.body.slice(0, MAX_BODY)
      return {
        ok: true,
        summary: `技能「${res.info.name}」的完整说明：\n${body}`,
        data: { name: res.info.name, body }
      }
    }
  })
}
