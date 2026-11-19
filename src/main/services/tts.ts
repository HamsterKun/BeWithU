import { randomUUID } from 'node:crypto'
import type { TtsSettings } from '../../shared/types'
import { log } from '../logger'
import { recordTtsChars } from '../store/usage'
import { HttpStatusError } from './http-error'
import { sseLines } from './sse'

/** 豆包语音合成大模型 V3 · 单向流式（HTTP + SSE），2.0 音色可用 */
const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse'
export const TTS_SAMPLE_RATE = 24000

/** Breeze Blue 语音合成：流式接口默认输出 24kHz 单声道 16bit PCM，正好是播放端要的格式 */
const BREEZE_BASE = 'https://api.breeze.blue'
const BREEZE_SAMPLE_RATE = 24000
/** Breeze 单次请求文本上限（默认 1000 字符） */
const BREEZE_MAX_CHARS = 1000

function credentials(tts: TtsSettings): Record<string, string> {
  if (tts.authMode === 'apikey') {
    if (!tts.apiKey.trim()) throw new Error('还没填语音合成的 API Key')
    return {
      'X-Api-Key': tts.apiKey.trim(),
      'X-Api-Resource-Id': tts.resourceId.trim() || 'seed-tts-2.0'
    }
  }
  if (!tts.appId.trim() || !tts.accessToken.trim()) throw new Error('还没填语音合成的 AppID / Access Token')
  return {
    'X-Api-App-Id': tts.appId.trim(),
    'X-Api-Access-Key': tts.accessToken.trim(),
    'X-Api-Resource-Id': tts.resourceId.trim() || 'seed-tts-2.0'
  }
}

/** 面向用户的错误提示：只说清怎么处理，状态码与服务端原文只进日志 */
function friendly(code: number, message: string): string {
  const text = `${code} ${message}`.trim()
  if (/401|403|authenticat|permission|token/i.test(text)) return '语音合成凭证无效，请检查 API Key 或 Token'
  if (/quota|limit|balance|insufficient/i.test(text)) return '语音合成额度不足，请到控制台检查'
  return '语音合成失败，请稍后再试'
}

export interface TtsChunk {
  pcm: Buffer
  sampleRate: number
}

/* ------------------------------------------------------------- Breeze ---- */

/** 面板上的 -50~100 映射成 Breeze 的 0.5~2.0 倍速 */
function breezeSpeed(tts: TtsSettings): number {
  return Math.min(2, Math.max(0.5, 1 + tts.speed / 100))
}

function breezeFriendly(status: number, raw: string): string {
  let detail = ''
  try {
    const j = JSON.parse(raw) as { detail?: string; error?: string }
    detail = j.detail || j.error || ''
  } catch {
    detail = raw.replace(/\s+/g, ' ').slice(0, 120)
  }
  if (status === 401 || status === 403) return '音色服务鉴权失败：请检查 Breeze API Key'
  if (status === 404) return '音色不存在：请检查音色 ID（形如 voc_…）'
  if (status === 422) return `参数不被接受：请检查模型 / 语言 / 音色是否匹配${detail ? '（' + detail.slice(0, 80) + '）' : ''}`
  if (status === 429) return '请求过于频繁或额度不足，请稍后再试'
  if (status >= 500) return 'Breeze 服务暂时不可用，请稍后再试'
  return `语音合成失败${detail ? '：' + detail.slice(0, 80) : ''}`
}

/** Breeze Blue 流式合成：产出裸 PCM（s16le / 24kHz / 单声道） */
async function* breezeSynthesize(
  tts: TtsSettings,
  text: string,
  signal: AbortSignal
): AsyncGenerator<TtsChunk> {
  const cfg = tts.breeze
  const key = cfg.apiKey.trim()
  if (!key) throw new Error('还没填 Breeze 的 API Key')
  const voiceId = cfg.voiceId.trim()
  if (!voiceId) throw new Error('还没填 Breeze 的音色 ID（形如 voc_…）')

  // 服务端单次最多 1000 字符，按边界切一下
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += BREEZE_MAX_CHARS) pieces.push(text.slice(i, i + BREEZE_MAX_CHARS))

  for (const piece of pieces) {
    const content = piece.trim()
    if (!content) continue
    const url = `${BREEZE_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm`
    const body: Record<string, unknown> = {
      text: content,
      model_id: cfg.modelId.trim() || 'breeze-tts-2',
      voice_settings: { speed: breezeSpeed(tts) }
    }
    if (cfg.language) body.language_code = cfg.language

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify(body),
      signal
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      log('tts: breeze http error', res.status, detail.replace(/\s+/g, ' ').slice(0, 400))
      throw new HttpStatusError(breezeFriendly(res.status, detail), res.status, 'breeze')
    }
    if (!res.body) throw new Error('语音合成没有返回数据流')

    let carry: Buffer | null = null
    let got = false
    const stream = res.body as unknown as AsyncIterable<Uint8Array>
    for await (const chunk of stream) {
      let buf: Buffer = carry ? Buffer.concat([carry, Buffer.from(chunk)]) : Buffer.from(chunk)
      // 16bit 采样必须双字节对齐，奇数尾巴留到下一块
      if (buf.length % 2 === 1) {
        carry = buf.subarray(buf.length - 1)
        buf = buf.subarray(0, buf.length - 1)
      } else {
        carry = null
      }
      if (!buf.length) continue
      got = true
      yield { pcm: buf, sampleRate: BREEZE_SAMPLE_RATE }
    }
    if (!got) throw new Error('没有收到声音，请检查音色 ID 与模型是否匹配')
  }
}

/**
 * 逐块产出 PCM（s16le 单声道 24kHz）。调用方负责按句子顺序播放。
 */
export async function* synthesize(
  tts: TtsSettings,
  text: string,
  signal: AbortSignal
): AsyncGenerator<TtsChunk> {
  // 语音合成按字数计费（火山/Breeze 都是按字符），这里记一笔
  recordTtsChars(text.length)
  if (tts.provider === 'breeze') {
    yield* breezeSynthesize(tts, text, signal)
    return
  }
  const content = text.trim()
  if (!content) return

  const reqId = randomUUID()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Api-Request-Id': reqId,
    'X-Api-Connect-Id': randomUUID(),
    ...credentials(tts)
  }

  const body = {
    user: { uid: 'bewithu' },
    req_params: {
      text: content,
      speaker: tts.speaker.trim(),
      audio_params: {
        format: 'pcm',
        sample_rate: TTS_SAMPLE_RATE,
        speech_rate: Math.round(tts.speed),
        loudness_rate: Math.round(tts.loudness)
      },
      additions: JSON.stringify({
        disable_markdown_filter: true,
        max_length_to_filter_parenthesis: 100
      })
    }
  }

  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    log('tts: http error', res.status, detail.slice(0, 400))
    throw new Error(friendly(res.status, detail.replace(/\s+/g, ' ').slice(0, 240)))
  }
  if (!res.body) throw new Error('语音合成没有返回数据流')

  let got = false

  const stream = res.body as unknown as AsyncIterable<Uint8Array>
  for await (const raw of sseLines(stream)) {
    const line = raw.trim()
    if (!line || line.startsWith(':') || line.startsWith('event:')) continue
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line
    if (!payload || payload === '[DONE]') continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(payload)
    } catch {
      continue
    }
    const code = Number(obj.code ?? obj.status_code ?? 0)
    const message = String(obj.message ?? obj.status_text ?? '')
    if (code !== 0 && code !== 3000 && code !== 20000000) {
      throw new Error(friendly(code, message))
    }
    const audio = obj.data ?? obj.audio ?? obj.payload
    if (typeof audio === 'string' && audio.length > 0) {
      got = true
      yield { pcm: Buffer.from(audio, 'base64'), sampleRate: TTS_SAMPLE_RATE }
    }
  }

  if (!got) throw new Error('没有收到声音，请检查音色与音色版本是否匹配')
}

export async function testTts(
  tts: TtsSettings,
  text: string,
  onPcm?: (pcm: Buffer) => void
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  const started = Date.now()
  let bytes = 0
  let firstAt = 0
  try {
    for await (const chunk of synthesize(tts, text, controller.signal)) {
      if (!firstAt) firstAt = Date.now() - started
      bytes += chunk.pcm.length
      onPcm?.(chunk.pcm)
    }
    if (!bytes) return { ok: false, message: '没有收到声音' }
    const total = Date.now() - started
    return { ok: true, message: `试听成功 · ${total}ms`, latencyMs: firstAt }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log('tts test 失败', msg)
    return { ok: false, message: controller.signal.aborted ? '试听超时，请稍后重试' : msg }
  } finally {
    clearTimeout(timer)
  }
}
