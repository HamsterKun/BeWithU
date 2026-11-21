import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { Btn, Field, Section, Toggle } from '../ui'
import type { PaneProps } from './types'

export default function AboutPane({ s, patch }: PaneProps): React.ReactElement {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [starMsg, setStarMsg] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkMsg, setCheckMsg] = useState('')

  const refresh = (): void => {
    void window.bwu.settings.appInfo().then(setInfo)
  }

  useEffect(() => {
    refresh()
  }, [])

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    setCheckMsg('')
    try {
      const r = await window.bwu.update.check()
      if (r.kind === 'available') setCheckMsg(`发现新版本 ${r.version ?? ''}，看左下角的横幅`)
      else if (r.kind === 'ready') setCheckMsg('新版本已下载好，重启即可')
      else if (r.kind === 'error') setCheckMsg(r.message ?? '检查失败')
      else setCheckMsg('已经是最新版本')
    } catch (e) {
      setCheckMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  const openRepo = async (): Promise<void> => {
    try {
      await window.bwu.openRepo()
    } catch (e) {
      setStarMsg(e instanceof Error ? e.message : String(e))
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
            {info
              ? info.secureStorage
                ? '可用（密钥、对话与摘要已加密）'
                : '不可用（对话与摘要将明文保存）'
              : '—'}
          </b>
        </div>
        <div className="kv">
          <span>语音识别</span>
          <b>{s.asr.mode === 'local' ? '本地' : '火山引擎'}</b>
        </div>
        <div className="kv">
          <span>语音合成</span>
          <b>
            {s.tts.enabled ? `已开启 · ${s.tts.provider === 'breeze' ? 'Breeze' : '火山引擎'}` : '已关闭'}
          </b>
        </div>
        {info?.portable ? (
          <Field label="开机自启动" hint="便携版每次解压到临时目录，无法注册开机启动">
            <span className="muted small">不可用</span>
          </Field>
        ) : (
          <Field label="开机自启动" hint="登录 Windows 后请求管理员授权，确认后启动">
            <Toggle
              checked={s.ui.autoLaunch}
              onChange={(v) => patch({ ui: { autoLaunch: v } }, true)}
            />
          </Field>
        )}

        <div className="row-actions">
          <Btn onClick={() => void window.bwu.settings.restartHotkey()}>重新检测按键</Btn>
          <Btn onClick={() => void checkNow()} disabled={checking}>
            {checking ? '检查中…' : '检查更新'}
          </Btn>
        </div>
        {checkMsg ? <span className="muted small">{checkMsg}</span> : null}
      </Section>

      <Section title="项目主页" desc="开源在自己的 GitHub 上，欢迎来看代码、提问题">
        <div className="repo-card">
          <div className="repo-card__main">
            <span className="repo-card__icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="18" height="18">
                <path
                  fill="currentColor"
                  d="M8 .9l2.06 4.36 4.69.62-3.45 3.3.86 4.7L8 11.6l-4.16 2.28.86-4.7L1.25 5.88l4.69-.62zm0 2.4L6.66 6.13l-2.9.38 2.13 2.04-.53 2.9L8 10.04l2.64 1.41-.53-2.9 2.13-2.04-2.9-.38z"
                />
              </svg>
            </span>
            <div className="repo-card__text">
              <b>HamsterKun / BeWithU</b>
              <p className="muted small">
                喜欢的话给我们一颗星星吧，一颗星就是一次“继续做下去”的理由。
              </p>
            </div>
          </div>
          <Btn variant="primary" onClick={() => void openRepo()}>
            去 GitHub 点星
          </Btn>
        </div>
        {starMsg ? <div className="tipbox">{starMsg}</div> : null}
        <div className="tipbox">
          遇到问题先去 Issues 搜一下；提问题时带上「数据与日志」页的日志片段会快很多。
        </div>
      </Section>

      <Section title="隐私" desc="所有密钥都只存在这台电脑上">
        <div className="tipbox">
          密钥加密保存在本机，不会上传到任何服务器。对话记录与上下文摘要同样只存在本机，可以随时清空。
        </div>
      </Section>

      <Section title="危险操作" desc="">
        <Btn
          variant="danger"
          onClick={() => {
            if (window.confirm('恢复所有设置为默认值？API Key 会保留。')) {
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
