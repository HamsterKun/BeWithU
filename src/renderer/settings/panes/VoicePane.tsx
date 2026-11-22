import { useEffect, useState } from 'react'
import type { AsrModelProgress } from '@shared/types'
import { Btn, Field, Range, SecretInput, Section, Segmented, Select, TestRow, TextInput, Toggle } from '../ui'
import { VoicePicker } from '../VoicePicker'
import type { PaneProps } from './types'

const RESOURCE_IDS = [
  { value: 'seed-tts-2.0', label: '标准音色 2.0（推荐）' },
  { value: 'volc.service_type.10029', label: '标准音色 1.0' },
  { value: 'volc.service_type.10048', label: '声音复刻 1.0' },
  { value: 'seed-icl-2.0', label: '声音复刻 2.0' }
]

const LANGS = [
  { value: 'zh-CN', label: '中文普通话' },
  { value: 'en-US', label: '英语' },
  { value: 'yue-CN', label: '粤语' },
  { value: 'ja-JP', label: '日语' }
]

const ASR_RESOURCES = [
  { value: 'volc.seedasr.sauc.duration', label: '流式语音识别 2.0 · 小时版（推荐）' },
  { value: 'volc.seedasr.sauc.concurrent', label: '流式语音识别 2.0 · 并发版' },
  { value: 'volc.bigasr.sauc.duration', label: '流式语音识别 1.0 · 小时版' },
  { value: 'volc.bigasr.sauc.concurrent', label: '流式语音识别 1.0 · 并发版' }
]

const AUTH_OPTIONS = [
  { value: 'apikey' as const, label: 'API Key（新版）' },
  { value: 'console' as const, label: 'AppID + Token（旧版）' }
]

const SOVITS_LANGS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'yue', label: '粤语' }
]

function ModelStatusText(p: AsrModelProgress | null): string {
  if (!p) return '检查中…'
  if (p.state === 'ready') return '已就绪'
  if (p.state === 'downloading') {
    const pct = p.total ? Math.round((p.bytes / p.total) * 100) : 0
    const mb = (p.bytes / 1024 / 1024).toFixed(0)
    const total = (p.total / 1024 / 1024).toFixed(0)
    return `下载中 ${pct}% · ${mb}/${total}MB`
  }
  if (p.state === 'error') return '下载失败，请重试'
  return '未下载'
}

export default function VoicePane({ s, patch }: PaneProps): React.ReactElement {
  const [mics, setMics] = useState<{ id: string; label: string }[]>([])
  const [micBusy, setMicBusy] = useState(false)
  const [model, setModel] = useState<AsrModelProgress | null>(null)
  const [modelBusy, setModelBusy] = useState(false)

  const refreshMics = async (): Promise<void> => {
    setMicBusy(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const devices = await navigator.mediaDevices.enumerateDevices()
      stream.getTracks().forEach((t) => t.stop())
      setMics(
        devices
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `麦克风 ${i + 1}` }))
      )
    } catch {
      setMics([])
    } finally {
      setMicBusy(false)
    }
  }

  useEffect(() => {
    void refreshMics()
    void window.bwu.settings.asrModelStatus().then(setModel)
    return window.bwu.settings.onAsrModelProgress(setModel)
  }, [])

  const downloadModel = async (): Promise<void> => {
    setModelBusy(true)
    try {
      setModel(await window.bwu.settings.asrModelDownload())
    } finally {
      setModelBusy(false)
    }
  }

  const removeModel = async (): Promise<void> => {
    setModel(await window.bwu.settings.asrModelDelete())
  }

  /** 把语音合成的凭证复制给语音识别，省得再输一遍 */
  const reuseCredentials = async (): Promise<void> => {
    if (s.tts.authMode === 'apikey') {
      const key = await window.bwu.settings.revealSecret('tts.apiKey')
      if (key) patch({ asr: { authMode: 'apikey', apiKey: key } }, true)
      return
    }
    const token = await window.bwu.settings.revealSecret('tts.accessToken')
    if (token) patch({ asr: { authMode: 'console', appId: s.tts.appId, accessToken: token } }, true)
  }

  const cloud = s.asr.mode === 'volc'

  return (
    <>
      <Section title="语音合成" desc="开启后 TA 会出声，只需要文字陪伴时可以关闭">
        <Field label="启用语音合成" hint="关闭后只显示文字，不产生费用">
          <Toggle checked={s.tts.enabled} onChange={(v) => patch({ tts: { enabled: v } }, true)} />
        </Field>

        <div className={s.tts.enabled ? 'tts-body' : 'tts-body is-off'}>
          <Field label="服务商">
            <Segmented
              value={s.tts.provider}
              options={[
                { value: 'volc' as const, label: '火山引擎' },
                { value: 'breeze' as const, label: 'Breeze' },
                { value: 'gpt-sovits' as const, label: 'GPT-SoVITS' }
              ]}
              onChange={(v) => patch({ tts: { provider: v } }, true)}
            />
          </Field>

          {s.tts.provider === 'volc' ? (
            <>
              <Field label="凭证类型">
                <Segmented
                  value={s.tts.authMode}
                  options={AUTH_OPTIONS}
                  onChange={(v) => patch({ tts: { authMode: v } }, true)}
                />
              </Field>

              {s.tts.authMode === 'apikey' ? (
                <Field label="API Key" hint="在豆包语音控制台获取">
                  <SecretInput
                    path="tts.apiKey"
                    saved={s.secretSet['tts.apiKey']}
                    onSave={(v) => patch({ tts: { apiKey: v } }, true)}
                    onClear={() => patch({ clearSecrets: ['tts.apiKey'] }, true)}
                  />
                </Field>
              ) : (
                <>
                  <Field label="AppID">
                    <TextInput
                      mono
                      value={s.tts.appId}
                      placeholder="旧版控制台里的 AppID"
                      onChange={(v) => patch({ tts: { appId: v } })}
                    />
                  </Field>
                  <Field label="Access Token">
                    <SecretInput
                      path="tts.accessToken"
                      saved={s.secretSet['tts.accessToken']}
                      onSave={(v) => patch({ tts: { accessToken: v } }, true)}
                      onClear={() => patch({ clearSecrets: ['tts.accessToken'] }, true)}
                    />
                  </Field>
                </>
              )}

              <Field label="音色版本" hint="选择音色后自动匹配">
                <Select
                  value={s.tts.resourceId}
                  options={RESOURCE_IDS}
                  onChange={(v) => patch({ tts: { resourceId: v } })}
                />
              </Field>

              <Field label="音色" hint="可搜索，点行尾试听">
                <VoicePicker
                  speaker={s.tts.speaker}
                  onSelect={(id, rid) => patch({ tts: { speaker: id, resourceId: rid } }, true)}
                  onPreview={(id, rid) => void window.bwu.settings.previewVoice(id, rid)}
                />
              </Field>
            </>
          ) : s.tts.provider === 'breeze' ? (
            <>
              <Field label="API Key" hint="在 Breeze 控制台创建">
                <SecretInput
                  path="tts.breeze.apiKey"
                  saved={s.secretSet['tts.breeze.apiKey']}
                  onSave={(v) => patch({ tts: { breeze: { apiKey: v } } }, true)}
                  onClear={() => patch({ clearSecrets: ['tts.breeze.apiKey'] }, true)}
                />
              </Field>

              <Field label="音色 ID" hint="形如 voc_xxxxxxxx">
                <TextInput
                  mono
                  value={s.tts.breeze.voiceId}
                  placeholder="voc_xxxxxxxx"
                  onChange={(v) => patch({ tts: { breeze: { voiceId: v } } })}
                />
              </Field>

              <Field label="模型">
                <Select
                  value={s.tts.breeze.modelId}
                  options={[
                    { value: 'breeze-tts-2', label: 'breeze-tts-2（推荐）' },
                    { value: 'breeze-tts-2-multilingual', label: 'breeze-tts-2-multilingual（多语种）' }
                  ]}
                  onChange={(v) => patch({ tts: { breeze: { modelId: v } } }, true)}
                />
              </Field>

              <Field label="语言" hint="与音色、模型需匹配">
                <Select
                  value={s.tts.breeze.language}
                  options={[
                    { value: '', label: '自动' },
                    { value: 'zh', label: '中文' },
                    { value: 'en', label: '英语' },
                    { value: 'ja', label: '日语' },
                    { value: 'ko', label: '韩语' }
                  ]}
                  onChange={(v) => patch({ tts: { breeze: { language: v } } })}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="API 地址" hint="填写运行中的 GPT-SoVITS API v2 服务地址">
                <TextInput mono value={s.tts.gptSovits.baseUrl} placeholder="http://127.0.0.1:9880"
                  onChange={(baseUrl) => patch({ tts: { gptSovits: { baseUrl } } })} />
              </Field>
              <Field label="参考音频路径" hint="路径以 GPT-SoVITS 服务所在电脑为准">
                <TextInput mono value={s.tts.gptSovits.refAudioPath}
                  onChange={(refAudioPath) => patch({ tts: { gptSovits: { refAudioPath } } })} />
              </Field>
              <Field label="参考音频原文">
                <TextInput value={s.tts.gptSovits.promptText}
                  onChange={(promptText) => patch({ tts: { gptSovits: { promptText } } })} />
              </Field>
              <Field label="参考音频语种">
                <Select value={s.tts.gptSovits.promptLang} options={SOVITS_LANGS}
                  onChange={(promptLang) => patch({ tts: { gptSovits: { promptLang } } })} />
              </Field>
              <Field label="合成语种">
                <Select value={s.tts.gptSovits.textLang} options={[{ value: 'auto', label: '自动' }, ...SOVITS_LANGS]}
                  onChange={(textLang) => patch({ tts: { gptSovits: { textLang } } })} />
              </Field>
            </>
          )}

          <Field label="语速" hint="数值越大语速越快">
            <Range
              value={s.tts.speed}
              min={-50}
              max={100}
              onChange={(v) => patch({ tts: { speed: v } })}
              format={(v) => `${v > 0 ? '+' : ''}${v}`}
            />
          </Field>

          <Field label="音量" hint="只影响你听到的音量">
            <Range
              value={Math.round(s.tts.volume * 100)}
              min={0}
              max={100}
              onChange={(v) => patch({ tts: { volume: v / 100 } })}
              format={(v) => `${v}%`}
            />
          </Field>

          <div className="field field--wide">
            <TestRow label="试听一句" onTest={() => window.bwu.settings.testTts()} />
          </div>
        </div>
      </Section>

      <Section title="语音识别" desc="云端更准确，本地免费且无需开通">
        <Field label="识别模式">
          <Segmented
            value={s.asr.mode}
            options={[
              { value: 'volc' as const, label: '火山引擎识别（推荐）' },
              { value: 'local' as const, label: '本地识别（免费）' }
            ]}
            onChange={(v) => patch({ asr: { mode: v } }, true)}
          />
        </Field>

        {!cloud ? (
          <>
            <Field label="本地模型" hint="约 240MB，只需下载一次">
              <div className="stack">
                <span className={model?.state === 'error' ? 'badge badge--bad' : 'muted small'}>
                  {ModelStatusText(model)}
                </span>
                <Btn onClick={() => void downloadModel()} disabled={modelBusy || model?.state === 'downloading'}>
                  {model?.state === 'downloading' ? '下载中…' : model?.state === 'ready' ? '重新下载' : '下载模型'}
                </Btn>
                {model?.state === 'ready' ? (
                  <>
                    <Btn onClick={() => void removeModel()}>删除模型</Btn>
                    <TestRow label="检查模型" onTest={() => window.bwu.settings.asrLocalWarmup()} />
                  </>
                ) : null}
              </div>
            </Field>

            {model?.state === 'downloading' ? (
              <div className="progress">
                <div
                  className="progress__bar"
                  style={{ width: `${model.total ? Math.round((model.bytes / model.total) * 100) : 0}%` }}
                />
              </div>
            ) : null}

            <div className="tipbox">
              <strong>首次使用需要下载语音模型</strong>
              识别在你的电脑上完成，不联网、不产生费用。说完才会出字，游戏里的角色名和技能名会比云端稍差一些。
            </div>
          </>
        ) : (
          <>
            <Field label="凭证类型">
              <Segmented
                value={s.asr.authMode}
                options={AUTH_OPTIONS}
                onChange={(v) => patch({ asr: { authMode: v } }, true)}
              />
            </Field>

            {s.asr.authMode === 'apikey' ? (
              <Field label="API Key" hint="可与语音合成使用同一个 Key">
                <div className="stack stack--top">
                  <SecretInput
                    path="asr.apiKey"
                    saved={s.secretSet['asr.apiKey']}
                    onSave={(v) => patch({ asr: { apiKey: v } }, true)}
                    onClear={() => patch({ clearSecrets: ['asr.apiKey'] }, true)}
                  />
                  <Btn onClick={() => void reuseCredentials()}>填入语音合成的凭证</Btn>
                </div>
              </Field>
            ) : (
              <>
                <Field label="AppID">
                  <TextInput
                    mono
                    value={s.asr.appId}
                    placeholder="与语音合成相同即可"
                    onChange={(v) => patch({ asr: { appId: v } })}
                  />
                </Field>
                <Field label="Access Token">
                  <div className="stack stack--top">
                    <SecretInput
                      path="asr.accessToken"
                      saved={s.secretSet['asr.accessToken']}
                      onSave={(v) => patch({ asr: { accessToken: v } }, true)}
                      onClear={() => patch({ clearSecrets: ['asr.accessToken'] }, true)}
                    />
                    <Btn onClick={() => void reuseCredentials()}>填入语音合成的凭证</Btn>
                  </div>
                </Field>
              </>
            )}

            <Field label="识别版本" hint="按控制台开通的版本选择">
              <Select
                value={s.asr.resourceId}
                options={
                  ASR_RESOURCES.some((o) => o.value === s.asr.resourceId)
                    ? ASR_RESOURCES
                    : [...ASR_RESOURCES, { value: s.asr.resourceId, label: `自定义 · ${s.asr.resourceId}` }]
                }
                onChange={(v) => patch({ asr: { resourceId: v } }, true)}
              />
            </Field>

            <Field label="识别语言">
              <Select
                value={s.asr.language}
                options={LANGS}
                onChange={(v) => patch({ asr: { language: v } })}
              />
            </Field>

            <div className="field field--wide">
              <TestRow label="测试连接" onTest={() => window.bwu.settings.testAsr()} />
              <div className="tipbox">
                提示没有权限？请确认已在控制台点过「开通」，并且这里选的版本与开通的一致。
              </div>
            </div>
          </>
        )}
      </Section>

      <Section title="麦克风" desc="建议选择你正在使用的那只麦克风">
        <Field label="输入设备">
          <div className="stack">
            <Select
              value={s.ui.micDeviceId}
              options={[{ value: '', label: '系统默认' }, ...mics.map((m) => ({ value: m.id, label: m.label }))]}
              onChange={(v) => patch({ ui: { micDeviceId: v } }, true)}
            />
            <Btn onClick={() => void refreshMics()} disabled={micBusy}>
              {micBusy ? '检测中…' : '刷新列表'}
            </Btn>
          </div>
        </Field>
      </Section>
    </>
  )
}
