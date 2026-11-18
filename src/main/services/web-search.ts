/**
 * 联网搜索：Tavily 或 DeepSeek Search API（二者都按次计费，失败/空结果不收费）。
 *
 * - Tavily:      POST {base}/search           { api_key, query, max_results, search_depth }
 * - DeepSeek:    POST {base}/v1/tools/search  { query, count, need_content, ori_question }
 *                Bearer 鉴权，返回 rerank_score / snippet / summary / content / authority
 */
import { settingsStore } from '../store/settings'
import { log } from '../logger'
import type { SearchSettings } from '../../shared/types'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  content?: string
  score?: number
  site?: string
}

export interface SearchOutcome {
  provider: string
  hits: SearchHit[]
}

const TIMEOUT_MS = 15000
const MAX_CONTENT = 1200

function clip(text: unknown, max: number): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`搜索接口返回 ${res.status}：${clip(text, 200)}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`搜索接口返回的不是 JSON：${clip(text, 120)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function searchTavily(query: string, cfg: SearchSettings): Promise<SearchHit[]> {
  const data = await fetchJson(`${trimBase(cfg.tavilyBaseUrl)}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.tavilyApiKey,
      query,
      max_results: cfg.maxResults,
      search_depth: 'basic',
      include_answer: false,
      topic: 'general'
    })
  })
  const results: any[] = Array.isArray(data?.results) ? data.results : []
  return results.slice(0, cfg.maxResults).map((r) => ({
    title: clip(r.title, 200) || '（无标题）',
    url: String(r.url ?? ''),
    snippet: clip(r.content ?? r.snippet, 400),
    content: clip(r.content, MAX_CONTENT),
    score: typeof r.score === 'number' ? r.score : undefined
  }))
}

async function searchDeepseek(query: string, cfg: SearchSettings): Promise<SearchHit[]> {
  const data = await fetchJson(`${trimBase(cfg.deepseekBaseUrl)}/v1/tools/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.deepseekApiKey}`
    },
    body: JSON.stringify({
      query,
      count: cfg.maxResults,
      need_content: true,
      ori_question: query
    })
  })
  const results: any[] = Array.isArray(data?.results) ? data.results : []
  return results.slice(0, cfg.maxResults).map((r) => ({
    title: clip(r.title, 200) || '（无标题）',
    url: String(r.url ?? ''),
    snippet: clip(r.summary || r.snippet, 400),
    content: clip(r.content || r.summary, MAX_CONTENT),
    score: typeof r.rerank_score === 'number' ? r.rerank_score : undefined,
    site: r.site_name ? String(r.site_name) : undefined
  }))
}

/** 按设置里的 provider 搜索；未开启或没配 Key 会抛出人话错误 */
export async function webSearch(query: string): Promise<SearchOutcome> {
  const cfg = settingsStore.get().search
  const q = query.trim()
  if (!q) throw new Error('搜索词是空的')
  if (!cfg.enabled) {
    throw new Error('联网搜索没有开启：可以去「设置 → Agent 能力 → 联网搜索」打开，或者直接把这个网址给用户')
  }
  if (cfg.provider === 'deepseek') {
    if (!cfg.deepseekApiKey.trim()) throw new Error('还没填 DeepSeek 的 API Key')
    const hits = await searchDeepseek(q, cfg)
    log('search: deepseek', `${q} -> ${hits.length}`)
    return { provider: 'deepseek', hits }
  }
  if (!cfg.tavilyApiKey.trim()) throw new Error('还没填 Tavily 的 API Key')
  const hits = await searchTavily(q, cfg)
  log('search: tavily', `${q} -> ${hits.length}`)
  return { provider: 'tavily', hits }
}

/** 给模型看的紧凑文本 */
export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return '没有搜到结果'
  return hits
    .map((h, i) => {
      const lines = [`${i + 1}. ${h.title}`, h.url, h.snippet]
      if (h.content && h.content !== h.snippet) lines.push(`正文摘录：${h.content.slice(0, 600)}`)
      return lines.filter(Boolean).join('\n')
    })
    .join('\n\n')
}
