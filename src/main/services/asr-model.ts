import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { modelDir, modelReady } from './local-asr'
import { log } from '../logger'

const REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
/** hf-mirror 国内可用，HF 官方作为兜底 */
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']

const FILES = [
  { name: 'model.int8.onnx', size: 239233841 },
  { name: 'tokens.txt', size: 0 }
]

export interface ModelProgress {
  state: 'idle' | 'downloading' | 'ready' | 'error'
  file: string
  bytes: number
  total: number
  error?: string
}

let progress: ModelProgress = { state: 'idle', file: '', bytes: 0, total: 0 }
let downloading = false
let lastEmit = 0

export function modelStatus(): ModelProgress {
  if (downloading) return { ...progress, state: 'downloading' }
  if (modelReady()) return { state: 'ready', file: '', bytes: 0, total: 0 }
  return { ...progress, state: progress.state === 'error' ? 'error' : 'idle' }
}

function emit(onProgress: (p: ModelProgress) => void, force = false): void {
  const now = Date.now()
  if (!force && now - lastEmit < 400) return
  lastEmit = now
  onProgress(modelStatus())
}

async function downloadFile(
  file: { name: string; size: number },
  onProgress: (p: ModelProgress) => void
): Promise<void> {
  const target = join(modelDir(), file.name)
  if (existsSync(target)) {
    const size = statSync(target).size
    if (!file.size || size === file.size) return
    unlinkSync(target)
  }

  for (const mirror of MIRRORS) {
    const url = `${mirror}/${REPO}/resolve/main/${file.name}`
    progress = { state: 'downloading', file: file.name, bytes: 0, total: file.size }
    emit(onProgress, true)
    try {
      log('model: 下载', url)
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const tmp = `${target}.part`
      let received = 0
      const body = Readable.fromWeb(res.body as never)
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        progress = { state: 'downloading', file: file.name, bytes: received, total: file.size }
        emit(onProgress)
      })
      await pipeline(body, createWriteStream(tmp))
      renameSync(tmp, target)
      if (file.size && statSync(target).size !== file.size) {
        throw new Error('文件大小不匹配')
      }
      progress = { state: 'downloading', file: file.name, bytes: received, total: file.size }
      emit(onProgress, true)
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('model: 镜像失败', mirror, msg)
      progress = { state: 'error', file: file.name, bytes: 0, total: file.size, error: msg }
      emit(onProgress, true)
    }
  }
  throw new Error('模型下载失败，请检查网络后重试')
}

export async function downloadModel(onProgress: (p: ModelProgress) => void): Promise<void> {
  if (downloading) throw new Error('正在下载中，请稍候')
  if (modelReady() && progress.state !== 'error') {
    onProgress({ state: 'ready', file: '', bytes: 0, total: 0 })
    return
  }
  downloading = true
  try {
    mkdirSync(modelDir(), { recursive: true })
    for (const file of FILES) await downloadFile(file, onProgress)
    progress = { state: 'ready', file: '', bytes: 0, total: 0 }
    onProgress(modelStatus())
    log('model: 本地识别模型已就绪')
  } finally {
    downloading = false
  }
}

export function deleteModel(): void {
  try {
    for (const f of FILES) {
      const p = join(modelDir(), f.name)
      if (existsSync(p)) unlinkSync(p)
    }
    progress = { state: 'idle', file: '', bytes: 0, total: 0 }
  } catch (e) {
    log('model: 删除失败', e)
  }
}
