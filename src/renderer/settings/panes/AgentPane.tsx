import { useCallback, useEffect, useState } from 'react'
import { Btn, Field, NumberInput, Section, Toggle } from '../ui'
import type { PaneProps } from './types'

interface ToolInfo {
  id: string
  name: string
  risk: string
  enabled: boolean
}

interface RunEntry {
  at: number
  toolId: string
  ok: boolean
  summary: string
}

function timeText(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function AgentPane({ s, patch }: PaneProps): React.ReactElement {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [runs, setRuns] = useState<RunEntry[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const [t, r] = await Promise.all([window.bwu.agentTools.list(), window.bwu.agentTools.runs()])
    setTools(t)
    setRuns(r)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleTool = (id: string, enabled: boolean): void => {
    const next = enabled
      ? s.agent.disabledTools.filter((x) => x !== id)
      : [...s.agent.disabledTools, id]
    patch({ agent: { disabledTools: next } })
    setTools((prev) => prev.map((t) => (t.id === id ? { ...t, enabled } : t)))
  }

  const addDir = async (): Promise<void> => {
    setBusy(true)
    try {
      const dir = await window.bwu.settings.pickDir()
      if (!dir) return
      if (s.agent.files.dirs.includes(dir)) return
      patch({ agent: { files: { dirs: [...s.agent.files.dirs, dir] } } })
    } finally {
      setBusy(false)
    }
  }

  const removeDir = (dir: string): void => {
    patch({ agent: { files: { dirs: s.agent.files.dirs.filter((d) => d !== dir) } } })
  }

  const shellOn = s.agent.shellEnabled

  return (
    <div className="pane">
      <Section
        title="Agent 能力"
        desc="开启后，小伴可以直接调用工具操作电脑（文件、应用、键鼠、Shell）；关闭时只做普通聊天。"
      >
        <Field label="启用 Agent" hint="高风险操作会在气泡里弹确认卡">
          <Toggle checked={s.agent.enabled} onChange={(v) => patch({ agent: { enabled: v } })} />
        </Field>
        <Field
          label="允许执行 PowerShell"
          hint="完全信任模式：开启后不再逐次确认，只拦截 rm -rf、格式化磁盘等极高危命令"
        >
          <Toggle checked={shellOn} onChange={(v) => patch({ agent: { shellEnabled: v } })} />
        </Field>
        {shellOn ? (
          <p className="agent-warn">
            Shell 已开启：模型可以直接读写文件、调用系统命令。不熟悉的模型建议关掉，或只在需要时临时打开。
          </p>
        ) : null}
        <Field label="最大步数" hint="一次任务最多调用多少次工具">
          <NumberInput
            value={s.agent.maxSteps}
            min={3}
            max={30}
            onChange={(v) => patch({ agent: { maxSteps: Math.max(3, Math.min(30, v)) } })}
            suffix="步"
          />
        </Field>
      </Section>

      <Section title="文件访问" desc="默认只允许 桌面 / 文档 / 下载；需要别的位置就加到下面的列表里。">
        <Field label="完全访问" hint="允许读写任意用户目录，风险更高">
          <Toggle
            checked={s.agent.files.fullAccess}
            onChange={(v) => patch({ agent: { files: { fullAccess: v } } })}
          />
        </Field>
        <Field label="可操作目录" wide>
          <div className="agent-dirs">
            {s.agent.files.dirs.length === 0 ? (
              <span className="agent-empty">还没有添加目录（默认 桌面 / 文档 / 下载 已允许）</span>
            ) : (
              s.agent.files.dirs.map((dir) => (
                <div className="agent-dir" key={dir}>
                  <span className="agent-dir__path" title={dir}>
                    {dir}
                  </span>
                  <button className="agent-dir__del" onClick={() => removeDir(dir)} title="移除">
                    ×
                  </button>
                </div>
              ))
            )}
            <Btn onClick={() => void addDir()} disabled={busy || s.agent.files.fullAccess}>
              添加目录…
            </Btn>
          </div>
        </Field>
      </Section>

      <Section title="工具" desc="关掉不想让 Agent 使用的工具；自定义工具放进工具目录即可（导入功能下一步做）。">
        <div className="agent-tools">
          {tools.map((t) => (
            <div className="agent-tool" key={t.id}>
              <div className="agent-tool__main">
                <span className="agent-tool__name">{t.name}</span>
                <span className="agent-tool__id">{t.id}</span>
                <span className={t.risk === 'high' ? 'agent-tool__risk is-high' : 'agent-tool__risk'}>
                  {t.risk === 'high' ? '需确认' : '只读'}
                </span>
              </div>
              <Toggle checked={t.enabled} onChange={(v) => toggleTool(t.id, v)} />
            </div>
          ))}
        </div>
        <div className="agent-actions">
          <Btn onClick={() => void window.bwu.agentTools.openDir()}>打开工具目录</Btn>
        </div>
      </Section>

      <Section title="运行记录" desc="最近 50 次工具调用；日志按天保存，只保留 7 天。">
        <div className="agent-runs">
          {runs.length === 0 ? (
            <span className="agent-empty">还没有调用记录</span>
          ) : (
            runs.map((r, i) => (
              <div className="agent-run" key={`${r.at}-${i}`}>
                <span className="agent-run__time">{timeText(r.at)}</span>
                <span className={r.ok ? 'agent-run__ok' : 'agent-run__fail'}>{r.ok ? '✓' : '✗'}</span>
                <span className="agent-run__tool">{r.toolId}</span>
                <span className="agent-run__text" title={r.summary}>
                  {r.summary.replace(/\s+/g, ' ').slice(0, 80)}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="agent-actions">
          <Btn
            onClick={() => {
              void window.bwu.agentTools.clearRuns().then(() => setRuns([]))
            }}
          >
            清空记录
          </Btn>
          <Btn onClick={() => void refresh()}>刷新</Btn>
        </div>
      </Section>
    </div>
  )
}
