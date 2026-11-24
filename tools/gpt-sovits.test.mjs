import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/services/tts.ts')) {
      if (specifier === '../logger') return { shortCircuit: true, url: 'data:text/javascript,export const log=()=>{}' }
      if (specifier === '../store/usage') return { shortCircuit: true, url: 'data:text/javascript,export const recordTtsChars=()=>{}' }
      if (specifier.startsWith('./')) return next(specifier + '.ts', context)
    }
    return next(specifier, context)
  }
})
const { decodeSovitsWav } = await import('../src/main/services/gpt-sovits.ts')
const { synthesize } = await import('../src/main/services/tts.ts')
const { DEFAULT_SETTINGS } = await import('../src/shared/defaults.ts')

function wav() {
  const output = Buffer.alloc(58)
  output.write('RIFF', 0)
  output.writeUInt32LE(output.length - 8, 4)
  output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(2, 22)
  output.writeUInt32LE(32000, 24)
  output.writeUInt16LE(16, 34)
  output.write('JUNK', 36)
  output.writeUInt32LE(1, 40)
  output.write('data', 46)
  output.writeUInt32LE(4, 50)
  output.writeInt16LE(1400, 54)
  output.writeInt16LE(600, 56)
  return output
}

function extensibleWav() {
  const output = Buffer.alloc(72)
  output.write('RIFF', 0)
  output.writeUInt32LE(output.length - 8, 4)
  output.write('WAVEfmt ', 8)
  output.writeUInt32LE(40, 16)
  output.writeUInt16LE(0xfffe, 20)
  output.writeUInt16LE(2, 22)
  output.writeUInt32LE(32000, 24)
  output.writeUInt32LE(128000, 28)
  output.writeUInt16LE(4, 32)
  output.writeUInt16LE(16, 34)
  output.writeUInt16LE(22, 36)
  output.writeUInt16LE(16, 38)
  output.writeUInt32LE(3, 40)
  output.writeUInt32LE(1, 44)
  output.writeUInt16LE(0, 48)
  output.writeUInt16LE(0x0010, 50)
  output.write('\x80\x00\x00\xaa\x00\x38\x9b\x71', 52, 'binary')
  output.write('data', 60)
  output.writeUInt32LE(4, 64)
  output.writeInt16LE(1400, 68)
  output.writeInt16LE(600, 70)
  return output
}

test('GPT-SoVITS accepts WAVE_FORMAT_EXTENSIBLE PCM16', () => {
  const audio = decodeSovitsWav(extensibleWav())
  assert.equal(audio.sampleRate, 32000)
  assert.equal(audio.pcm.length, 2)
  assert.equal(audio.pcm.readInt16LE(), 1000)
})

test('GPT-SoVITS posts API v2 fields and decodes WAV at its actual sample rate', async (t) => {
  const settings = structuredClone(DEFAULT_SETTINGS.tts)
  settings.provider = 'gpt-sovits'
  settings.speed = 25
  settings.gptSovits.baseUrl = 'http://127.0.0.1:9880/prefix/tts/'
  settings.gptSovits.refAudioPath = 'D:\\audio\\参考.wav'
  settings.gptSovits.promptText = '参考文字'
  const signal = new AbortController().signal
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'http://127.0.0.1:9880/prefix/tts')
    assert.equal(options.method, 'POST')
    assert.equal(options.signal, signal)
    assert.deepEqual(JSON.parse(options.body), {
      text: '你好', text_lang: 'auto', ref_audio_path: settings.gptSovits.refAudioPath, prompt_text: '参考文字',
      prompt_lang: 'zh', text_split_method: 'cut5', speed_factor: 1.25, media_type: 'wav', streaming_mode: false
    })
    return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } })
  })
  const audio = await Array.fromAsync(synthesize(settings, '你好', signal))
  assert.equal(audio.length, 1)
  assert.equal(audio[0].sampleRate, 32000)
  assert.equal(audio[0].pcm.length, 2)
  assert.equal(audio[0].pcm.readInt16LE(), 1000)
  assert.throws(() => decodeSovitsWav(wav().subarray(0, -1)), /无效音频/)
})
