import { useEffect, useState } from 'react'
import type { AppInfo, DataDirInfo, UsageSummary } from '@shared/types'
import { Btn, Section } from '../ui'
import type { PaneProps } from './types'

function fmt(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : n.toLocaleString()
}

export default function AboutPane({ s }: PaneProps): React.ReactElement {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [dir, setDir] = useState<DataDirInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [usage, setUsage] = useState<UsageSummary | null>(null)

  const refresh = (): void => {
    void window.bwu.settings.appInfo().then(setInfo)
    void window.bwu.settings.dataDirInfo().then(setDir)
    void window.bwu.usageStats().then(setUsage)
  }

  useEffect(() => {
    refresh()
  }, [])

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
    if (!confirm('把数据搬回系统默认目录（C 盘）？设置、密钥、历史、本地模型都会一起搬过去。')) return
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

  return (
    <>
      <Section title="关于" desc="BeWithU · 桌面 AI 语音陪伴伙伴">
        <div className="kv">
          <span>版本</span>
          <b>{info?.version ?? '—'}</b>
        </div>
        <div className="kv">
          <span>开麦键</span>
          <b>{info?.hotkeyPretty ?? s.voice.hotkey}</b>
        </div>
        <div className="kv">
          <span>按键监听</span>
          <b className={info?.hotkeyActive ? 'ok' : 'warn'}>
            {info ? (info.hotkeyActive ? '正常' : (info.hotkeyMessage ?? '未启动')) : '—'}
          </b>
        </div>
        <div className="kv">
          <span>本机加密</span>
          <b className={info?.secureStorage ? 'ok' : 'warn'}>
            {info ? (info.secureStorage ? '可用（密钥、历史与记忆已加密）' : '不可用（历史与记忆将明文保存）') : '—'}
          </b>
        </div>
        <div className="kv">
          <span>语音识别</span>
          <b>{s.asr.mode === 'local' ? '本地' : '火山引擎'}</b>
        </div>
        <div className="kv">
          <span>语音合成</span>
          <b>
            {s.tts.enabled
              ? `已开启 · ${s.tts.provider === 'breeze' ? 'Breeze' : '火山引擎'}`
              : '已关闭'}
          </b>
        </div>
        <div className="row-actions">
          <Btn onClick={() => void window.bwu.settings.restartHotkey()}>重新检测按键</Btn>
        </div>
      </Section>

      <Section title="数据目录" desc="设置、密钥、对话历史、长期记忆和本地识别模型都存在这里">
        <div className="kv">
          <span>当前目录</span>
          <b className="mono">{dir?.dir ?? info?.userData ?? '—'}</b>
        </div>
        <div className="kv">
          <span>占用</span>
          <b>
            {dir ? `${dir.sizeMB} MB` : '—'}
            {dir?.custom ? <span className="badge badge--ok" style={{ marginLeft: 8 }}>自定义</span> : null}
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
          更改目录后会自动重启，设置、密钥、历史和记忆都会一起带到新位置。
        </div>
      </Section>

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
              label: '记忆总结模型',
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
          <Btn onClick={() => refresh()}>刷新</Btn>
          <Btn
            variant="danger"
            onClick={() => {
              if (confirm('清空本机用量统计？')) void window.bwu.clearUsage().then(setUsage)
            }}
          >
            清零
          </Btn>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          统计口径：对话/总结按接口返回的 token；TTS 按合成字数；云端识别按音频时长。TTS 与语音识别若是本地模式则不产生费用。
        </p>
      </Section>

      <Section title="隐私" desc="所有密钥都只存在这台电脑上">
        <div className="tipbox">
          密钥加密保存在本机，不会上传到任何服务器。对话记录与记忆同样只存在本机，可以随时清空。
        </div>
      </Section>

      <Section title="危险操作" desc="">
        <Btn
          variant="danger"
          onClick={() => {
            if (confirm('恢复所有设置为默认值？API Key 会保留。')) {
              void window.bwu.settings.reset().then(() => window.location.reload())
            }
          }}
        >
          恢复全部默认设置
        </Btn>
      </Section>
    </>
  )
}
