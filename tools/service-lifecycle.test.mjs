import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'bwu-services-'))
globalThis.__servicesFixture = { dir: root, reads: 0, list: () => [] }
const mock = (source) => ({ shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` })
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (specifier === 'electron') return mock('export const app = {getPath: () => globalThis.__servicesFixture.dir}; export const utilityProcess = {}')
    if (specifier === '../logger') return mock('export const log = () => {}')
    if (specifier === './llm' && parent.endsWith('/model-info.ts')) {
      return mock('export const listModelInfo = (...args) => globalThis.__servicesFixture.list(...args)')
    }
    if (specifier === 'node:fs' && parent.endsWith('/local-asr.ts')) {
      return mock(`export * from 'node:fs'; import { createReadStream as read } from 'node:fs';
        export const createReadStream = (...args) => { globalThis.__servicesFixture.reads++; return read(...args) }`)
    }
    if (specifier === './asr-model-manifest') {
      const hash = createHash('sha256').update('valid').digest('hex')
      return mock(`export const ASR_MODEL_FILES = [{name: 'model.bin', size: 5, sha256: '${hash}'}];
        export const ASR_MODEL_ARCHIVE = {url:'http://localhost/fixture', name:'model.tar', size:20}`)
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  }
})

test('the model status reports a failed download and accepts another attempt', async (t) => {
  const { downloadModel, modelStatus } = await import('../src/main/services/asr-model.ts')
  const states = []
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture offline') })
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(downloadModel((p) => states.push(p.state)), /fixture offline/)
    assert.equal((await modelStatus()).state, 'error')
  }
  assert.deepEqual(states, ['downloading', 'error', 'downloading', 'error'])
})

test('the hotkey readiness check reads metadata, while async verification rechecks changed model content', async () => {
  const { modelDir, modelReady, verifyModel } = await import('../src/main/services/local-asr.ts')
  mkdirSync(modelDir(), { recursive: true })
  const file = join(modelDir(), 'model.bin')
  writeFileSync(file, 'valid')
  for (let i = 0; i < 10; i++) assert.equal(modelReady(), true)
  assert.equal(globalThis.__servicesFixture.reads, 0)
  const first = verifyModel()
  assert.equal(verifyModel(), first)
  assert.equal(await first, true)
  assert.equal(await verifyModel(), true)
  assert.equal(globalThis.__servicesFixture.reads, 1)
  writeFileSync(file, 'wrong')
  assert.equal(await verifyModel(), false)
  assert.equal(globalThis.__servicesFixture.reads, 2)
  assert.equal(modelReady(), false)
})

test('older model metadata responses cannot replace the current provider or reappear after clearing it', async () => {
  const { refreshModelInfo, providerWindow } = await import('../src/main/services/model-info.ts')
  const config = (name) => ({ baseUrl: `https://${name}.invalid`, model: 'same', apiKey: 'fixture' })
  let resolveOld
  globalThis.__servicesFixture.list = ({ baseUrl }) => baseUrl.includes('old')
    ? new Promise((resolve) => { resolveOld = resolve }) : [{ id: 'same', window: 64_000 }]
  const old = refreshModelInfo(config('old'))
  await refreshModelInfo(config('new'))
  resolveOld([{ id: 'same', window: 128_000 }])
  await old
  assert.equal(providerWindow('same'), 64_000)

  const pending = refreshModelInfo(config('old'))
  await refreshModelInfo({ ...config('new'), apiKey: '' }, true)
  resolveOld([{ id: 'same', window: 128_000 }])
  await pending
  assert.equal(providerWindow('same'), 0)
})

process.on('exit', () => rmSync(root, { recursive: true, force: true }))
