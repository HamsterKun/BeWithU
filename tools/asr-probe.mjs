// 火山引擎「豆包流式语音识别大模型」连通性测试脚本
// 用它验证 AppID / Token / ResourceId 和二进制帧协议是否正确。
//
// 准备一个 16kHz、单声道、16bit 的 wav（用 Audacity / ffmpeg 转）：
//   ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le out.wav
//
// 用法（PowerShell）：
//   $env:VOLC_ASR_APPID="你的AppID"
//   $env:VOLC_ASR_TOKEN="你的AccessToken"
//   node tools/asr-probe.mjs out.wav

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import WebSocket from 'ws'

const file = process.argv[2]
if (!file) {
  console.error('用法：node tools/asr-probe.mjs <16k-mono.wav>')
  process.exit(1)
}

const appId = process.env.VOLC_ASR_APPID || ''
const token = process.env.VOLC_ASR_TOKEN || ''
const apiKey = process.env.VOLC_ASR_APIKEY || ''
const resource = process.env.VOLC_ASR_RESOURCE || 'volc.seedasr.sauc.duration'
if (!apiKey && (!appId || !token)) {
  console.error('缺少凭证：设置 VOLC_ASR_APIKEY（新版控制台），或 VOLC_ASR_APPID + VOLC_ASR_TOKEN（旧版）')
  process.exit(1)
}

/** 从 wav 里取 data 块，跳过 44 字节标准头 */
function readPcm(path) {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 wav 文件')
  }
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      return { pcm: buf.subarray(body, body + size), sampleRate, channels, bits }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('wav 里没有 data 块')
}

const { pcm, sampleRate, channels, bits } = readPcm(file)
console.log(`音频：${(pcm.length / 2 / sampleRate).toFixed(2)}s · ${sampleRate}Hz · ${channels}ch · ${bits}bit`)
if (sampleRate !== 16000 || channels !== 1 || bits !== 16) {
  console.warn('⚠ 识别接口要求 16kHz / 单声道 / 16bit，当前参数可能失败')
}

const URL = process.env.VOLC_ASR_ENDPOINT ||
  (resource.includes('seedasr')
    ? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
    : 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel')
console.log('endpoint', URL)
const POS = 0b0001
const NEG_WITH = 0b0011

function frame(type, flags, payload, seq) {
  const header = Buffer.from([0x11, (type << 4) | flags, 0x10, 0x00])
  const seqBuf = Buffer.alloc(4)
  seqBuf.writeInt32BE(seq, 0)
  const sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, seqBuf, sizeBuf, payload])
}

const ws = new WebSocket(URL, {
  headers: apiKey
    ? {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resource,
        'X-Api-Connect-Id': randomUUID()
      }
    : {
        'X-Api-App-Key': appId,
        'X-Api-Access-Key': token,
        'X-Api-Resource-Id': resource,
        'X-Api-Connect-Id': randomUUID()
      },
  handshakeTimeout: 8000
})

let seq = 1
let lastText = ''

ws.on('open', () => {
  console.log('✓ WebSocket 已连接')
  ws.send(
    frame(
      0b0001,
      POS,
      Buffer.from(
        JSON.stringify({
          user: { uid: 'bewithu-probe' },
          audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
          request: {
            model_name: 'bigmodel',
            enable_itn: true,
            enable_punc: true,
            enable_ddc: true,
            end_window_size: 800,
            show_utterances: false,
            result_type: 'full'
          }
        })
      ),
      seq++
    )
  )

  const chunk = 3200 // 100ms
  let offset = 0
  const timer = setInterval(() => {
    if (offset >= pcm.length) {
      clearInterval(timer)
      ws.send(frame(0b0010, NEG_WITH, Buffer.alloc(0), -seq))
      console.log('→ 已发送结束帧，等待最终结果…')
      return
    }
    const part = pcm.subarray(offset, Math.min(pcm.length, offset + chunk))
    offset += chunk
    ws.send(frame(0b0010, POS, part, seq++))
  }, 100)
})

ws.on('message', (data) => {
  const buf = data
  const headerSize = (buf[0] & 0x0f) * 4
  const type = buf[1] >> 4
  const flags = buf[1] & 0x0f
  const compression = buf[2] & 0x0f
  let offset = headerSize
  if (flags === POS || flags === 0b0010 || flags === NEG_WITH) offset += 4
  if (type === 0b1111) {
    const code = buf.readUInt32BE(offset)
    offset += 4
    const size = buf.readUInt32BE(offset)
    offset += 4
    console.error('✕ 服务端错误', code, buf.subarray(offset, offset + size).toString('utf8'))
    process.exit(1)
  }
  const size = buf.readUInt32BE(offset)
  offset += 4
  let payload = buf.subarray(offset, offset + size)
  if (compression === 1) payload = gunzipSync(payload)
  let json
  try {
    json = JSON.parse(payload.toString('utf8'))
  } catch {
    return
  }
  const text = json?.result?.text ?? ''
  if (text && text !== lastText) {
    lastText = text
    console.log('…', text)
  }
  if ((flags & 0b0010) !== 0) {
    console.log('\n✓ 最终结果：', lastText || '（空）')
    ws.close()
    process.exit(0)
  }
})

ws.on('unexpected-response', (_req, res) => {
  console.error('✕ 握手被拒绝 HTTP', res.statusCode, res.statusMessage)
  const rid = res.headers['x-tt-logid'] || res.headers['x-api-request-id']
  if (rid) console.error('  LogID:', rid)
  let body = ''
  res.on('data', (d) => (body += d))
  res.on('end', () => {
    console.error('  响应体:', body.slice(0, 600))
    process.exit(1)
  })
})

ws.on('error', (e) => {
  console.error('✕ 连接失败：', e.message)
  process.exit(1)
})

ws.on('close', () => {
  console.log('连接已关闭，最后结果：', lastText || '（空）')
  process.exit(0)
})

setTimeout(() => {
  console.error('✕ 超时（20s）')
  process.exit(1)
}, 20000)
