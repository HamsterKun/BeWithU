/* 流式 PCM 播放：按句子序号顺序调度 AudioBuffer，句间无缝衔接 */

interface Chunk {
  pcm: Int16Array
  rate: number
}

/** 收尾守护：无声音在播且这么久没有新音频，就认定序号断了 */
const DRAIN_IDLE_MS = 2500
/** 收尾守护的最长兜底时间（设备异常导致 onended 不回调时） */
const DRAIN_MAX_MS = 60000

const debug = { state: 'idle', scheduled: 0, dropped: 0, expected: 0, error: '' }
;(window as unknown as Record<string, unknown>).__bwuAudio = debug

export class Player {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private data: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(256))
  private started = false
  private expected = 0
  private maxSeq = -1
  private streamScheduled = 0
  private pending = new Map<number, { chunks: Chunk[]; done: boolean }>()
  private nextTime = 0
  private active = new Set<AudioBufferSourceNode>()
  private endOfStream = false
  private reported = false
  private volume = 0.9
  /** 丢包兜底：endStream 后若长时间没有进展，强制收尾 */
  private drainGuard: number | null = null
  /** 最近一次有音频进展（收到分片 / 排期）的时间 */
  private lastActivity = 0
  private streamEndedAt = 0
  onDrained: (() => void) | null = null
  onFirstSound: (() => void) | null = null

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.gain) this.gain.gain.value = this.volume
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.volume
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 256
      this.gain.connect(this.analyser)
      this.analyser.connect(this.ctx.destination)
      this.data = new Uint8Array(new ArrayBuffer(this.analyser.fftSize))
      this.ctx.onstatechange = () => {
        debug.state = this.ctx?.state ?? 'closed'
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch((e: Error) => {
        debug.error = `resume: ${e.message}`
      })
    }
    debug.state = this.ctx.state
    return this.ctx
  }

  /** 任意 seq 起点都算一次新播放流（试听用的 seq 与对话不连续） */
  private beginStream(seq: number): void {
    this.clearDrainGuard()
    this.started = true
    this.expected = seq
    this.maxSeq = -1
    this.pending.clear()
    this.endOfStream = false
    this.reported = false
    this.nextTime = 0
    this.streamScheduled = 0
  }

  push(seq: number, pcm: Int16Array, rate: number, last: boolean): void {
    if (!this.started) this.beginStream(seq)
    this.lastActivity = Date.now()
    if (seq < this.expected) {
      // 还没播出任何声音时，允许把起点回调到更小的序号（防止乱序把第一句丢掉）
      if (this.streamScheduled === 0) this.expected = seq
      else {
        debug.dropped += 1
        return
      }
    }
    this.maxSeq = Math.max(this.maxSeq, seq)

    if (seq > this.expected) {
      const entry = this.pending.get(seq) ?? { chunks: [], done: false }
      if (pcm.length) entry.chunks.push({ pcm, rate })
      if (last) entry.done = true
      this.pending.set(seq, entry)
      return
    }

    if (pcm.length) this.schedule(pcm, rate)
    if (last) {
      this.expected += 1
      this.drainPending()
    }
  }

  private drainPending(): void {
    while (this.pending.has(this.expected)) {
      const entry = this.pending.get(this.expected)!
      this.pending.delete(this.expected)
      for (const c of entry.chunks) this.schedule(c.pcm, c.rate)
      if (entry.done) {
        this.expected += 1
      } else {
        break
      }
    }
  }

  private schedule(pcm: Int16Array, rate: number): void {
    const ctx = this.ensure()
    const buffer = ctx.createBuffer(1, pcm.length, rate)
    const ch = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.gain!)
    const now = ctx.currentTime
    if (this.nextTime < now + 0.03) this.nextTime = now + 0.03
    try {
      src.start(this.nextTime)
    } catch (e) {
      debug.error = `start: ${(e as Error).message}`
      return
    }
    this.nextTime += buffer.duration
    this.active.add(src)
    this.streamScheduled += 1
    this.lastActivity = Date.now()
    debug.scheduled += 1
    debug.expected = this.expected
    this.onFirstSound?.()
    src.onended = () => {
      this.active.delete(src)
      this.checkDrained()
    }
  }

  endStream(): void {
    this.endOfStream = true
    this.streamEndedAt = Date.now()
    this.lastActivity = this.streamEndedAt
    this.checkDrained()
    this.armDrainGuard()
  }

  /**
   * 收尾守护：主进程已说"音频发完了"，但序号断了（缺一个 seq）就永远凑不齐
   * expected。这里盯着"是否还有声音在放 / 是否还有进展"，长时间没进展就强制收尾，
   * 否则界面会一直停在"正在说"。
   */
  private armDrainGuard(): void {
    this.clearDrainGuard()
    this.drainGuard = window.setInterval(() => {
      if (this.reported) {
        this.clearDrainGuard()
        return
      }
      const now = Date.now()
      // 已经没有声音在播，而且一段时间没有任何新音频 —— 认定序号断了
      if (this.active.size === 0 && now - this.lastActivity >= DRAIN_IDLE_MS) {
        debug.dropped += 1
        this.finishDrain()
        return
      }
      // 极端兜底：设备异常导致 onended 不回调时，也不要永远挂着
      if (now - this.streamEndedAt >= DRAIN_MAX_MS) {
        debug.dropped += 1
        this.finishDrain()
      }
    }, 500)
  }

  private clearDrainGuard(): void {
    if (this.drainGuard !== null) {
      window.clearInterval(this.drainGuard)
      this.drainGuard = null
    }
  }

  private finishDrain(): void {
    if (this.reported) return
    this.reported = true
    this.started = false
    this.clearDrainGuard()
    this.onDrained?.()
  }

  private checkDrained(): void {
    if (!this.endOfStream || this.reported) return
    if (this.expected <= this.maxSeq) return
    if (this.active.size > 0 || this.pending.size > 0) return
    this.finishDrain()
  }

  stop(): void {
    this.clearDrainGuard()
    for (const src of this.active) {
      try {
        src.onended = null
        src.stop()
      } catch {
        /* ignore */
      }
    }
    this.active.clear()
    this.pending.clear()
    this.expected = 0
    this.maxSeq = -1
    this.nextTime = 0
    this.endOfStream = false
    this.reported = false
    this.started = false
  }

  getLevel(): number {
    if (!this.analyser) return 0
    this.analyser.getByteTimeDomainData(this.data)
    let sum = 0
    for (let i = 0; i < this.data.length; i++) {
      const x = (this.data[i] - 128) / 128
      sum += x * x
    }
    return Math.min(1, Math.sqrt(sum / this.data.length) * 3)
  }

  get playing(): boolean {
    return this.active.size > 0
  }
}
