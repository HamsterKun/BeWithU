import workletSource from './pcm-worklet.js?raw'

let workletUrl: string | null = null

function getWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }))
  }
  return workletUrl
}

/**
 * 启动被 stop() 或新一次 start() 取消时抛出。
 * 调用方不该把它当"麦克风打不开"上报给用户。
 */
export class RecorderCancelled extends Error {
  constructor() {
    super('录音已取消')
    this.name = 'RecorderCancelled'
  }
}

export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private data: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(256))
  private active = false
  /** 每次 start/stop 递增；每个 await 之后比对，发现自己已过期就清理并退出 */
  private generation = 0

  get running(): boolean {
    return this.active
  }

  /** 释放这一代拿到的资源（可能只拿到一部分） */
  private async release(
    stream: MediaStream | null,
    ctx: AudioContext | null,
    node: AudioWorkletNode | null,
    source: MediaStreamAudioSourceNode | null,
    analyser: AnalyserNode | null
  ): Promise<void> {
    try {
      node?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      source?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      analyser?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* ignore */
    }
    // 关不掉的只是少量对象，但绝不能因为关失败把错误盖住
    try {
      await ctx?.close()
    } catch {
      /* 音轨已经释放，关闭失败不能遮盖原始错误 */
    }
  }

  async start(deviceId: string, onPcm: (buf: ArrayBuffer) => void): Promise<void> {
    if (this.active) return
    const gen = ++this.generation
    const ensureLive = (): void => {
      if (gen !== this.generation) throw new RecorderCancelled()
    }
    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
    if (deviceId) audio.deviceId = { exact: deviceId }

    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let node: AudioWorkletNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      ensureLive()
      ctx = new AudioContext({ latencyHint: 'interactive' })
      await ctx.audioWorklet.addModule(getWorkletUrl())
      ensureLive()

      source = ctx.createMediaStreamSource(stream)
      node = new AudioWorkletNode(ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1
      })
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (gen === this.generation) onPcm(e.data)
      }
      source.connect(node)

      analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      if (ctx.state === 'suspended') await ctx.resume()
      ensureLive()

      // 到这里才接管：中途被取消时这一代资源已在 catch 里释放
      this.stream = stream
      this.ctx = ctx
      this.source = source
      this.node = node
      this.analyser = analyser
      this.data = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      this.active = true
    } catch (e) {
      void this.release(stream, ctx, node, source, analyser)
      ensureLive()
      throw e
    }
  }

  getLevel(): number {
    if (!this.analyser || !this.active) return 0
    this.analyser.getByteTimeDomainData(this.data)
    let sum = 0
    for (let i = 0; i < this.data.length; i++) {
      const x = (this.data[i] - 128) / 128
      sum += x * x
    }
    return Math.min(1, Math.sqrt(sum / this.data.length) * 3.4)
  }

  async stop(): Promise<void> {
    // 让还在 await 里的 start() 失效
    this.generation++
    this.active = false
    const { node, source, analyser, stream, ctx } = this
    // 先摘下旧资源，关闭过程中启动的新一轮不会被异步清理覆盖。
    this.node = null
    this.source = null
    this.analyser = null
    this.stream = null
    this.ctx = null
    try {
      node?.port.postMessage('flush')
    } catch {
      /* 端口已关闭时仍要释放其余资源 */
    }
    await this.release(stream, ctx, node, source, analyser)
  }
}
