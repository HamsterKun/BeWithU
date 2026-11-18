import { useCallback, useEffect, useState } from 'react'
import type { AgentCustomTool, AgentSkill } from '@shared/types'
import { Btn, Field, NumberInput, Section, SecretInput, Segmented, TestRow, Toggle } from '../ui'
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
  const [custom, setCustom] = useState<AgentCustomTool[]>([])
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const [t, r, c, sk] = await Promise.all([
      window.bwu.agentTools.list(),
      window.bwu.agentTools.runs(),
      window.bwu.agentTools.customList(),
      window.bwu.agentSkills.list()
    ])
    setTools(t)
    setRuns(r)
    setCustom(c)
    setSkills(sk)
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

  const importTool = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const r = await window.bwu.agentTools.importCustom()
      if (r && !r.ok) setErr(r.error ?? '导入失败')
      if (r?.ok) await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const trustTool = async (id: string, trusted: boolean): Promise<void> => {
    setCustom(await window.bwu.agentTools.trustCustom(id, trusted))
    // 信任状态会改变注册表，内置工具列表也要跟着刷新
    setTools(await window.bwu.agentTools.list())
  }

  const removeTool = async (id: string): Promise<void> => {
    if (!confirm(`删除工具「${id}」？会把它从工具目录里删掉。`)) return
    setCustom(await window.bwu.agentTools.deleteCustom(id))
    setTools(await window.bwu.agentTools.list())
  }

  const importSkill = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const r = await window.bwu.agentSkills.import()
      if (r && !r.ok) setErr(r.error ?? '导入失败')
      if (r?.ok) setSkills(await window.bwu.agentSkills.list())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeSkill = async (id: string): Promise<void> => {
    if (!confirm(`删除技能「${id}」？`)) return
    setSkills(await window.bwu.agentSkills.remove(id))
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
          hint="这是总开关：开启后不再逐次确认（下面工具列表里的「执行 PowerShell」只管这个工具开不开）"
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

      <Section title="工具" desc="关掉不想让 Agent 使用的工具；带「自定义」标记的是导入的工具。">
        <div className="agent-tools">
          {tools.map((t) => (
            <div className="agent-tool" key={t.id}>
              <div className="agent-tool__main">
                <span className="agent-tool__name">{t.name}</span>
                <span className="agent-tool__id">{t.id}</span>
                <span className={t.risk === 'high' ? 'agent-tool__risk is-high' : 'agent-tool__risk'}>
                  {t.id === 'shell.ps'
                    ? shellOn
                      ? '已信任'
                      : '需确认'
                    : t.risk === 'high'
                      ? '需确认'
                      : '只读'}
                </span>
              </div>
              <Toggle checked={t.enabled} onChange={(v) => toggleTool(t.id, v)} />
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="自定义工具"
        desc="从目录导入（manifest.json + index.js）。工具代码会在你的电脑上运行，只导入你信任的来源。"
      >
        <div className="agent-tools">
          {custom.length === 0 ? (
            <span className="agent-empty">还没有导入工具，可以先点「打开工具目录」看示例</span>
          ) : (
            custom.map((t) => (
              <div className="agent-tool" key={t.id}>
                <div className="agent-tool__main">
                  <span className="agent-tool__name">{t.name}</span>
                  <span className="agent-tool__id">{t.id}</span>
                  <span className="agent-tool__risk">
                    {t.permissions.length ? t.permissions.join(' · ') : '无需额外权限'}
                  </span>
                  <span className={t.trusted ? 'agent-tool__risk is-trusted' : 'agent-tool__risk is-high'}>
                    {t.trusted ? '已信任' : '未信任'}
                  </span>
                </div>
                <div className="agent-tool__side">
                  <Toggle checked={t.trusted} onChange={(v) => void trustTool(t.id, v)} />
                  <button className="agent-dir__del" onClick={() => void removeTool(t.id)} title="删除">
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        {err ? <p className="agent-warn">{err}</p> : null}
        {custom.some((t) => !t.trusted) ? (
          <p className="agent-warn">
            未信任的工具不会注册给模型。勾选「信任」等于允许它在你的电脑上执行代码。
          </p>
        ) : null}
        <div className="agent-actions">
          <Btn onClick={() => void importTool()} disabled={busy}>
            导入工具…
          </Btn>
          <Btn onClick={() => void window.bwu.agentTools.openDir()}>打开工具目录</Btn>
        </div>
      </Section>

      <Section
        title="Skill"
        desc="把「什么时候用 + 具体步骤」写成 SKILL.md 导入。模型平时只看到名字和简介，需要时才读全文。"
      >
        <Field label="启用技能" hint="关闭后不会把技能列表放进提示词，skill.read 也不可用">
          <Toggle
            checked={s.agent.skillsEnabled}
            onChange={(v) => patch({ agent: { skillsEnabled: v } })}
          />
        </Field>
        <div className="agent-tools">
          {skills.length === 0 ? (
            <span className="agent-empty">还没有技能，可以点「打开技能目录」看示例</span>
          ) : (
            skills.map((k) => (
              <div className="agent-tool" key={k.id}>
                <div className="agent-tool__main">
                  <span className="agent-tool__name">{k.name}</span>
                  <span className="agent-tool__desc" title={k.description}>
                    {k.whenToUse || k.description || '（没有简介）'}
                  </span>
                </div>
                <div className="agent-tool__side">
                  <button className="agent-dir__del" onClick={() => void removeSkill(k.id)} title="删除">
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="agent-actions">
          <Btn onClick={() => void importSkill()} disabled={busy}>
            导入技能…
          </Btn>
          <Btn onClick={() => void window.bwu.agentSkills.openDir()}>打开技能目录</Btn>
        </div>
      </Section>

      <Section
        title="联网搜索"
        desc="让 Agent 查实时信息（新闻、赛事、价格、版本）。按成功次数计费，搜不到不收费。"
      >
        <Field label="启用联网搜索" hint="关掉后 web.search 会引导用户去打开">
          <Toggle
            checked={s.search.enabled}
            onChange={(v) => patch({ search: { enabled: v } }, true)}
          />
        </Field>
        <Field label="服务商" hint="DeepSeek 的 Key 可以和对话共用">
          <Segmented
            value={s.search.provider}
            options={[
              { value: 'tavily' as const, label: 'Tavily' },
              { value: 'deepseek' as const, label: 'DeepSeek Search' }
            ]}
            onChange={(v) => patch({ search: { provider: v } }, true)}
          />
        </Field>

        {s.search.provider === 'tavily' ? (
          <Field label="Tavily API Key" hint="app.tavily.com 里创建">
            <SecretInput
              path="search.tavilyApiKey"
              saved={s.secretSet['search.tavilyApiKey']}
              onSave={(v) => patch({ search: { tavilyApiKey: v } }, true)}
              onClear={() => patch({ clearSecrets: ['search.tavilyApiKey'] }, true)}
            />
          </Field>
        ) : (
          <Field label="DeepSeek API Key" hint="和「大模型」里那个是同一个">
            <SecretInput
              path="search.deepseekApiKey"
              saved={s.secretSet['search.deepseekApiKey']}
              onSave={(v) => patch({ search: { deepseekApiKey: v } }, true)}
              onClear={() => patch({ clearSecrets: ['search.deepseekApiKey'] }, true)}
            />
          </Field>
        )}

        <Field label="每次返回" hint="条数越多越费 token">
          <NumberInput
            value={s.search.maxResults}
            min={1}
            max={10}
            onChange={(v) => patch({ search: { maxResults: Math.max(1, Math.min(10, v)) } })}
            suffix="条"
          />
        </Field>

        <div className="field field--wide">
          <TestRow label="试搜一下" onTest={() => window.bwu.searchTest('今天的热点新闻')} />
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
