/* 麦克风采集：48k float -> 16k int16，每 100ms 一块，交给主进程送 ASR */

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = []
    this.acc = 0
    this.accN = 0
    this.ratio = sampleRate / 16000
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    const step = this.ratio
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]
      this.accN += 1
      if (this.accN >= step) {
        const v = Math.max(-1, Math.min(1, this.acc / this.accN))
        this.buf.push(v)
        this.acc = 0
        this.accN = 0
      }
    }
    if (this.buf.length >= 1600) {
      const pcm = new Int16Array(this.buf.length)
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(this.buf[i] * 32767)
      this.port.postMessage(pcm.buffer, [pcm.buffer])
      this.buf = []
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
