import { useEffect, useState } from 'react'
import { DEFAULT_SYSTEM_PROMPT } from '@shared/defaults'
import { PROMPT_TEMPLATES } from '@shared/presets'
import { Btn, Field, Section, TextArea, TextInput } from '../ui'
import type { PaneProps } from './types'

export default function PromptPane({ s, patch }: PaneProps): React.ReactElement {
  const text = s.llm.systemPrompt
  // 名字用本地状态，失焦时才提交：避免边打字边改写提示词，也避免清空时被弹回默认值
  const [name, setName] = useState(s.ui.assistantName)
  useEffect(() => {
    setName(s.ui.assistantName)
  }, [s.ui.assistantName])

  const commitName = (): void => {
    const next = name.trim()
    if (next !== (s.ui.assistantName || '')) patch({ ui: { assistantName: next } }, true)
  }

  return (
    <>
      <Section title="角色" desc="决定 TA 怎么称呼自己；留空则显示为 TA">
        <Field label="TA 的名字">
          <TextInput
            value={name}
            placeholder="留空则显示为 TA"
            onChange={setName}
            onBlur={commitName}
          />
        </Field>
      </Section>

      <Section title="系统提示词" desc="决定 TA 的性格、说话方式和回复长度，改完立即生效">
        <div className="prompt-toolbar">
          {PROMPT_TEMPLATES.map((t) => (
            <button key={t.id} className="chip" onClick={() => patch({ llm: { systemPrompt: t.text } }, true)}>
              {t.label}
            </button>
          ))}
        </div>
        <TextArea
          value={text}
          rows={14}
          placeholder="你是……"
          onChange={(v) => patch({ llm: { systemPrompt: v } })}
        />
        <div className="prompt-foot">
          <span className="muted">{text.length} 字</span>
          <div className="prompt-foot__actions">
            <Btn onClick={() => patch({ llm: { systemPrompt: DEFAULT_SYSTEM_PROMPT } }, true)}>恢复默认</Btn>
            <Btn
              variant="danger"
              onClick={() => {
                if (confirm('清空本机保存的对话历史？')) void window.bwu.settings.clearHistory()
              }}
            >
              清空对话历史
            </Btn>
          </div>
        </div>
      </Section>

      <Section title="写好提示词" desc="">
        <div className="tipbox">
          <strong>1 · 说清长度</strong>
          写「回答 2-3 句、80 字以内」，否则念出来会很啰嗦。
          <br />
          <strong>2 · 不要格式</strong>
          写明「不要表情、不要装饰符号」，读起来更自然。
          <br />
          <strong>3 · 给点背景</strong>
          告诉 TA 你在玩什么、想要什么风格，比堆形容词有效。
        </div>
      </Section>
    </>
  )
}
