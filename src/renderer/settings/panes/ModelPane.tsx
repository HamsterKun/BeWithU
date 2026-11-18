import { useEffect, useState } from 'react'
import { LLM_PRESETS } from '@shared/presets'
import type { LlmPreset, MemoryInfo } from '@shared/types'
import { Btn, Field, NumberInput, Range, SecretInput, Section, Select, TestRow, TextInput, Toggle } from '../ui'
import type { PaneProps } from './types'

export default function ModelPane({ s, patch }: PaneProps): React.ReactElement {
  const [mem, setMem] = useState<MemoryInfo | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [shot, setShot] = useState('')
  const [shotMsg, setShotMsg] = useState('')
  const [shotBusy, setShotBusy] = useState(false)

  const testShot = async (): Promise<void> => {
    setShotBusy(true)
    setShotMsg('')
    try {
      const r = await window.bwu.settings.captureTest()
      if (r.ok) {
        setShot(r.dataUrl)
        setShotMsg(`已截取：${r.displayLabel}`)
      } else {
        setShotMsg(r.message)
      }
    } catch (e) {
      setShotMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setShotBusy(false)
    }
  }

  const refreshMem = (): void => {
    void window.bwu.settings.memoryInfo().then(setMem)
  }

  const runSummarize = async (): Promise<void> => {
    setBusy(true)
    setResult('')
    try {
      const r = await window.bwu.settings.summarizeNow()
      setResult(r.message)
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      refreshMem()
    }
  }

  useEffect(() => {
    refreshMem()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.llm.historyTurns, s.llm.summary.enabled])

  const summaryText = mem?.summary ?? ''

  return (
    <>
      <Section title="大模型" desc="接入你自己的 AI 服务，支持主流服务商与本地模型">
        <Field label="服务商" hint="选择后自动填入地址和模型">
          <Select
            value={s.llm.preset}
            options={LLM_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(v) => {
              const def = LLM_PRESETS.find((p) => p.id === v)
              patch({
                llm: {
                  preset: v as LlmPreset,
                  baseUrl: def?.baseUrl || s.llm.baseUrl,
                  model: def?.model || s.llm.model
                }
              })
            }}
          />
        </Field>

        <Field label="Base URL" hint="一般以 /v1 结尾">
          <TextInput
            mono
            value={s.llm.baseUrl}
            placeholder="https://ark.cn-beijing.volces.com/api/v3"
            onChange={(v) => patch({ llm: { baseUrl: v } })}
          />
        </Field>

        <Field label="API Key">
          <SecretInput
            path="llm.apiKey"
            saved={s.secretSet['llm.apiKey']}
            placeholder="sk-..."
            onSave={(v) => patch({ llm: { apiKey: v } }, true)}
            onClear={() => patch({ clearSecrets: ['llm.apiKey'] }, true)}
          />
        </Field>

        <Field label="模型名" hint={s.llm.preset === 'ark' ? '接入点 ID，以 ep- 开头' : '填写模型名称'}>
          <TextInput
            mono
            value={s.llm.model}
            placeholder="doubao-seed-1.6-flash"
            onChange={(v) => patch({ llm: { model: v } })}
          />
        </Field>

        <Field label="温度" hint="越高越自由发挥，建议 0.7~0.9">
          <Range
            value={s.llm.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => patch({ llm: { temperature: v } })}
            format={(v) => v.toFixed(2)}
          />
        </Field>

        <Field label="记忆轮数" hint="设为 0 则不记上下文">
          <NumberInput
            value={s.llm.historyTurns}
            min={0}
            max={50}
            onChange={(v) => patch({ llm: { historyTurns: v } })}
            suffix="轮"
          />
        </Field>

        <div className="field field--wide">
          <TestRow label="测试连接" onTest={() => window.bwu.settings.testLlm()} />
        </div>
      </Section>

      <Section title="屏幕理解" desc="让 TA 看见你的屏幕，回答更贴合当前画面">
        <Field label="开启截屏" hint="看敏感内容时建议先关闭">
          <Toggle
            checked={s.llm.vision.enabled}
            onChange={(v) => patch({ llm: { vision: { enabled: v } } }, true)}
          />
        </Field>

        <Field label="截图预览">
          <div className="stack">
            <Btn onClick={() => void testShot()} disabled={shotBusy}>
              {shotBusy ? '截取中…' : '试截一张'}
            </Btn>
            {shotMsg ? <span className="muted small">{shotMsg}</span> : null}
          </div>
        </Field>

        {shot ? <img className="shot-preview" src={shot} alt="屏幕截图预览" /> : null}

        <div className="tipbox">
          只截取鼠标所在的那块屏幕，画面仅发送给你自己配置的 AI 服务。
          独占全屏的游戏可能截不到画面，改成「无边框窗口」即可。
        </div>
      </Section>

      <Section
        title="对话记忆"
        desc={
          s.llm.historyTurns > 0
            ? `超过 ${s.llm.historyTurns} 轮后自动整理成记忆，之后每次对话都会带上`
            : '记忆轮数为 0，不会保存上下文'
        }
      >
        <Field label="当前记忆" hint="自动生成，不可编辑">
          <div className="stack">
            <span className="muted small">
              {summaryText
                ? `${summaryText.length} 字 · 更新于 ${new Date(mem?.updatedAt ?? 0).toLocaleString()}`
                : '还没有记忆'}
              {mem ? ` · 待整理 ${mem.pending}/${mem.threshold}` : ''}
            </span>
            <Btn onClick={refreshMem}>刷新</Btn>
            <Btn onClick={() => setShowSummary((v) => !v)}>{showSummary ? '收起' : '查看'}</Btn>
            <Btn onClick={() => void runSummarize()} disabled={busy}>
              {busy ? '整理中…' : '立即整理'}
            </Btn>
          </div>
          {result ? <span className="muted small">{result}</span> : null}
        </Field>
        {showSummary ? <div className="summary-box">{summaryText || '（空）'}</div> : null}

        <Field label="专用总结模型" hint="建议选快速、便宜的模型">
          <Toggle
            checked={s.llm.summary.enabled}
            onChange={(v) => patch({ llm: { summary: { enabled: v } } }, true)}
          />
        </Field>

        {s.llm.summary.enabled ? (
          <>
            <Field label="Base URL">
              <TextInput
                mono
                value={s.llm.summary.baseUrl}
                placeholder={s.llm.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3'}
                onChange={(v) => patch({ llm: { summary: { baseUrl: v } } })}
              />
            </Field>
            <Field label="API Key" hint="留空则使用上面的 Key">
              <SecretInput
                path="llm.summary.apiKey"
                saved={s.secretSet['llm.summary.apiKey']}
                placeholder="sk-..."
                onSave={(v) => patch({ llm: { summary: { apiKey: v } } }, true)}
                onClear={() => patch({ clearSecrets: ['llm.summary.apiKey'] }, true)}
              />
            </Field>
            <Field label="模型名" hint="填一个更轻量的模型">
              <TextInput
                mono
                value={s.llm.summary.model}
                placeholder="doubao-seed-1.6-flash"
                onChange={(v) => patch({ llm: { summary: { model: v } } })}
              />
            </Field>
          </>
        ) : (
          <div className="tipbox">
            <strong>不开启也可以</strong>
            会使用上面的对话模型来整理记忆。
          </div>
        )}

        <div className="tipbox">
          记忆只保存在本机。点气泡里的「清空上下文」会同时清掉对话和记忆。
        </div>
      </Section>
    </>
  )
}
