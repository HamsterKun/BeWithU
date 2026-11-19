import { useCallback, useEffect, useRef, useState } from 'react'
import type { Phase, PublicSettings } from '@shared/types'
import type { AgentProgress } from '@shared/ipc'
import { resolveBallImage } from '@shared/art'
import { Player } from './player'
import { Recorder } from './recorder'

const player = new Player()
const recorder = new Recorder()

export default function Ball(): React.ReactElement {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [agent, setAgent] = useState<AgentProgress | null>(null)
  const [recording, setRecording] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const settingsRef = useRef<PublicSettings | null>(null)
  const pointer = useRef({ x: 0, y: 0, t: 0, moved: false, down: false })
  const size = settings?.ball.size ?? 96
  const opacity = (settings?.ball.opacity ?? 84) / 100
  const image = resolveBallImage(settings?.ball.image ?? '')

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    void window.bwu.settings.get().then((s) => {
      setSettings(s)
      settingsRef.current = s
      player.setVolume(s.tts.volume)
    })
    const offSettings = window.bwu.ball.onSettings((s) => {
      setSettings(s)
      player.setVolume(s.tts.volume)
    })

    const offAgent = window.bwu.ball.onAgent((p) => setAgent(p.active ? p : null))

  const offPhase = window.bwu.ball.onPhase((p) => {
      phaseRef.current = p
      setPhase(p)
    })

    const offRecStart = window.bwu.ball.onRecStart(() => {
      setRecording(true)
      void recorder
        .start(settingsRef.current?.ui.micDeviceId ?? '', (buf) => window.bwu.ball.sendPcm(buf))
        .catch((e: unknown) => {
          setRecording(false)
          const msg = e instanceof Error ? e.message : String(e)
          window.bwu.ball.reportError(msg)
        })
    })

    const offRecStop = window.bwu.ball.onRecStop(() => {
      setRecording(false)
      void recorder.stop()
    })

    player.onDrained = () => window.bwu.ball.audioDrained()

    const offAudio = window.bwu.ball.onAudio((c) => {
      player.push(c.seq, new Int16Array(c.pcm), c.sampleRate, c.last)
    })
    const offAudioEnd = window.bwu.ball.onAudioEnd(() => player.endStream())
    const offAudioStop = window.bwu.ball.onAudioStop(() => player.stop())

    return () => {
      offSettings()
      offPhase()
    offAgent()
      offRecStart()
      offRecStop()
      offAudio()
      offAudioEnd()
      offAudioStop()
      void recorder.stop()
    }
  }, [])

  // Windows Graphics Capture 兜底：普通抓屏黑屏时，主进程会让我们抓一帧
  useEffect(() => {
    const grabFrame = async (): Promise<void> => {
      let stream: MediaStream | null = null
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } })
        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        await video.play()
        await new Promise((r) => setTimeout(r, 220))
        const vw = video.videoWidth || 1920
        const vh = video.videoHeight || 1080
        const scale = Math.min(1, 1600 / Math.max(1, vw))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(vw * scale))
        canvas.height = Math.max(1, Math.round(vh * scale))
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
        video.srcObject = null
        window.bwu.ball.grabResult({
          ok: true,
          dataUrl,
          width: canvas.width,
          height: canvas.height
        })
      } catch (e) {
        window.bwu.ball.grabResult({
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        })
      } finally {
        stream?.getTracks().forEach((t) => t.stop())
      }
    }

    const offGrab = window.bwu.ball.onGrab(() => void grabFrame())
    return offGrab
  }, [])

  // 电平驱动视觉
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      const level =
        phaseRef.current === 'listening' || recording ? recorder.getLevel() : player.getLevel()
      if (stageRef.current) {
        stageRef.current.style.setProperty('--level', level.toFixed(3))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [recording])

  // 圆形命中测试由主进程用全局光标完成（见 windows.updateBallHitTest）

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    pointer.current = { x: e.screenX, y: e.screenY, t: performance.now(), moved: false, down: true }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    window.bwu.ball.dragStart()
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointer.current.down) return
    const dx = e.screenX - pointer.current.x
    const dy = e.screenY - pointer.current.y
    if (Math.hypot(dx, dy) > 4) pointer.current.moved = true
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointer.current.down) return
    const { moved, t } = pointer.current
    pointer.current.down = false
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      /* ignore */
    }
    window.bwu.ball.dragEnd()
    const isClick = !moved && performance.now() - t < 420
    window.bwu.ball.click(!isClick)
  }, [])

  // 徽标两态：模型思考（绿）/ 正在调工具（金）；闲聊的思考也走绿色
  const badgeMode: 'thinking' | 'working' | null = agent
    ? agent.mode === 'working'
      ? 'working'
      : 'thinking'
    : phase === 'thinking'
      ? 'thinking'
      : null

  return (
    <div
      className="stage"
      ref={stageRef}
      data-phase={agent ? 'acting' : phase === 'idle' && recording ? 'listening' : phase}
      style={{ ['--size' as string]: `${size}px`, ['--opacity' as string]: opacity }}
    >
      <div className="ring" />
      {badgeMode ? (
        <div className={badgeMode === 'thinking' ? 'work-badge is-think' : 'work-badge'}>
          <span className="work-badge__dot" />
          <span className="work-badge__text">
            {badgeMode === 'working' ? '💻 工作中…' : '💬 思考中…'}
          </span>
          {badgeMode === 'working' && agent && agent.total ? (
            <span className="work-badge__count">
              {agent.step}/{agent.total}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className="ball"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault()
          window.bwu.ball.contextMenu()
        }}
      >
        <div className="ball__art" style={{ backgroundImage: `url("${image}")` }} />
        <div className="ball__shade" />
        <div className="ball__eq">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="ball__dots">
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  )
}
