/* 本地识别 worker（Electron utilityProcess）
 * 由主进程 fork，加载 sherpa-onnx + SenseVoice int8，收 PCM 回调识别结果。
 * 独立进程是为了：模型常驻内存不拖累主进程、崩溃不带崩 App、闲置可整进程回收。
 */

const port = (process as unknown as { parentPort: { on: Function; postMessage: Function } }).parentPort

let recognizer: any = null
let loading = false

function reply(msg: unknown): void {
  try {
    port.postMessage(msg)
  } catch (e) {
    // ignore
  }
}

function initSherpa(): any {
  // 让原生依赖能在打包后的 asar.unpacked / resources 布局里找到 DLL
  const path = require('node:path') as typeof import('node:path')
  const fs = require('node:fs') as typeof import('node:fs')
  const candidates = [
    path.join(process.resourcesPath || '', 'sherpa'),
    path.join(__dirname, '..', '..', 'node_modules', 'sherpa-onnx-win-x64'),
    path.join(__dirname, '..', '..', 'node_modules', '.pnpm')
  ]
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(dir)) process.env.PATH = `${dir};${process.env.PATH || ''}`
    } catch {
      /* ignore */
    }
  }
  return require('sherpa-onnx-node')
}

function loadModel(modelDir: string, numThreads: number): void {
  if (recognizer || loading) return
  loading = true
  try {
    const path = require('node:path') as typeof import('node:path')
    const sherpa = initSherpa()
    const t0 = Date.now()
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: path.join(modelDir, 'model.int8.onnx'),
          language: 'zh',
          useInverseTextNormalization: 1
        },
        tokens: path.join(modelDir, 'tokens.txt'),
        numThreads,
        provider: 'cpu',
        debug: 0
      }
    })
    loading = false
    reply({ type: 'ready', loadMs: Date.now() - t0, version: sherpa.version })
  } catch (e) {
    loading = false
    reply({ type: 'init-error', message: e instanceof Error ? e.message : String(e) })
  }
}

port.on('message', (event: { data: any }) => {
  const msg = event?.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'init') {
    loadModel(String(msg.modelDir), Number(msg.numThreads) || 2)
    return
  }

  if (msg.type === 'recognize') {
    if (!recognizer) {
      reply({ type: 'error', id: msg.id, message: '模型还没加载好' })
      return
    }
    try {
      const t0 = Date.now()
      const samples = msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples)
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples, sampleRate: 16000 })
      recognizer.decode(stream)
      const text = recognizer.getResult(stream).text ?? ''
      reply({ type: 'result', id: msg.id, text, ms: Date.now() - t0 })
    } catch (e) {
      reply({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) })
    }
    return
  }

  if (msg.type === 'dispose') {
    recognizer = null
    process.exit(0)
  }
})
