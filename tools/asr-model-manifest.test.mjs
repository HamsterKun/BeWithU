import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../src/main/services/asr-model-manifest.ts' && context.parentURL?.includes('asr-model-manifest.test.mjs')) {
    return { shortCircuit: true, url: new URL('../src/main/services/asr-model-manifest.ts', import.meta.url).href }
  }
  return next(specifier, context)
} })
const { ASR_MODEL_ARCHIVE, ASR_MODEL_FILES } = await import('../src/main/services/asr-model-manifest.ts')

test('ASR archive pins official release metadata and exact model files', () => {
  assert.equal(ASR_MODEL_ARCHIVE.url.startsWith('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'), true)
  assert.equal(ASR_MODEL_ARCHIVE.size, 163002883)
  assert.equal(ASR_MODEL_ARCHIVE.sha256, '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e')
  assert.deepEqual(ASR_MODEL_FILES.map((f) => f.name), ['model.int8.onnx', 'tokens.txt'])
  assert.deepEqual(ASR_MODEL_FILES.map((f) => f.size), [239233841, 315894])
  assert.ok(ASR_MODEL_FILES.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)))
})
