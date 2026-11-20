import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataDirInfo, LogTail, UsageSummary } from '@shared/types'
import { Btn, NumberInput, Section, Toggle } from '../ui'
import type { PaneProps } from './types'

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : n.toLocaleString()
}

function fmtClock(at: string): string {
  if (!at) return '--:--:--'
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at.slice(11, 19)
  const pad = (v: number): string => (v < 10 ? `0${v}` : String(v))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fmtSize(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const LEVEL_LABEL: Record<string, string> = { info: '信息', warn: '警告', error: '错误' }

export default function DataPane({ s }: PaneProps): React.ReactElement {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [dir, setDir] = useState<DataDirInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const [log, setLog] = useState<LogTail | null>(null)
  const [keyword, setKeyword] = useState('')
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [count, setCount] = useState(200)
  const [auto, setAuto] = useState(true)
  const [copyMsg, setCopyMsg] = useState('')
  const timer = useRef<number | null>(null)

  const loadLog = useCallback(async (): Promise<void> => {
    try {
      const r = await window.bwu.logsTail({ lines: count, keyword, onlyProblems })
      setLog(r)
    } catch (e) {
      setCopyMsg(e instanceof Error ? e.message : String(e))
    }
  }, [count, keyword, onlyProblems])

  const refreshAll = (): void => {
    void window.bwu.usageStats().then(setUsage)
    void window.bwu.settings.dataDirInfo().then(setDir)
    void loadLog()
  }

  useEffect(() => {
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关键字/条数变化后重新取一次（防抖，避免每敲一个字就读盘）
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void loadLog(), 250)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [loadLog])

  // 自动刷新：只在页面可见时轮询，避免设置页开着没人看还在读盘
  useEffect(() => {
    if (!auto) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadLog()
    }, 3000)
    return () => window.clearInterval(id)
  }, [auto, loadLog])

  const changeDir = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      const r = await window.bwu.settings.changeDataDir()
      if (r.ok) setMsg(`${r.message ?? '已迁移'}（正在重启…）`)
      else if (!r.canceled) setMsg(r.message ?? '迁移失败')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const resetDir = async (): Promise<void> => {
    if (!window.confirm('把数据搬回系统默认目录（C 盘）？设置、密钥、历史、本地模型都会一起搬过去。')) return
    setBusy(true)
    setMsg('')
    try {
      const r = await window.bwu.settings.resetDataDir()
      setMsg(r.ok ? `${r.message ?? ''}（正在重启…）` : (r.message ?? '失败'))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const copyLog = async (): Promise<void> => {
    const text = (log?.lines ?? []).map((l) => `${l.at} ${l.text}`).join('\n')
    if (!text) {
      setCopyMsg('没有可复制的内容')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopyMsg(`已复制 ${log?.shown ?? 0} 行`)
    } catch {
      setCopyMsg('复制失败，可以「打开日志目录」自己拿文件')
    }
  }

  return (
    <>
      <Section title="用量统计" desc="只统计本机调用量，用于估费用；不联网上报">
        <div className="usage">
          {[
            {
              label: '大模型（对话）',
              today: usage
                ? `${fmt(usage.today.chat.input + usage.today.chat.output)} tokens · ${usage.today.chat.calls} 次`
                : '—',
              month: usage
                ? `${fmt(usage.month.chat.input + usage.month.chat.output)} tokens · ${usage.month.chat.calls} 次`
                : '—'
            },
            {
              label: '上下文压缩',
              today: usage
                ? `${fmt(usage.today.summary.input + usage.today.summary.output)} tokens · ${usage.today.summary.calls} 次`
                : '—',
              month: usage
                ? `${fmt(usage.month.summary.input + usage.month.summary.output)} tokens · ${usage.month.summary.calls} 次`
                : '—'
            },
            {
              label: '语音合成（TTS）',
              today: usage ? `${fmt(usage.today.tts.chars)} 字 · ${usage.today.tts.calls} 次` : '—',
              month: usage ? `${fmt(usage.month.tts.chars)} 字 · ${usage.month.tts.calls} 次` : '—'
            },
            {
              label: '语音识别（云端）',
              today: usage ? `${usage.today.asr.seconds.toFixed(1)} 秒 · ${usage.today.asr.calls} 次` : '—',
              month: usage ? `${usage.month.asr.seconds.toFixed(1)} 秒 · ${usage.month.asr.calls} 次` : '—'
            }
          ].map((row) => (
            <div className="usage__row" key={row.label}>
              <span className="usage__label">{row.label}</span>
              <span className="usage__value">{row.today}</span>
              <span className="usage__value usage__value--month">{row.month}</span>
            </div>
          ))}
          <div className="usage__head">
            <span className="usage__label" />
            <span className="usage__value">今日</span>
            <span className="usage__value usage__value--month">本月</span>
          </div>
        </div>
        <div className="row-actions">
          <Btn onClick={() => refreshAll()}>刷新</Btn>
          <Btn
            variant="danger"
            onClick={() => {
              if (window.confirm('清空本机用量统计？')) void window.bwu.clearUsage().then(setUsage)
            }}
          >
            清零
          </Btn>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          对话与压缩按接口返回的 token 计；TTS 按合成字数；云端识别按音频时长。本地识别与本地合成不产生费用。
        </p>
      </Section>

      <Section title="运行日志" desc="只读写在本机，密钥与请求头写入前已打码">
        <div className="log-toolbar">
          <input
            className="input input--search"
            value={keyword}
            placeholder="搜索关键字，如 stderr / 401 / 截屏"
            onChange={(e) => setKeyword(e.target.value)}
          />
          <label className="log-check">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            只看问题
          </label>
          <NumberInput value={count} min={50} max={2000} step={50} onChange={setCount} suffix="行" />
          <Btn onClick={() => void loadLog()}>刷新</Btn>
        </div>

        <div className="log-meta">
          <span className="muted small">
            {log
              ? `${fmtSize(log.sizeBytes)} · 命中 ${log.shown} 行${log.total > log.shown ? `（共 ${log.total} 行）` : ''}`
              : '读取中…'}
          </span>
          <Toggle checked={auto} onChange={setAuto} label="自动刷新" />
        </div>

        <div className="logbox" role="log">
          {(log?.lines ?? []).length === 0 ? (
            <div className="logbox__empty">
              {keyword || onlyProblems ? '没有匹配的日志，换个关键字试试' : '还没有日志'}
            </div>
          ) : (
            (log?.lines ?? []).map((line, i) => (
              <div className={`logbox__line is-${line.level}`} key={`${line.at}-${i}`}>
                <span className="logbox__time">{fmtClock(line.at)}</span>
                {line.level !== 'info' ? (
                  <span className={`logbox__tag is-${line.level}`}>{LEVEL_LABEL[line.level]}</span>
                ) : null}
                <span className="logbox__text">{line.text}</span>
              </div>
            ))
          )}
        </div>

        <div className="row-actions">
          <Btn onClick={() => void copyLog()}>复制当前内容</Btn>
          <Btn onClick={() => void window.bwu.logsOpenDir()}>打开日志目录</Btn>
          {log?.path ? <span className="muted small mono log-path">{log.path}</span> : null}
        </div>
        {copyMsg ? <span className="muted small">{copyMsg}</span> : null}
      </Section>

      <Section title="数据目录" desc="设置、密钥、对话记录、上下文摘要和本地模型都存在这里">
        <div className="kv">
          <span>当前目录</span>
          <b className="mono">{dir?.dir ?? '—'}</b>
        </div>
        <div className="kv">
          <span>占用</span>
          <b>
            {dir ? `${dir.sizeMB} MB` : '—'}
            {dir?.custom ? (
              <span className="badge badge--ok" style={{ marginLeft: 8 }}>
                自定义
              </span>
            ) : null}
          </b>
        </div>
        <div className="kv">
          <span>默认目录</span>
          <b className="mono">{dir?.defaultDir ?? '—'}</b>
        </div>

        <div className="row-actions">
          <Btn onClick={() => void window.bwu.settings.openDataDir()}>打开目录</Btn>
          <Btn variant="primary" onClick={() => void changeDir()} disabled={busy}>
            {busy ? '迁移中…' : '更改目录…'}
          </Btn>
          {dir?.custom ? (
            <Btn variant="danger" onClick={() => void resetDir()} disabled={busy}>
              搬回默认目录
            </Btn>
          ) : null}
        </div>

        {msg ? <div className="tipbox">{msg}</div> : null}

        <div className="tipbox">
          更改目录后会自动重启，设置、密钥、对话记录、摘要和本地模型都会一起带过去。
        </div>
      </Section>

      <p className="muted small">
        数据都不上云：密钥用系统加密保存，对话与摘要在本机；要清对话去「上下文」页点「清空上下文」。
      </p>
    </>
  )
}
