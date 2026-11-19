import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { modelDir, modelReady } from './local-asr'
import { log } from '../logger'
import { ASR_MODEL_ARCHIVE, ASR_MODEL_FILES } from './asr-model-manifest'

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

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

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

async function downloadArchive(path: string, onProgress: (p: ModelProgress) => void): Promise<void> {
  const res = await fetch(ASR_MODEL_ARCHIVE.url, { signal: AbortSignal.timeout(120000) })
  if (!res.ok || !res.body) throw new Error(`模型下载失败：HTTP ${res.status}`)
  let received = 0
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > ASR_MODEL_ARCHIVE.size) body.destroy(new Error('模型归档超过 manifest 声明大小'))
    progress = { state: 'downloading', file: ASR_MODEL_ARCHIVE.name, bytes: received, total: ASR_MODEL_ARCHIVE.size }
    emit(onProgress)
  })
  await pipeline(body, createWriteStream(path, { flags: 'wx' }))
  if (received !== ASR_MODEL_ARCHIVE.size || await hashFile(path) !== ASR_MODEL_ARCHIVE.sha256) {
    throw new Error('模型归档大小或 SHA-256 校验失败')
  }
}

function extractArchive(archive: string, staging: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', staging], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => child.kill(), 60000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动系统 tar 解包：${error.message}`))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`模型归档解包失败（exit ${code ?? 'signal'}）`))
    })
  })
}

export async function downloadModel(onProgress: (p: ModelProgress) => void): Promise<void> {
  if (downloading) throw new Error('正在下载中，请稍候')
  if (modelReady() && progress.state !== 'error') {
    onProgress({ state: 'ready', file: '', bytes: 0, total: 0 })
    return
  }
  downloading = true
  const stage = join(tmpdir(), `bwu-asr-${process.pid}-${Date.now()}`)
  const archive = join(stage, ASR_MODEL_ARCHIVE.name)
  let archiveStage = true
  try {
    mkdirSync(stage, { recursive: false })
    const staging = join(stage, 'extract')
    mkdirSync(staging)
    progress = { state: 'downloading', file: ASR_MODEL_ARCHIVE.name, bytes: 0, total: ASR_MODEL_ARCHIVE.size }
    emit(onProgress, true)
    await downloadArchive(archive, onProgress)
    await extractArchive(archive, staging)

    const extractedRoot = resolve(staging, ASR_MODEL_ARCHIVE.root)
    for (const file of ASR_MODEL_FILES) {
      const path = resolve(extractedRoot, file.name)
      if (!path.startsWith(`${extractedRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error('模型归档包含无效路径')
      }
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== file.size || await hashFile(path) !== file.sha256) {
        throw new Error(`模型文件校验失败：${file.name}`)
      }
    }

    const targetDir = modelDir()
    mkdirSync(targetDir, { recursive: true })
    for (const file of ASR_MODEL_FILES) {
      const source = join(extractedRoot, file.name)
      const target = join(targetDir, file.name)
      const stagedTarget = `${target}.${process.pid}.part`
      try {
        if (existsSync(stagedTarget)) unlinkSync(stagedTarget)
        copyFileSync(source, stagedTarget)
        if (await hashFile(stagedTarget) !== file.sha256) throw new Error(`模型文件发布校验失败：${file.name}`)
        renameSync(stagedTarget, target)
      } finally {
        if (existsSync(stagedTarget)) unlinkSync(stagedTarget)
      }
    }
    progress = { state: 'ready', file: '', bytes: 0, total: 0 }
    onProgress(modelStatus())
    log('model: 本地识别模型已就绪', ASR_MODEL_ARCHIVE.name)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    progress = { state: 'error', file: ASR_MODEL_ARCHIVE.name, bytes: 0, total: ASR_MODEL_ARCHIVE.size, error: message }
    emit(onProgress, true)
    throw e
  } finally {
    if (archiveStage) rmSync(stage, { recursive: true, force: true })
    downloading = false
  }
}

export function deleteModel(): void {
  try {
    for (const file of ASR_MODEL_FILES) {
      const path = join(modelDir(), file.name)
      if (existsSync(path)) unlinkSync(path)
    }
    progress = { state: 'idle', file: '', bytes: 0, total: 0 }
  } catch (e) {
    log('model: 删除失败', e)
  }
}
