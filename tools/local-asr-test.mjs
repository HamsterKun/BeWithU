// 本地识别自检：下载 SenseVoice int8 模型（如缺）并对一个 16k 单声道 wav 做识别
// 用法：node tools/local-asr-test.mjs [wav路径]
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const MIRRORS = [
  `https://hf-mirror.com/${REPO}/resolve/main`,
  `https://huggingface.co/${REPO}/resolve/main`
]
const DIR = join(process.env.APPDATA || homedir(), 'BeWithU', 'models', 'sensevoice-2024-07-17')
const FILES = [
  { name: 'model.int8.onnx', size: 239233841 },
  { name: 'tokens.txt', size: 0 }
]

async function download(name, expectSize) {
  const target = join(DIR, name)
  if (existsSync(target)) {
    const size = statSync(target).size
    if (!expectSize || size === expectSize) {
      console.log(`✓ 已存在 ${name} (${(size / 1024 / 1024).toFixed(0)}MB)`)
      return target
    }
    console.log(`! ${name} 大小不对 (${size})，重新下载`)
    unlinkSync(target)
  }
  for (const base of MIRRORS) {
    const url = `${base}/${name}`
    console.log(`下载 ${url}`)
    const started = Date.now()
    try {
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const tmp = `${target}.part`
      let received = 0
      let lastLog = 0
      const body = Readable.fromWeb(res.body)
      body.on('data', (chunk) => {
        received += chunk.length
        const now = Date.now()
        if (now - lastLog > 2000) {
          lastLog = now
          const mb = (received / 1024 / 1024).toFixed(0)
          const sec = (now - started) / 1000
          console.log(`  ${mb}MB · ${(received / 1024 / 1024 / sec).toFixed(1)}MB/s`)
        }
      })
      await pipeline(body, createWriteStream(tmp))
      renameSync(tmp, target)
      console.log(`✓ ${name} 完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
      return target
    } catch (e) {
      console.log(`  ✕ ${e.message}，换镜像`)
    }
  }
  throw new Error(`${name} 下载失败`)
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
for (const f of FILES) await download(f.name, f.size)

const wav = process.argv[2] || 'asr-test.wav'
const wave = sherpa.readWave(wav)
console.log(`音频 ${WAVE_INFO(wave)}`)

const t0 = Date.now()
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: {
      model: join(DIR, 'model.int8.onnx'),
      language: 'zh',
      useInverseTextNormalization: 1
    },
    tokens: join(DIR, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0
  }
})
const loadMs = Date.now() - t0

const t1 = Date.now()
const stream = recognizer.createStream()
stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
recognizer.decode(stream)
const text = recognizer.getResult(stream).text
const asrMs = Date.now() - t1
const dur = wave.samples.length / wave.sampleRate

console.log(`\n模型加载 ${loadMs}ms · 识别 ${asrMs}ms（音频 ${dur.toFixed(2)}s，RTF ${(asrMs / 1000 / dur).toFixed(3)}）`)
console.log('识别结果：', JSON.stringify(text))

function WAVE_INFO(w) {
  return `${w.sampleRate}Hz · ${(w.samples.length / w.sampleRate).toFixed(2)}s`
}
