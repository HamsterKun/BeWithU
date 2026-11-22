import { useEffect, useState } from 'react'
import type { DshConnectionInfo, TestResult } from '@shared/types'
import { Btn, Field, Section, Select, Toggle } from '../ui'
import type { PaneProps } from './types'

export default function DshPane({ s, patch }: PaneProps): React.ReactElement {
  const [connection, setConnection] = useState<DshConnectionInfo | null>(null)
  const [installation, setInstallation] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      setConnection(await window.bwu.settings.dshSessions())
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { void refresh() }, [])

  const install = async (): Promise<void> => {
    setBusy(true)
    try {
      setInstallation(await window.bwu.settings.installDsh())
    } finally {
      setBusy(false)
    }
  }

  const options = [
    { value: '', label: 'BeWithU 专用对话' },
    ...(connection?.sessions ?? []).map((session) => ({
      value: session.id,
      label: `${session.title || '新会话'}${session.cwd ? ' · ' + session.cwd : ''}${session.running ? ' · 正在运行' : ''}`
    }))
  ]
  if (s.dsh.sessionId && !options.some((entry) => entry.value === s.dsh.sessionId)) {
    options.push({ value: s.dsh.sessionId, label: '已选对话暂不可用' })
  }

  return (
    <Section title="DSH模式" desc="开启DSH模式后将停用内置的所有Harness功能，将对话全部转发到当前电脑正在运行中的DSH处理后返回结果">
      <Field label="启用 DSH 模式">
        <Toggle checked={s.dsh.enabled} onChange={(enabled) => patch({ dsh: { enabled } }, true)} />
      </Field>
      <Field label="DSH 对话" hint="可以选择 DSH 中已有的对话，继续使用它的上下文">
        <Select value={s.dsh.sessionId} options={options}
          onChange={(sessionId) => patch({ dsh: { sessionId } }, true)} />
      </Field>
      <Field label="连接状态" hint={connection?.message ?? '正在检查连接…'}>
        <Btn disabled={busy} onClick={() => void refresh()}>刷新对话列表</Btn>
      </Field>
      <Field label="连接组件" hint={installation?.message ?? '首次使用时安装组件，然后重启 DeepSeek Harness'}>
        <Btn disabled={busy} onClick={() => void install()}>安装连接组件</Btn>
      </Field>
    </Section>
  )
}
