import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { Btn, Field, Range, Section, Segmented, Toggle } from '../ui'
import type { PaneProps } from './types'

function pretty(raw: string): string {
  const m = /^Mouse([345])$/i.exec(raw)
  if (m) return m[1] === '4' ? '鼠标侧键 1（后退键）' : m[1] === '5' ? '鼠标侧键 2（前进键）' : '鼠标中键'
  return raw.replace(/\+/g, ' + ')
}

export default function HotkeyPane({ s, patch }: PaneProps): React.ReactElement {
  const [capturing, setCapturing] = useState(false)
  const [info, setInfo] = useState<AppInfo | null>(null)

  const refresh = (): void => {
    void window.bwu.settings.appInfo().then(setInfo)
  }

  useEffect(() => {
    refresh()
  }, [s.voice.hotkey])

  const capture = async (): Promise<void> => {
    if (capturing) return
    setCapturing(true)
    try {
      const chord = await window.bwu.settings.captureHotkey()
      if (chord) patch({ voice: { hotkey: chord } }, true)
    } finally {
      setCapturing(false)
      refresh()
    }
  }

  return (
    <>
      <Section title="开麦按键" desc="全局生效，游戏中也能按键说话">
        <div className="hotkey-box">
          <div className="hotkey-box__value">{pretty(s.voice.hotkey)}</div>
          <Btn variant="primary" onClick={() => void capture()}>
            {capturing ? '请按下任意键或鼠标侧键…' : '重新绑定'}
          </Btn>
        </div>

        <Field label="触发方式">
          <Segmented
            value={s.voice.mode}
            options={[
              { value: 'hold', label: '按住说话' },
              { value: 'toggle', label: '按一下开始 / 再按结束' }
            ]}
            onChange={(v) => patch({ voice: { mode: v } }, true)}
          />
        </Field>

        {s.voice.mode === 'hold' ? (
          <Field label="最短按住时长" hint="太短的误触会被忽略">
            <Range
              value={s.voice.minHoldMs}
              min={100}
              max={1000}
              step={50}
              onChange={(v) => patch({ voice: { minHoldMs: v } })}
              format={(v) => `${(v / 1000).toFixed(2)} 秒`}
            />
          </Field>
        ) : null}

        <Field label="说话时打断 AI" hint="按下开麦键立即停止播报">
          <Toggle checked={s.voice.bargeIn} onChange={(v) => patch({ voice: { bargeIn: v } })} />
        </Field>

        <div className="field field--wide">
          <div className={info?.hotkeyActive ? 'status status--ok' : 'status status--warn'}>
            <span className="status__dot" />
            {info?.hotkeyMessage ?? '正在检测按键状态…'}
          </div>
        </div>
      </Section>
    </>
  )
}
