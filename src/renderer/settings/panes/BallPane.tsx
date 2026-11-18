import { useState } from 'react'
import { BUILTIN_SKINS, builtinSkinUrl, resolveBallImage } from '@shared/art'
import { Btn, Field, Range, Section, Toggle } from '../ui'
import type { PaneProps } from './types'

async function downscale(dataUrl: string, max = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('canvas 不可用'))
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

export default function BallPane({ s, patch }: PaneProps): React.ReactElement {
  const [busy, setBusy] = useState(false)

  const upload = async (): Promise<void> => {
    setBusy(true)
    try {
      const raw = await window.bwu.settings.pickImage()
      if (!raw) return
      const small = await downscale(raw)
      patch({ ball: { image: small } }, true)
    } finally {
      setBusy(false)
    }
  }

  const isCustom = s.ball.image.startsWith('data:')

  return (
    <>
      <Section title="悬浮球" desc="半透明、始终置顶，可拖到任意位置。单击打开气泡，右键打开菜单">
        <div className="ball-preview">
          <div
            className="ball-preview__ball"
            style={{
              width: s.ball.size * 1.1,
              height: s.ball.size * 1.1,
              opacity: s.ball.opacity / 100,
              backgroundImage: `url("${resolveBallImage(s.ball.image)}")`
            }}
          />
          <div className="ball-preview__meta">
            <strong>{s.ball.size}px</strong>
            <span>透明度 {s.ball.opacity}%</span>
            <span>{isCustom ? '自定义皮肤' : (BUILTIN_SKINS.find((a) => a.id === s.ball.image)?.label ?? '内置')}</span>
          </div>
        </div>

        <Field label="内置皮肤">
          <div className="swatches">
            {BUILTIN_SKINS.map((a) => (
              <button
                key={a.id}
                className={s.ball.image === a.id ? 'swatch is-active' : 'swatch'}
                style={{ backgroundImage: `url("${builtinSkinUrl(a.id)}")` }}
                title={a.label}
                onClick={() => patch({ ball: { image: a.id } }, true)}
              >
                <span>{a.label}</span>
              </button>
            ))}
            {isCustom ? (
              <button
                className="swatch is-active"
                style={{ backgroundImage: `url("${s.ball.image}")` }}
                title="自定义"
              >
                <span>自定义</span>
              </button>
            ) : null}
          </div>
        </Field>

        <Field label="上传自定义皮肤" hint="建议使用正方形图片">
          <Btn onClick={() => void upload()} disabled={busy}>
            {busy ? '处理中…' : '选择图片…'}
          </Btn>
        </Field>

        <Field label="直径" hint="也可以右键悬浮球，用「放大 / 缩小」快速调整">
          <Range
            value={s.ball.size}
            min={64}
            max={152}
            onChange={(v) => patch({ ball: { size: v } })}
            format={(v) => `${v}px`}
          />
        </Field>

        <Field label="快速大小" hint="一键切换，滑杆可以再微调">
          <div className="ball-presets">
            {[
              { size: 72, label: '小' },
              { size: 96, label: '中' },
              { size: 128, label: '大' },
              { size: 152, label: '特大' }
            ].map((p) => (
              <button
                key={p.size}
                className={Math.abs(s.ball.size - p.size) <= 4 ? 'ball-preset is-active' : 'ball-preset'}
                onClick={() => patch({ ball: { size: p.size } }, true)}
                title={`${p.size}px`}
              >
                <span className="ball-preset__dot" style={{ width: p.size / 3.2, height: p.size / 3.2 }} />
                <span>{p.label}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="不透明度">
          <Range
            value={s.ball.opacity}
            min={20}
            max={100}
            onChange={(v) => patch({ ball: { opacity: v } })}
            format={(v) => `${v}%`}
          />
        </Field>

        <Field label="位置">
          <Btn onClick={() => window.bwu.ball.resetPosition()}>回到右下角</Btn>
        </Field>
      </Section>

      <Section title="气泡与说话" desc="对话会从悬浮球旁弹出，播完自动收起">
        <Field label="播完后停留">
          <Range
            value={s.bubble.holdMs}
            min={1000}
            max={30000}
            step={500}
            onChange={(v) => patch({ bubble: { holdMs: v } })}
            format={(v) => `${(v / 1000).toFixed(1)}s`}
          />
        </Field>

        <Field label="一直显示气泡" hint="不自动收起，适合边看攻略边聊">
          <Toggle
            checked={s.bubble.keepOpen}
            onChange={(v) => patch({ bubble: { keepOpen: v } }, true)}
          />
        </Field>
      </Section>
    </>
  )
}
