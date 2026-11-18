/** 联网搜索工具：Tavily / DeepSeek Search API */
import { registerTool } from '../registry'
import { settingsStore } from '../../store/settings'
import { formatHits, webSearch } from '../../services/web-search'
import type { ToolResult } from '../types'

const MAX_SUMMARY = 4000

export function registerWebTools(): void {
  registerTool({
    id: 'web.search',
    name: '联网搜索',
    description:
      '搜索实时网页信息：新闻、赛事结果、价格、版本号、人物近况等需要「最新」答案的问题。' +
      '返回标题、链接和摘要，回答时把来源链接带上。',
    risk: 'low',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，越具体越好，可以带 site: 限定站点' }
      },
      required: ['query'],
      additionalProperties: false
    },
    async run(args): Promise<ToolResult> {
      const cfg = settingsStore.get().search
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, summary: '搜索词是空的' }
      if (!cfg.enabled) {
        return {
          ok: false,
          summary:
            '联网搜索当前没有开启。请告诉用户：去「设置 → Agent 能力 → 联网搜索」选一个服务（Tavily 或 DeepSeek）并填 Key，' +
            '开启后我就能查最新信息。'
        }
      }
      try {
        const { provider, hits } = await webSearch(query)
        if (!hits.length) {
          return { ok: false, summary: `（${provider}）没搜到「${query}」的结果，可以换个说法再试` }
        }
        return {
          ok: true,
          summary: `（${provider}）搜到 ${hits.length} 条：\n${formatHits(hits).slice(0, MAX_SUMMARY)}`,
          data: { provider, query, hits }
        }
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) }
      }
    }
  })
}
