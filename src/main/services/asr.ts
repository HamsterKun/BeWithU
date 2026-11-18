import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import WebSocket from 'ws'
import type { AsrSettings } from '../../shared/types'
import { log } from '../logger'
import { recordAsrSeconds } from '../store/usage'

/* ---------------------------------------------------------------------------
 * 豆包流式语音识别大模型（V3）
 *  1.0：volc.bigasr.sauc.*  → /api/v3/sauc/bigmodel         （双向流式）
 *  2.0：volc.seedasr.sauc.* → /api/v3/sauc/bigmodel_async   （双向流式优化版）
 * 二进制帧：4B header + [4B seq] + 4B payload size + payload
 * ------------------------------------------------------------------------ */

const HOST = 'wss://openspeech.bytedance.com'
const ASR_URL_1 = `${HOST}/api/v3/sauc/bigmodel`
const ASR_URL_2 = `${HOST}/api/v3/sauc/bigmodel_async`

/** 2.0 和 1.0 是两套资源 + 两个接口，按 resource id 自动选 */
export function asrEndpoint(resourceId: string): string {
  return resourceId.includes('seedasr') ? ASR_URL_2 : ASR_URL_1
}

const PROTOCOL_VERSION = 0b0001
const HEADER_SIZE = 0b0001
const CLIENT_FULL_REQUEST = 0b0001
const CLIENT_AUDIO_ONLY_REQUEST = 0b0010
const SERVER_FULL_RESPONSE = 0b1001
const SERVER_ACK = 0b1011
const SERVER_ERROR_RESPONSE = 0b1111
const NO_SEQUENCE = 0b0000
const POS_SEQUENCE = 0b0001
const NEG_WITH_SEQUENCE = 0b0011
const SERIALIZATION_JSON = 0b0001
const COMPRESSION_NONE = 0b0000
const COMPRESSION_GZIP = 0b0001

function makeFrame(
  messageType: number,
  flags: number,
  payload: Buffer,
  opts: { seq?: number; serialization?: number } = {}
): Buffer {
  const serialization = opts.serialization ?? SERIALIZATION_JSON
  const header = Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | COMPRESSION_NONE,
    0x00
  ])
  const parts: Buffer[] = [header]
  if (flags === POS_SEQUENCE || flags === NEG_WITH_SEQUENCE || flags === 0b0010) {
    const seqBuf = Buffer.alloc(4)
    seqBuf.writeInt32BE(opts.seq ?? 0, 0)
    parts.push(seqBuf)
  }
  const sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32BE(payload.length, 0)
  parts.push(sizeBuf, payload)
  return Buffer.concat(parts)
}

interface ParsedFrame {
  messageType: number
  flags: number
  seq: number
  payload: Buffer
  errorCode?: number
}

function parseFrame(buf: Buffer): ParsedFrame {
  const headerSize = (buf[0] & 0x0f) * 4
  const messageType = buf[1] >> 4
  const flags = buf[1] & 0x0f
  const compression = buf[2] & 0x0f
  let offset = headerSize
  let seq = 0
  if (flags === POS_SEQUENCE || flags === 0b0010 || flags === NEG_WITH_SEQUENCE) {
    seq = buf.readInt32BE(offset)
    offset += 4
  }
  let errorCode: number | undefined
  if (messageType === SERVER_ERROR_RESPONSE) {
    errorCode = buf.readUInt32BE(offset)
    offset += 4
  }
  const size = buf.readUInt32BE(offset)
  offset += 4
  let payload = buf.subarray(offset, offset + size)
  if (compression === COMPRESSION_GZIP && payload.length) {
    try {
      payload = gunzipSync(payload)
    } catch (e) {
      log('asr: gzip 解压失败', e)
    }
  }
  return { messageType, flags, seq, payload, errorCode }
}

/** 面向用户的错误提示：只说清怎么处理，原始报文只进日志 */
function friendly(code: number, message: string): string {
  const text = `${code} ${message}`.trim()
  if (/401|403|authenticat|permission|token|app/i.test(text)) return '语音识别凭证无效，请检查 API Key 或 Token'
  if (/quota|limit|balance/i.test(text)) return '语音识别额度不足，请到控制台检查'
  return '语音识别失败，请稍后再试'
}

function handshakeError(status: number, body: string): string {
  if (/resource not granted/i.test(body)) {
    return '识别服务还没有开通，请先到控制台开通'
  }
  if (/not allowed/i.test(body)) return '识别版本不正确，请检查上方选项'
  if (status === 401 || status === 403) return '语音识别凭证无效，请检查 API Key 或 Token'
  return '识别连接失败，请检查网络后重试'
}

export class VolcAsr {
  private ws: WebSocket
  private seq = 1
  private text = ''
  private finalDone = false
  private finalResolve: ((t: string) => void) | null = null
  private finalPromise: Promise<string>
  private onPartial?: (text: string) => void
  private closedByUs = false
  private error: Error | null = null
  /** 已发送的音频字节数，用于按秒记用量 */
  private audioBytes = 0

  private constructor(ws: WebSocket, cfg: AsrSettings, onPartial?: (t: string) => void) {
    this.ws = ws
    this.onPartial = onPartial
    this.finalPromise = new Promise((resolve) => {
      this.finalResolve = resolve
    })
    this.ws.on('message', (data: WebSocket.RawData) => this.handleMessage(data as Buffer))
    this.ws.on('error', (err) => {
      log('asr: socket error', err)
      this.error = new Error(`语音识别连接异常：${err.message}`)
      this.resolveFinal()
    })
    this.ws.on('close', () => this.resolveFinal())

    // VAD 判停：松键后即便没发结束帧，服务端也会在静音后给出终态
    this.ws.send(
      makeFrame(
        CLIENT_FULL_REQUEST,
        POS_SEQUENCE,
        Buffer.from(
          JSON.stringify({
            user: { uid: 'bewithu', platform: 'Windows' },
            audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
            request: {
              model_name: 'bigmodel',
              language: cfg.language || 'zh-CN',
              enable_itn: true,
              enable_punc: true,
              enable_ddc: true,
              end_window_size: 800,
              force_to_speech_time: 1000,
              show_utterances: false,
              result_type: 'full'
            }
          }),
          'utf8'
        ),
        { seq: this.seq++ }
      )
    )
  }

  static async create(cfg: AsrSettings, onPartial?: (t: string) => void): Promise<VolcAsr> {
    const resourceId = cfg.resourceId.trim() || 'volc.seedasr.sauc.duration'
    const headers: Record<string, string> = {
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': randomUUID()
    }
    if (cfg.authMode === 'apikey') {
      if (!cfg.apiKey.trim()) throw new Error('还没填语音识别的 API Key')
      headers['X-Api-Key'] = cfg.apiKey.trim()
    } else {
      if (!cfg.appId.trim() || !cfg.accessToken.trim()) {
        throw new Error('还没填语音识别的 AppID / Access Token')
      }
      headers['X-Api-App-Key'] = cfg.appId.trim()
      headers['X-Api-Access-Key'] = cfg.accessToken.trim()
    }
    const url = asrEndpoint(resourceId)
    log(`asr: 连接 ${url} · resource=${resourceId}`)
    const ws = new WebSocket(url, { headers, handshakeTimeout: 8000 })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('语音识别连接超时（8s）')), 9000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`语音识别连接失败：${err.message}`))
      })
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer)
        let body = ''
        res.on('data', (d: Buffer) => {
          body += d.toString('utf8')
        })
        res.on('end', () => reject(new Error(handshakeError(res.statusCode ?? 0, body))))
      })
    })
    log('asr: connected')
    return new VolcAsr(ws, cfg, onPartial)
  }

  private handleMessage(data: Buffer): void {
    let frame: ParsedFrame
    try {
      frame = parseFrame(data)
    } catch (e) {
      log('asr: 帧解析失败', e)
      return
    }

    if (frame.messageType === SERVER_ERROR_RESPONSE) {
      const text = frame.payload.toString('utf8')
      log('asr: server error', frame.errorCode, text)
      this.error = new Error(friendly(frame.errorCode ?? 0, text))
      this.resolveFinal()
      return
    }
    if (frame.messageType === SERVER_ACK) return
    if (frame.messageType !== SERVER_FULL_RESPONSE) return

    let json: any
    try {
      json = JSON.parse(frame.payload.toString('utf8'))
    } catch {
      return
    }
    const result = json?.result ?? json
    let text = ''
    if (typeof result?.text === 'string') text = result.text
    else if (Array.isArray(result?.utterances)) {
      text = result.utterances.map((u: any) => u?.text ?? '').join('')
    }
    if (text) {
      this.text = text
      this.onPartial?.(text)
    }
    const isFinal = (frame.flags & 0b0010) !== 0 || json?.is_final === true
    if (isFinal) this.resolveFinal()
  }

  private resolveFinal(): void {
    if (this.finalDone) return
    this.finalDone = true
    this.finalResolve?.(this.text)
    this.finalResolve = null
  }

  sendAudio(pcm: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN || this.finalDone) return
    this.audioBytes += pcm.byteLength
    try {
      this.ws.send(makeFrame(CLIENT_AUDIO_ONLY_REQUEST, POS_SEQUENCE, pcm, { seq: this.seq++ }))
    } catch (e) {
      log('asr: 发送音频失败', e)
    }
  }

  /** 松键：发结束帧，等终态文本 */
  async finish(timeoutMs = 2500): Promise<string> {
    if (this.ws.readyState === WebSocket.OPEN && !this.finalDone) {
      try {
        this.ws.send(
          makeFrame(CLIENT_AUDIO_ONLY_REQUEST, NEG_WITH_SEQUENCE, Buffer.alloc(0), { seq: -this.seq })
        )
      } catch (e) {
        log('asr: 结束帧发送失败', e)
      }
    }
    await Promise.race([
      this.finalPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
    this.close()
    // 16kHz 16bit 单声道 → 每秒 32000 字节
    if (this.audioBytes > 0) recordAsrSeconds(this.audioBytes / 32000)
    if (this.error && !this.text) throw this.error
    return this.text
  }

  get currentText(): string {
    return this.text
  }

  cancel(): void {
    this.closedByUs = true
    this.resolveFinal()
    this.close()
  }

  private close(): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
    } catch {
      /* ignore */
    }
  }
}

export async function testAsr(cfg: AsrSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const asr = await VolcAsr.create(cfg)
    asr.cancel()
    return { ok: true, message: '连接成功，凭证可用' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
