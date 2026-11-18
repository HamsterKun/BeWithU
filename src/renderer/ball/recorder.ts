import workletSource from './pcm-worklet.js?raw'

let workletUrl: string | null = null

function getWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }))
  }
  return workletUrl
}

export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private data: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(256))
  private active = false

  get running(): boolean {
    return this.active
  }

  async start(deviceId: string, onPcm: (buf: ArrayBuffer) => void): Promise<void> {
    if (this.active) return
    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
    if (deviceId) audio.deviceId = { exact: deviceId }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    await this.ctx.audioWorklet.addModule(getWorkletUrl())

    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1
    })
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onPcm(e.data)
    this.source.connect(this.node)

    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.source.connect(this.analyser)
    this.data = new Uint8Array(new ArrayBuffer(this.analyser.fftSize))

    if (this.ctx.state === 'suspended') await this.ctx.resume()
    this.active = true
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
    this.active = false
    try {
      this.node?.port.postMessage('flush')
      this.node?.disconnect()
      this.source?.disconnect()
      this.analyser?.disconnect()
      this.stream?.getTracks().forEach((t) => t.stop())
      await this.ctx?.close()
    } catch {
      /* ignore */
    }
    this.node = null
    this.source = null
    this.analyser = null
    this.stream = null
    this.ctx = null
  }
}
