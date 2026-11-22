import { useCallback, useEffect, useState } from 'react'
import type { AgentCustomTool, AgentSkill, McpServerConfig } from '@shared/types'
import { Btn, Field, Section, Select, TextInput, Toggle } from '../ui'
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
  durationMs?: number
  argsKeys?: string[]
  summaryBytes?: number
  summary?: string
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
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([])
  const [mcpStatus, setMcpStatus] = useState<Record<string, { ok: boolean; message: string; tools?: string[] }>>({})
  const [mcpForm, setMcpForm] = useState({
    name: '',
    transport: 'stdio' as 'stdio' | 'http',
    command: '',
    args: '',
    url: '',
    headers: ''
  })

  const refresh = useCallback(async (): Promise<void> => {
    const [t, r, c, sk, mcp] = await Promise.all([
      window.bwu.agentTools.list(),
      window.bwu.agentTools.runs(),
      window.bwu.agentTools.customList(),
      window.bwu.agentSkills.list(),
      window.bwu.mcp.list()
    ])
    setTools(t)
    setRuns(r)
    setCustom(c)
    setSkills(sk)
    setMcpServers(mcp)
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

  const importToolZip = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const r = await window.bwu.agentTools.importCustomZip()
      if (r && !r.ok) setErr(r.error ?? '导入失败')
      if (r?.ok) await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const importSkillZip = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const r = await window.bwu.agentSkills.importZip()
      if (r && !r.ok) setErr(r.error ?? '导入失败')
      if (r?.ok) setSkills(await window.bwu.agentSkills.list())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const addMcp = async (): Promise<void> => {
    setBusy(true)
    try {
      setMcpServers(await window.bwu.mcp.add(mcpForm))
      setMcpForm({ name: '', transport: 'stdio', command: '', args: '', url: '', headers: '' })
    } finally {
      setBusy(false)
    }
  }

  const removeMcp = async (id: string): Promise<void> => {
    if (!confirm('删除这个 MCP 服务器？')) return
    setMcpServers(await window.bwu.mcp.remove(id))
    setMcpStatus((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const testMcp = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.bwu.mcp.test(id)
      setMcpStatus((prev) => ({ ...prev, [id]: r }))
      if (r.ok) setTools(await window.bwu.agentTools.list())
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
          label="完全信任模式"
          hint="开启后内置高风险工具不再逐次确认；MCP 远端工具仍逐次确认，危险命令检查只是补充，不是安全隔离"
        >
          <Toggle checked={shellOn} onChange={(v) => patch({ agent: { shellEnabled: v } })} />
        </Field>
        {shellOn ? (
          <p className="agent-warn">
            已开启内置工具免确认：模型可以直接改文件、执行 PowerShell、操作键鼠。远端 MCP 调用仍需逐次确认。
            不确定模型靠不靠谱时，建议用完就关掉。
          </p>
        ) : null}
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
                <span
                  className={
                    t.risk === 'high' && (!shellOn || t.id.startsWith('mcp.')) ? 'agent-tool__risk is-high' : 'agent-tool__risk is-trusted'
                  }
                >
                  {t.risk === 'high' ? (shellOn && !t.id.startsWith('mcp.') ? '免确认' : '需确认') : '低风险'}
                </span>
              </div>
              <Toggle checked={t.enabled} onChange={(v) => toggleTool(t.id, v)} />
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="自定义工具"
        desc="从目录导入（manifest.json + index.js）。自定义工具以完整 Node 子进程运行，拥有当前用户权限；这里的权限声明不会限制子进程本身。"
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
            未信任的工具不会注册给模型。勾选「信任」等于允许任意工具代码以当前用户权限执行；permissions 只是 API 的声明/提示，不是操作系统沙箱。
          </p>
        ) : null}
        <div className="agent-actions">
          <Btn onClick={() => void importToolZip()} disabled={busy}>
            导入压缩包…
          </Btn>
          <Btn onClick={() => void importTool()} disabled={busy}>
            从目录导入…
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
          <Btn onClick={() => void importSkillZip()} disabled={busy}>
            导入压缩包…
          </Btn>
          <Btn onClick={() => void importSkill()} disabled={busy}>
            从目录导入…
          </Btn>
          <Btn onClick={() => void window.bwu.agentSkills.openDir()}>打开技能目录</Btn>
        </div>
      </Section>

      <Section
        title="MCP 服务器"
        desc="接入外部 MCP 服务（文件系统、数据库、浏览器等），它们的工具会自动注册给 Agent。"
      >
        <div className="agent-tools">
          {mcpServers.length === 0 ? (
            <span className="agent-empty">还没有 MCP 服务器</span>
          ) : (
            mcpServers.map((srv) => (
              <div className="agent-tool" key={srv.id}>
                <div className="agent-tool__main">
                  <span className="agent-tool__name">{srv.name}</span>
                  <span className="agent-tool__id">
                    {srv.transport === 'http' ? srv.url : `${srv.command} ${srv.args}`.trim()}
                  </span>
                  {srv.headersConfigured ? <span className="agent-tool__risk">请求头已配置</span> : null}
                  {mcpStatus[srv.id] ? (
                    <span className={mcpStatus[srv.id].ok ? 'agent-tool__risk is-trusted' : 'agent-tool__risk is-high'}>
                      {mcpStatus[srv.id].ok ? `已连接 · ${mcpStatus[srv.id].tools?.length ?? 0}` : '连接失败'}
                    </span>
                  ) : null}
                </div>
                <div className="agent-tool__side">
                  <Btn onClick={() => void testMcp(srv.id)} disabled={busy}>
                    测试
                  </Btn>
                  <Toggle
                    checked={srv.enabled}
                    onChange={(v) => patch({ mcp: { servers: mcpServers.map((x) => (x.id === srv.id ? { ...x, enabled: v } : x)) } }, true)}
                  />
                  <button className="agent-dir__del" onClick={() => void removeMcp(srv.id)} title="删除">
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <Field label="新增服务器" hint="stdio 填命令（如 npx），http 填地址">
          <div className="stack">
            <TextInput value={mcpForm.name} placeholder="名称，例如 文件系统" onChange={(v) => setMcpForm({ ...mcpForm, name: v })} />
            <Select
              value={mcpForm.transport}
              options={[
                { value: 'stdio', label: 'stdio（本地进程）' },
                { value: 'http', label: 'HTTP（远程）' }
              ]}
              onChange={(v) => setMcpForm({ ...mcpForm, transport: v as 'stdio' | 'http' })}
            />
            {mcpForm.transport === 'stdio' ? (
              <>
                <TextInput
                  value={mcpForm.command}
                  placeholder="命令，例如 npx"
                  onChange={(v) => setMcpForm({ ...mcpForm, command: v })}
                />
                <TextInput
                  value={mcpForm.args}
                  placeholder="参数，例如 -y @modelcontextprotocol/server-filesystem C:\docs"
                  onChange={(v) => setMcpForm({ ...mcpForm, args: v })}
                />
              </>
            ) : (
              <>
                <TextInput
                  value={mcpForm.url}
                  placeholder="https://example.com/mcp"
                  onChange={(v) => setMcpForm({ ...mcpForm, url: v })}
                />
                <TextInput
                  value={mcpForm.headers}
                  placeholder="请求头，每行一个 Key: Value（可留空）"
                  onChange={(v) => setMcpForm({ ...mcpForm, headers: v })}
                />
              </>
            )}
            <div>
              <Btn onClick={() => void addMcp()} disabled={busy || (!mcpForm.command && !mcpForm.url)}>
                添加
              </Btn>
            </div>
          </div>
        </Field>

        <p className="agent-warn">
          MCP 服务器的工具会在每次任务开始前自动拉取；连不上只是跳过，不会卡住任务。远程服务请自己确认来源可信。
        </p>
      </Section>

      <Section title="运行记录" desc="最近 50 次工具调用；日志按天保存，只保留 7 天。">
        <Field label="记录调用" hint="关掉后不再写审计日志">
          <Toggle checked={s.agent.audit} onChange={(v) => patch({ agent: { audit: v } })} />
        </Field>
        <Field
          label="详细审计"
          hint="默认只记工具、成败、耗时和参数名；打开后才写结果摘要与参数值（密钥类字段会打码）"
        >
          <Toggle
            checked={s.agent.auditDetail}
            onChange={(v) => patch({ agent: { auditDetail: v } })}
          />
        </Field>
        <div className="agent-runs">
          {runs.length === 0 ? (
            <span className="agent-empty">还没有调用记录</span>
          ) : (
            runs.map((r, i) => (
              <div className="agent-run" key={`${r.at}-${i}`}>
                <span className="agent-run__time">{timeText(r.at)}</span>
                <span className={r.ok ? 'agent-run__ok' : 'agent-run__fail'}>{r.ok ? '✓' : '✗'}</span>
                <span className="agent-run__tool">{r.toolId}</span>
                <span className="agent-run__text" title={r.summary ?? ''}>
                  {r.summary
                    ? r.summary.replace(/\s+/g, ' ').slice(0, 80)
                    : `仅元数据 · ${r.argsKeys?.join(', ') || '无参数'}${r.durationMs ? ` · ${r.durationMs}ms` : ''}`}
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
