/** 把流式文本切成适合逐句合成的短句，并清洗成"能被念出来"的纯文本 */

const HARD_END = /[。！？!?；;\n…]+/
const SOFT_END = /[，,、：:—]/

const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu

export function cleanForSpeech(raw: string): string {
  let text = raw
  text = text.replace(/```[\s\S]*?```/g, ' 代码 ')
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/https?:\/\/\S+/g, '')
  text = text.replace(/[*_~#>|]+/g, '')
  text = text.replace(/^\s*[-•]\s+/gm, '')
  text = text.replace(/\n{2,}/g, '\n')
  text = text.replace(EMOJI, '')
  text = text.replace(/\s{2,}/g, ' ')
  return text.trim()
}

export class SentenceSplitter {
  private buf = ''
  private minLen: number
  private softLen: number

  constructor(minLen = 6, softLen = 26) {
    this.minLen = minLen
    this.softLen = softLen
  }

  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    // 先去硬断句
    for (;;) {
      const m = HARD_END.exec(this.buf)
      if (!m) break
      const idx = m.index + m[0].length
      const head = this.buf.slice(0, idx)
      if (cleanForSpeech(head).length < 2) {
        this.buf = this.buf.slice(idx)
        continue
      }
      out.push(head)
      this.buf = this.buf.slice(idx)
    }
    // 长句在逗号处切，避免一句话等太久
    while (cleanForSpeech(this.buf).length > this.softLen) {
      const m = SOFT_END.exec(this.buf)
      if (!m) break
      const idx = m.index + m[0].length
      out.push(this.buf.slice(0, idx))
      this.buf = this.buf.slice(idx)
    }
    return out.map((s) => cleanForSpeech(s)).filter((s) => s.length >= 2)
  }

  flush(): string[] {
    const rest = cleanForSpeech(this.buf)
    this.buf = ''
    if (rest.length >= 1 && rest.length >= Math.min(this.minLen, 4)) return [rest]
    return rest ? [rest] : []
  }

  get pending(): string {
    return this.buf
  }
}
