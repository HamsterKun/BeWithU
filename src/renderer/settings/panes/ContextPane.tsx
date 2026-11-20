import { useEffect, useState } from 'react'
import type { ContextInfo, ContextLevel, TimeAwareness } from '@shared/types'
import { Btn, Field, NumberInput, Section, Segmented } from '../ui'
import type { PaneProps } from './types'

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function fmtTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (v: number): string => (v < 10 ? `0${v}` : String(v))
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const LEVEL_OPTIONS: { value: ContextLevel; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'mid', label: '中' },
  { value: 'high', label: '高' }
]

const TIME_OPTIONS: { value: TimeAwareness; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'current', label: '仅当前消息' },
  { value: 'full', label: '每条消息' }
]

const SOURCE_TEXT: Record<ContextInfo['windowSource'], string> = {
  manual: '手动指定',
  table: '按模型名识别',
  fallback: '未识别，按 128k 估算'
}

export default function ContextPane({ s, patch }: PaneProps): React.ReactElement {
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  const refresh = (): void => {
    void window.bwu.settings.contextInfo().then(setInfo)
  }

  const compactNow = async (): Promise<void> => {
    setBusy(true)
    setResult('')
    try {
      const r = await window.bwu.settings.contextCompact()
      setResult(r.message)
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const clearAll = async (): Promise<void> => {
    if (!window.confirm('清空后这次对话不会再被记住（摘要与历史一起清掉），确定吗？')) return
    setResult('')
    try {
      await window.bwu.settings.clearHistory()
      setResult('上下文已清空')
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      refresh()
    }
  }

  // 切档位 / 改窗口大小都会改变占用比例，重新算一次。
  // 延迟一拍：设置是异步落盘（patch 里还有 420ms 防抖），立刻查会拿到旧预算。
  useEffect(() => {
    const timer = window.setTimeout(refresh, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.context.level, s.context.modelWindow, s.context.keepRecentTurns])

  const used = info?.used ?? 0
  const budget = info?.budget ?? 0
  const percent = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0
  const tone = percent >= 85 ? 'is-danger' : percent >= 70 ? 'is-warn' : ''

  return (
    <>
      <Section title="上下文" desc="按 token 预算管理对话记忆：写满就压缩，压缩用当前对话模型">
        <Field label="长度" hint="高 = 本模型可用上限（已扣掉回答所需空间）">
          <Segmented
            value={s.context.level}
            options={LEVEL_OPTIONS}
            onChange={(v) => patch({ context: { level: v } }, true)}
          />
        </Field>

        <Field
          label="模型窗口"
          hint={`当前按 ${fmtTokens(info?.window ?? 0)} 估算（${SOURCE_TEXT[info?.windowSource ?? 'fallback']}）；填 0 走自动`}
        >
          <NumberInput
            value={s.context.modelWindow}
            min={0}
            max={2000000}
            step={8000}
            onChange={(v) => patch({ context: { modelWindow: Math.max(0, Math.round(v)) } }, true)}
            suffix="token"
          />
        </Field>

        <div className="field field--wide">
          <div className="ctx-meter">
            <div className={`ctx-meter__bar ${tone}`}>
              <span style={{ width: `${percent}%` }} />
            </div>
            <span className="muted small">
              当前占用 {fmtTokens(used)} / {fmtTokens(budget)}（{percent}%）
              {percent >= 85 ? ' · 已到压缩水位' : ''}
            </span>
          </div>
        </div>

        <Field label="时间感知" hint="让模型知道每段对话发生在什么时候">
          <Segmented
            value={s.context.timeAwareness}
            options={TIME_OPTIONS}
            onChange={(v) => patch({ context: { timeAwareness: v } }, true)}
          />
        </Field>

        <Field label="压缩保留对话轮数" hint="压缩时这几轮保留原文，不揉进摘要">
          <NumberInput
            value={s.context.keepRecentTurns}
            min={1}
            max={12}
            onChange={(v) => patch({ context: { keepRecentTurns: Math.max(1, Math.min(12, v)) } }, true)}
            suffix="轮"
          />
        </Field>

        <div className="tipbox">
          写到预算的 85% 会自动压缩到 45% 以下；压缩只用当前对话模型，结果只存在本机。
          <br />
          历史消息只追加、不改写，这样前面那一大段能被服务端缓存复用，省钱也更快。
        </div>
      </Section>

      <Section title="当前摘要" desc="自动生成，不提供正文查看（可能很长）">
        <Field label="摘要">
          <span className="muted small">
            {info && info.summaryChars > 0
              ? `${info.summaryChars} 字 · 更新于 ${fmtTime(info.updatedAt)} · 已归档 ${info.archived} 条`
              : '还没有压缩过，全部对话都以原文保留'}
          </span>
        </Field>

        <Field label="待压缩" hint="还没进摘要、会原文发出去的消息条数">
          <span className="muted small">{info?.pending ?? 0} 条</span>
        </Field>

        <Field label="压缩记录">
          <span className="muted small">
            累计 {info?.compressions ?? 0} 次
            {info && info.lastBefore > 0
              ? ` · 上次 ${fmtTokens(info.lastBefore)} → ${fmtTokens(info.lastAfter)}`
              : ''}
          </span>
        </Field>

        <Field label="缓存命中" hint="服务端返回 usage 才有；命中越高越省钱">
          <span className="muted small">
            {info?.cacheHit && info.cacheHit.total > 0
              ? `${Math.round((info.cacheHit.hit / info.cacheHit.total) * 100)}%（${fmtTokens(info.cacheHit.hit)} / ${fmtTokens(info.cacheHit.total)}）`
              : '—'}
          </span>
        </Field>

        <div className="field field--wide">
          <div className="stack">
            <Btn onClick={refresh}>刷新</Btn>
            <Btn onClick={() => void compactNow()} disabled={busy}>
              {busy ? '压缩中…' : '立即压缩'}
            </Btn>
            <Btn onClick={() => void clearAll()}>清空上下文</Btn>
          </div>
          {result ? <span className="muted small ctx-result">{result}</span> : null}
        </div>
      </Section>

      <div className="tipbox">
        三挡只是同一份预算的换算：低 ≈ 可用上限的 1/3、中 ≈ 2/3、高 = 全部。档位只影响什么时候压缩，不影响模型知道多少。
      </div>
    </>
  )
}
