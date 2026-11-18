// 火山引擎「豆包语音合成大模型 V3」连通性测试脚本
// 不依赖 Electron，用来在接入 UI 之前先把账号、音色、协议跑通。
//
// 用法（PowerShell）：
//   $env:VOLC_TTS_APPID="你的AppID"
//   $env:VOLC_TTS_TOKEN="你的AccessToken"
//   node tools/tts-probe.mjs --text "你好，我是你的桌面伙伴" --out probe.wav
//
// 也支持 API Key 方式：
//   $env:VOLC_TTS_APIKEY="你的API Key"
//
// 可选参数：--speaker zh_female_vv_uranus_bigtts --resource seed-tts-2.0 --rate 24000

import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const text = arg('text', '你好，我是你的桌面伙伴，语音合成已经连上了')
const speaker = arg('speaker', 'zh_female_vv_uranus_bigtts')
const resource = arg('resource', 'seed-tts-2.0')
const rate = Number(arg('rate', '24000'))
const out = arg('out', 'probe.wav')

const appId = process.env.VOLC_TTS_APPID || ''
const token = process.env.VOLC_TTS_TOKEN || ''
const apiKey = process.env.VOLC_TTS_APIKEY || ''

if (!apiKey && (!appId || !token)) {
  console.error('缺少凭证：请设置 VOLC_TTS_APPID + VOLC_TTS_TOKEN，或 VOLC_TTS_APIKEY')
  process.exit(1)
}

const headers = {
  'Content-Type': 'application/json',
  Accept: 'text/event-stream',
  'X-Api-Request-Id': randomUUID(),
  'X-Api-Connect-Id': randomUUID(),
  'X-Api-Resource-Id': resource
}
if (apiKey) headers['X-Api-Key'] = apiKey
else {
  headers['X-Api-App-Id'] = appId
  headers['X-Api-Access-Key'] = token
}

const url = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse'
const body = {
  user: { uid: 'bewithu-probe' },
  req_params: {
    text,
    speaker,
    audio_params: { format: 'pcm', sample_rate: rate, speech_rate: 0, loudness_rate: 0 },
    additions: JSON.stringify({
      disable_markdown_filter: true,
      max_length_to_filter_parenthesis: 100
    })
  }
}

const started = Date.now()
console.log(`POST ${url}`)
console.log(`speaker=${speaker} resource=${resource} text=${text.slice(0, 20)}…`)

let res
try {
  res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
} catch (e) {
  console.error('网络错误：', e.message)
  process.exit(1)
}

console.log('HTTP', res.status, res.headers.get('content-type'))
if (!res.ok) {
  console.error(await res.text())
  process.exit(1)
}

const decoder = new TextDecoder()
let buffer = ''
let bytes = 0
let firstAt = 0
const chunks = []

for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith(':') || line.startsWith('event:')) continue
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line
    if (!payload || payload === '[DONE]') continue
    let obj
    try {
      obj = JSON.parse(payload)
    } catch {
      console.log('无法解析的行：', line.slice(0, 160))
      continue
    }
    if (obj.code !== undefined && obj.code !== 0 && obj.code !== 3000 && obj.code !== 20000000) {
      console.error('接口返回错误：', JSON.stringify(obj).slice(0, 400))
      process.exit(1)
    }
    const b64 = obj.data ?? obj.audio ?? obj.payload
    if (typeof b64 === 'string' && b64.length) {
      if (!firstAt) firstAt = Date.now() - started
      const buf = Buffer.from(b64, 'base64')
      bytes += buf.length
      chunks.push(buf)
    }
  }
}

if (!bytes) {
  console.error('没有拿到音频数据（检查音色 ID、Resource ID 是否匹配）')
  process.exit(1)
}

const pcm = Buffer.concat(chunks)
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(rate, 24)
header.writeUInt32LE(rate * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)
writeFileSync(out, Buffer.concat([header, pcm]))

console.log(`\n✓ 成功：${(pcm.length / 2 / rate).toFixed(2)}s 音频`)
console.log(`  首包 ${firstAt}ms · 总计 ${Date.now() - started}ms`)
console.log(`  已写入 ${out}，可直接双击播放`)
