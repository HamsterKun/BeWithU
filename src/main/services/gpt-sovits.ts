import type { TtsSettings } from '../../shared/types'
import type { TtsChunk } from './tts'

const MAX_AUDIO_BYTES = 32 * 1024 * 1024

/** API v2 的非流式 WAV 自带原始采样率。保留采样率并转换为播放端需要的单声道 PCM。 */
export function decodeSovitsWav(wav: Buffer): TtsChunk {
  const invalid = (): Error => new Error('GPT-SoVITS 返回了无效音频，需要 16 位 PCM WAV')
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw invalid()
  }
  let sampleRate = 0
  let channels = 0
  let data: Buffer | undefined
  for (let pos = 12; pos + 8 <= wav.length;) {
    const name = wav.toString('ascii', pos, pos + 4)
    const size = wav.readUInt32LE(pos + 4)
    const start = pos + 8
    if (start + size > wav.length) throw invalid()
    if (name === 'fmt ') {
      if (size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16) throw invalid()
      channels = wav.readUInt16LE(start + 2)
      sampleRate = wav.readUInt32LE(start + 4)
    }
    if (name === 'data') data = wav.subarray(start, start + size)
    pos = start + size + (size % 2)
  }
  if (!data?.length || (channels !== 1 && channels !== 2) || data.length % (channels * 2) ||
      sampleRate < 8000 || sampleRate > 192000) throw invalid()
  if (channels === 1) return { pcm: data, sampleRate }
  const pcm = Buffer.allocUnsafe(data.length / 2)
  for (let i = 0; i < data.length; i += 4) {
    pcm.writeInt16LE(Math.round((data.readInt16LE(i) + data.readInt16LE(i + 2)) / 2), i / 2)
  }
  return { pcm, sampleRate }
}

export async function synthesizeSovits(tts: TtsSettings, text: string, signal: AbortSignal): Promise<TtsChunk> {
  const cfg = tts.gptSovits
  const url = URL.parse(cfg.baseUrl.trim())
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请填写有效的 GPT-SoVITS API 地址')
  }
  if (!cfg.refAudioPath.trim()) throw new Error('请填写 GPT-SoVITS 服务端的参考音频路径')
  const endpoint = url.pathname.replace(/\/+$/, '')
  url.pathname = endpoint.endsWith('/tts') ? endpoint : `${endpoint}/tts`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
    body: JSON.stringify({
      text,
      text_lang: cfg.textLang.trim() || 'auto',
      ref_audio_path: cfg.refAudioPath.trim(),
      prompt_text: cfg.promptText.trim(),
      prompt_lang: cfg.promptLang.trim() || 'zh',
      text_split_method: 'cut5',
      speed_factor: Math.min(2, Math.max(0.5, 1 + tts.speed / 100)),
      media_type: 'wav',
      streaming_mode: false
    }),
    signal
  }).catch((error) => {
    signal.throwIfAborted()
    throw new Error('连不上 GPT-SoVITS，请检查 API 地址和 api_v2 服务', { cause: error })
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 404
      ? '找不到 GPT-SoVITS /tts 接口，请确认服务运行的是 api_v2'
      : `GPT-SoVITS 合成失败（HTTP ${response.status}），请核对服务端参考音频和语种`)
  }
  if (!response.body) throw new Error('GPT-SoVITS 没有返回声音')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > MAX_AUDIO_BYTES) throw new Error('GPT-SoVITS 返回的音频过大')
    chunks.push(Buffer.from(chunk))
  }
  signal.throwIfAborted()
  return decodeSovitsWav(Buffer.concat(chunks, size))
}
