import type { ContextInfo, Phase, Settings } from '../../shared/types'
import { IPC } from '../../shared/ipc'
import { DEFAULT_VISION_NOTE } from '../../shared/defaults'
import { historyStore } from '../store/history'
import { contextStore } from '../store/context'
import { settingsStore } from '../store/settings'
import { log } from '../logger'
import { VolcAsr } from './asr'
import { AsrGeneration } from './asr-generation'
import { shouldRetryBreeze429, shouldRetryWithoutImage } from './retry-policy'
import { streamChat, type ChatMessage } from './llm'
import { synthesize } from './tts'
import { SentenceSplitter } from './splitter'
import { summarizeConversation } from './summarizer'
import {
  assembleMessages,
  budgetFor,
  calibrate,
  estimatePrompt,
  needsCompaction,
  splitForCompaction,
  summaryCharsFor
} from './context'
import { resolveModelWindow } from '../../shared/model-window'
import { providerWindow } from './model-info'
import { captureScreen, type ScreenCapture } from './vision'
import { LocalAsrSession } from './local-asr'
import { modelReady } from './local-asr'
import { runAgentTask } from '../agent/runner'
import { runDsh } from './dsh'
import { cancelApprovalsForTurn, pendingApproval, requestApproval, resolvePendingByText } from '../agent/approval'

/** 云端 / 本地识别共用的会话接口 */
type AsrSession = {
  sendAudio(pcm: Buffer): void
  finish(): Promise<string>
  cancel(): void
}

import {
  broadcastPhase,
  getBallWindow,
  hideBubble,
  isBallVisible,
  isBubbleFocused,
  isBubblePinned,
  sendAgentProgress,
  sendBubble,
  showBallWindow,
  showBubble
} from '../windows'
import { isHotkeyFallback, prettyChord } from '../input/hotkey'
import { effectiveVoiceMode } from '../input/voice-mode'
import { formatHits, webSearch } from './web-search'

/** 闲聊模式判断"这句话要不要联网"：够不够像时效性问题 */
const SEARCH_HINT =
  /(最新|今天|今日|昨天|前天|最近|这几天|这周|本周|本月|今年|新闻|热搜|头条|比分|赛果|赛程|排名|价格|多少钱|汇率|股价|票房|发布|上线|发售|开售|新版本|更新了什么|谁是|怎么样了|发生了什么|有没有出|什么时候出|夺冠|冠军|销量)/

const MAX_HOLD_MS = 60000

class SpeechQueue {
  private items: { seq: number; text: string }[] = []
  private running = new Set<number>()
  private ended = false
  private aborted = false
  private controller = new AbortController()
  private seq = 0
  /** 第一句必须最先开始推流，否则渲染端可能先收到第二句、把第一句判为过期 */
  private firstStarted = false

  constructor(
    private tts: Settings['tts'],
    private onChunk: (seq: number, pcm: Buffer | null, sampleRate?: number) => void,
    private onEnd: () => void,
    private concurrency = 2
  ) {}

  add(text: string): void {
    if (this.aborted) return
    const seq = this.seq++
    this.items.push({ seq, text })
    void this.pump()
  }

  finish(): void {
    this.ended = true
    this.maybeEnd()
  }

  abort(): void {
    this.aborted = true
    this.items = []
    this.controller.abort()
  }

  get idle(): boolean {
    return this.aborted || (this.ended && !this.items.length && this.running.size === 0)
  }

  private async pump(): Promise<void> {
    const limit = this.firstStarted ? this.concurrency : 1
    while (!this.aborted && this.running.size < limit && this.items.length) {
      const item = this.items.shift()!
      this.running.add(item.seq)
      void this.run(item)
    }
  }

  private async run(item: { seq: number; text: string }): Promise<void> {
    const attempt = async (): Promise<void> => {
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)])
      for await (const chunk of synthesize(this.tts, item.text, signal)) {
        if (this.aborted) break
        this.onChunk(item.seq, chunk.pcm, chunk.sampleRate)
        if (!this.firstStarted && item.seq === 0) {
          this.firstStarted = true
          void this.pump()
        }
      }
    }
    try {
      try {
        await attempt()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Breeze 并发超限（429）：串行 + 退避重试一次，否则整句被吞
        if (!this.aborted && shouldRetryBreeze429(e)) {
          await new Promise((r) => setTimeout(r, 1200))
          if (!this.aborted) await attempt()
          else return
        } else {
          throw e
        }
      }
    } catch (e) {
      if (!this.aborted) log('tts: 合成失败', e instanceof Error ? e.message : e)
    } finally {
      this.onChunk(item.seq, null)
      if (!this.firstStarted && item.seq === 0) this.firstStarted = true
      this.running.delete(item.seq)
      void this.pump()
      this.maybeEnd()
    }
  }

  private maybeEnd(): void {
    if (this.aborted) return
    if (this.ended && !this.items.length && this.running.size === 0) this.onEnd()
  }
}

class Conversation {
  private phase: Phase = 'idle'
  private listening = false
  private holdStartedAt = 0
  private pcmQueue: Buffer[] = []
  private asr: AsrSession | null = null
  private asrReady = false
  private readonly asrGeneration = new AsrGeneration()
  private asrStarting: Promise<AsrSession> | null = null
  private asrFinishing: AsrSession | null = null
  private turnId = 0
  private abortLlm: AbortController | null = null
  private speech: SpeechQueue | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private maxHoldTimer: NodeJS.Timeout | null = null
  private previewSeq = 900000
  /** 正在进行的压缩：下一轮开始前必须等它，否则会带着旧摘要重复压缩 */
  private compacting: Promise<void> | null = null
  private compactAbort: AbortController | null = null
  private ctxGen = 0
  private visionWarned = false
  /** 最近一次请求的真实/估算 token，用于校准与展示 */
  private lastUsage: { actual: number; estimated: number; cacheHit: number | null } | null = null

  get currentPhase(): Phase {
    return this.phase
  }

  private setPhase(phase: Phase, note?: string): void {
    this.phase = phase
    broadcastPhase(phase)
    if (note) sendBubble({ type: 'phase', phase, note })
  }

  private notify(
    kind: 'info' | 'error' | 'success',
    text: string,
    action?: 'open-settings' | 'open-voice'
  ): void {
    sendBubble({ type: 'notice', notice: { kind, text, action } })
  }

  private clearHideTimer(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
  }

  private scheduleHide(): void {
    this.clearHideTimer()
    const s = settingsStore.get()
    if (s.bubble.keepOpen) return
    this.hideTimer = setTimeout(
      () => {
        // 正在打字时不自动收起
        if (this.phase === 'idle' && !isBubblePinned() && !isBubbleFocused()) hideBubble()
      },
      Math.max(800, s.bubble.holdMs)
    )
  }

  /* ------------------------------------------------------------ hotkey ---- */

  onHotkey(phase: 'down' | 'up'): void {
    const s = settingsStore.get()
    // 降级监听拿不到真实的按下/抬起时序，只能按"切换模式"处理（REVIEW C7）
    const mode = effectiveVoiceMode(s.voice.mode, isHotkeyFallback())
    if (mode === 'toggle') {
      if (phase === 'down') {
        if (this.listening) void this.stopListening()
        else void this.startListening()
      }
      return
    }
    if (phase === 'down') {
      if (!this.listening) void this.startListening()
    } else if (this.listening) {
      void this.stopListening()
    }
  }

  /* ----------------------------------------------------------- capture ---- */

  async startListening(): Promise<void> {
    if (this.listening || this.asrStarting) return
    const s = settingsStore.get()
    this.clearHideTimer()
    // 球可能被「隐藏悬浮球 / 隐藏全部窗口」收起来了，用侧键唤醒时一起叫回来
    if (!isBallVisible()) showBallWindow()

    if (this.phase === 'speaking' || this.phase === 'thinking' || this.phase === 'acting') {
      if (s.voice.bargeIn && !pendingApproval()) this.interrupt()
    }

    const useLocal = s.asr.mode === 'local'
    const asrConfigured =
      s.asr.authMode === 'apikey'
        ? Boolean(s.asr.apiKey.trim())
        : Boolean(s.asr.appId.trim() && s.asr.accessToken.trim())
    if (useLocal ? !modelReady() : !asrConfigured) {
      showBubble()
      this.notify(
        'error',
        useLocal
          ? '还没有下载语音识别模型，请到「设置 → 语音」下载'
          : s.asr.authMode === 'apikey'
            ? '还没有填写语音识别的 API Key，请到设置里填写'
            : '还没有填写语音识别的 AppID / Token，请到设置里填写',
        'open-voice'
      )
      this.setPhase('idle')
      this.scheduleHide()
      return
    }

    const generation = this.asrGeneration.begin()
    this.asr?.cancel()
    this.asr = null
    this.asrReady = false
    this.asrFinishing?.cancel()
    this.asrFinishing = null
    this.asrStarting = null
    this.listening = true
    this.holdStartedAt = Date.now()
    this.pcmQueue = []
    this.asrReady = false
    showBubble()
    sendBubble({
      type: 'meta',
      assistantName: s.ui.assistantName,
      silent: !s.tts.enabled || s.ui.muted,
      hotkey: prettyChord(s.voice.hotkey)
    })
    sendBubble({ type: 'user', text: '', final: false })
    this.setPhase('listening')
    getBallWindow()?.webContents.send(IPC.voiceRecStart)

    this.maxHoldTimer = setTimeout(() => {
      if (this.asrGeneration.current(generation) && this.listening) void this.stopListening()
    }, MAX_HOLD_MS)

    if (useLocal) {
      // 本地整句识别：先把 PCM 攒起来，松手后一次性识别
      this.asr = new LocalAsrSession()
      this.asrReady = true
      this.pcmQueue = []
      return
    }

    const starting = VolcAsr.create(s.asr, (text) => {
      if (!this.asrGeneration.current(generation) || (!this.listening && this.phase !== 'thinking')) return
      sendBubble({ type: 'user', text, final: false })
    })
    this.asrStarting = starting
    try {
      const asr = await starting
      if (!this.asrGeneration.current(generation)) {
        asr.cancel()
        return
      }
      this.asrStarting = null
      this.asr = asr
      this.asrReady = true
      for (const buf of this.pcmQueue) asr.sendAudio(buf)
      this.pcmQueue = []
      if (!this.listening) await this.finishAsrGeneration(generation, asr)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('asr: 建立连接失败', msg)
      if (this.asrGeneration.current(generation)) {
        this.asrStarting = null
        this.pcmQueue = []
        if (!this.listening) {
          this.setPhase('idle')
          this.scheduleHide()
        } else {
          this.listening = false
          getBallWindow()?.webContents.send(IPC.voiceRecStop)
          this.notify('error', msg, 'open-voice')
          this.setPhase('idle')
          this.scheduleHide()
        }
      }
    }
  }

  private async finishAsrGeneration(generation: number, asr: AsrSession): Promise<void> {
    if (!this.asrGeneration.current(generation)) return
    this.asr = null
    this.asrReady = false
    this.asrStarting = null
    this.asrFinishing = asr
    this.pcmQueue = []
    let text = ''
    try {
      text = (await asr.finish()).trim()
    } catch (e) {
      if (this.asrGeneration.current(generation)) {
        this.asrFinishing = null
        const msg = e instanceof Error ? e.message : String(e)
        this.notify('error', msg, 'open-voice')
        this.setPhase('idle')
        this.scheduleHide()
      }
      return
    }
    if (!this.asrGeneration.current(generation)) return
    this.asrFinishing = null
    if (!text) {
      this.notify('info', '没听清，按住再说一次')
      this.setPhase('idle')
      this.scheduleHide()
      return
    }
    await this.respond(text)
  }

  handlePcm(pcm: Buffer): void {
    if (!this.listening) return
    if (this.asr && this.asrReady) this.asr.sendAudio(pcm)
    else if (this.pcmQueue.length < 200) this.pcmQueue.push(pcm)
  }

  async stopListening(): Promise<void> {
    if (!this.listening) return
    this.listening = false
    if (this.maxHoldTimer) clearTimeout(this.maxHoldTimer)
    this.maxHoldTimer = null
    const s = settingsStore.get()
    getBallWindow()?.webContents.send(IPC.voiceRecStop)

    const held = Date.now() - this.holdStartedAt
    const generation = this.asrGeneration.currentId
    if (s.voice.mode === 'hold' && held < s.voice.minHoldMs) {
      this.asrGeneration.invalidate()
      this.asrStarting = null
      this.asr?.cancel()
      this.asrFinishing?.cancel()
      this.asrFinishing = null
      this.asr = null
      this.asrReady = false
      this.pcmQueue = []
      this.setPhase('idle')
      return
    }

    this.setPhase('thinking', '整理中')
    if (this.asr) {
      await this.finishAsrGeneration(generation, this.asr)
    } else if (!this.asrStarting) {
      this.pcmQueue = []
      this.setPhase('idle')
      this.scheduleHide()
    }
  }

  cancelListening(): void {
    if (this.listening) getBallWindow()?.webContents.send(IPC.voiceRecStop)
    this.asrGeneration.invalidate()
    this.asrStarting = null
    this.listening = false
    this.asr?.cancel()
    this.asrFinishing?.cancel()
    this.asrFinishing = null
    this.asr = null
    this.asrReady = false
    this.pcmQueue = []
    this.setPhase('idle')
  }

  onVoiceError(message: string): void {
    log('voice: 采集失败', message)
    this.cancelListening()
    showBubble()
    this.notify('error', `麦克风打不开：${message}`, 'open-voice')
    this.scheduleHide()
  }

  /* -------------------------------------------------------- typed input ---- */

  /** 气泡里打字发送：打断当前播报/录音，走与语音完全相同的回答流程 */
  async respondText(raw: string): Promise<void> {
    const text = raw.trim()
    if (!text) return
    this.clearHideTimer()
    if (resolvePendingByText(text, this.turnId) !== null) {
      sendBubble({ type: 'user', text, final: true })
      return
    }
    if (this.phase === 'speaking' || this.phase === 'thinking') this.interrupt()
    if (this.listening) this.cancelListening()
    showBubble()
    await this.respond(text)
  }

  /* ----------------------------------------------------------- respond ---- */

  private async respond(userText: string): Promise<void> {
    const s = settingsStore.get()

    // 正在等用户确认时，一句话"同意/拒绝"直接当作答复，不开启新回合
    if (resolvePendingByText(userText, this.turnId) !== null) {
      sendBubble({ type: 'user', text: userText, final: true })
      return
    }

    cancelApprovalsForTurn(this.turnId)
    this.abortLlm?.abort()
    const turn = ++this.turnId
    sendBubble({ type: 'user', text: userText, final: true })
    sendBubble({ type: 'assistant-reset' })

    if (s.dsh.enabled) {
      await this.respondWithDsh(userText, turn, s)
      return
    }

    // 开了 Agent：所有话都交给模型，由它自己决定是回一句还是调工具
    if (s.agent.enabled) {
      await this.respondWithAgent(userText, turn, s)
      return
    }

    this.setPhase('thinking', '思考中')

    if (!s.llm.model.trim() || !s.llm.baseUrl.trim() || !s.llm.apiKey.trim()) {
      this.notify('error', '还没配置大模型（Base URL / 模型名 / API Key）', 'open-settings')
      this.setPhase('idle')
      this.scheduleHide()
      return
    }

    // 有压缩在跑就先等它：否则会拿旧摘要重复压，前缀也会在发送前突然变一次
    await this.settleContext()

    const rawName = (s.ui.assistantName || '').trim()
    // 没设名字就不往提示词里塞自称，避免模型自称「TA」
    const systemPrompt =
      rawName && !s.llm.systemPrompt.includes(rawName)
        ? `${s.llm.systemPrompt}\n\n补充：你的名字是「${rawName}」，需要自称时用这个名字。`
        : s.llm.systemPrompt

    // 先取快照再加本轮输入，否则本轮会被当成历史重复发一遍
    const now = Date.now()
    contextStore.clampArchived(historyStore.endIndex())
    const historySnapshot = historyStore.since(contextStore.archivedUpTo())
    historyStore.add('user', userText)

    // 屏幕理解：开着就截图，看/不看由模型自己决定
    let shot: ScreenCapture | null = null
    if (s.llm.vision.enabled) {
      const res = await captureScreen()
      if (turn !== this.turnId) return
      if (res.ok) {
        shot = res.shot
        this.visionWarned = false
        log('vision: 已截屏', `${shot.width}x${shot.height} / ${(shot.bytes / 1024).toFixed(0)}KB`)
      } else if (res.reason === 'blank' && !this.visionWarned) {
        this.visionWarned = true
        this.notify(
          'info',
          '抓不到画面（多半是游戏在独占全屏），这次先只用文字；改成「无边框窗口化」就能看见了'
        )
      }
    }

    // 图片只进最后一条消息：历史里永远是纯文字，否则每轮重传 base64 既贵又毁缓存
    const buildMessages = (withImage: boolean): ChatMessage[] =>
      assembleMessages({
        systemPrompt,
        summary: contextStore.getSummary(),
        history: historySnapshot,
        userText,
        now,
        timeAwareness: s.context.timeAwareness,
        image:
          withImage && shot
            ? {
              dataUrl: shot.dataUrl,
              note: `${s.prompts?.visionNote || DEFAULT_VISION_NOTE}\n桌面截图 ${shot.width}×${shot.height}，captureId: ${shot.captureId}`
            }
            : undefined
      })

    let useImage = Boolean(shot)
    let messages = buildMessages(useImage)
    const contextBudget = budgetFor(s.context.level, resolveModelWindow(s.llm.model, s.context.modelWindow, providerWindow(s.llm.model)).window)
    const estimated = estimatePrompt(messages)

    const controller = new AbortController()
    this.abortLlm = controller
    sendBubble({ type: 'reasoning-reset' })
    const splitter = new SentenceSplitter()
    const canSpeak = s.tts.enabled && !s.ui.muted
    let answer = ''
    /** 本轮是否真的播出过声音：没播过就不能靠 audioDrained 收尾 */
    let audioStarted = false

    if (canSpeak) {
      this.speech = new SpeechQueue(
        s.tts,
        (seq, pcm, sampleRate) => {
          if (turn !== this.turnId) return
          if (pcm) audioStarted = true
          this.pushAudio(seq, pcm, sampleRate)
        },
        () => {
          if (turn === this.turnId) getBallWindow()?.webContents.send(IPC.audioEnd)
        },
        s.tts.provider === 'gpt-sovits' ? 1 : 2
      )
    } else {
      // 静音 / 关闭合成：清掉上一轮残留的队列，避免下面误判成"还有东西在播"
      this.speech?.abort()
      this.speech = null
    }

    let failed = false
    let attemptedWithoutImage = !useImage

    for (;;) {
      try {
        for await (const delta of streamChat({
          llm: s.llm,
          messages,
          signal: controller.signal,
          onReasoning: (t) => {
            if (turn === this.turnId) sendBubble({ type: 'reasoning-delta', text: t })
          },
          onUsage: (usage) => {
            // 用真实 prompt_tokens 校准估算；顺带记下缓存命中给设置页展示
            calibrate(usage.prompt, estimated)
            this.lastUsage = {
              actual: usage.prompt,
              estimated,
              cacheHit: usage.cached === null ? null : usage.cached
            }
          }
        })) {
          if (turn !== this.turnId) return
          answer += delta
          sendBubble({ type: 'assistant-delta', text: delta })
          if (this.speech) {
            for (const sentence of splitter.push(delta)) {
              this.speech.add(sentence)
            }
          }
        }
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 模型不支持看图：自动退回纯文字重试一次
        if (!controller.signal.aborted && useImage && !attemptedWithoutImage && !answer && shouldRetryWithoutImage(e)) {
          attemptedWithoutImage = true
          useImage = false
          messages = buildMessages(false)
          sendBubble({ type: 'assistant-reset' })
          this.notify('info', '当前模型不支持图片，已自动改成纯文字（可在设置里关掉屏幕理解）')
          log('vision: 模型拒绝图片，降级为纯文字', msg)
          continue
        }
        if (!controller.signal.aborted) {
          log('llm: 请求失败', msg)
          this.notify('error', msg, 'open-settings')
          failed = true
        }
        break
      }
    }

    if (turn !== this.turnId) return
    if (this.speech) {
      for (const sentence of splitter.flush()) this.speech.add(sentence)
      this.speech.finish()
    }
    sendBubble({ type: 'assistant-end' })

    if (answer.trim()) historyStore.add('assistant', answer.trim())
    this.maybeCompact()

    if (failed || !answer.trim()) {
      if (!answer.trim()) this.notify('info', '这次没生成出内容，再试一次？')
      this.setPhase('idle')
      this.scheduleHide()
      return
    }

    if (!this.speech) {
      this.setPhase('idle')
      this.scheduleHide()
      return
    }

    // TTS 全部失败 / 服务端卡住时不会产出任何音频，也就永远等不到 audioDrained，
    // 这里兜底把状态收回 idle，避免一直停在"思考中"。
    const speech = this.speech
    setTimeout(() => {
      if (turn !== this.turnId || audioStarted) return
      if (this.phase !== 'thinking') return
      speech.abort()
      this.setPhase('idle')
      this.scheduleHide()
    }, 5000)
  }

  /* -------------------------------------------------------- agent mode ---- */

  /** Agent 模式：跑工具循环，边显示边播报，结束时收起 */
  private async respondWithDsh(userText: string, turn: number, s: Settings): Promise<void> {
    const controller = new AbortController()
    this.abortLlm = controller
    this.speech?.abort()
    this.speech = null
    sendBubble({ type: 'reasoning-reset' })
    this.setPhase('acting', 'DSH 思考中')
    sendAgentProgress({ active: true, step: 0, mode: 'thinking', text: 'DSH 正在连接' })
    const clearProgress = (): void => sendAgentProgress({ active: false, step: 0 })
    controller.signal.addEventListener('abort', clearProgress, { once: true })
    let answer = ''
    let index = 0
    try {
      answer = await runDsh(userText, s.dsh.sessionId, controller.signal, ({ mode, text }) => {
        if (turn !== this.turnId) return
        const step = ++index
        sendAgentProgress({ active: true, step, mode, text })
        sendBubble({ type: 'agent-step', index: step, text, done: false })
      })
    } catch (error) {
      if (turn !== this.turnId || controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      this.notify('error', message)
    } finally {
      controller.signal.removeEventListener('abort', clearProgress)
      if (turn === this.turnId) {
        clearProgress()
        sendBubble({ type: 'agent-step', index: Math.max(1, index), text: answer ? 'DSH 已完成' : 'DSH 未完成', done: true, ok: Boolean(answer) })
        if (answer) sendBubble({ type: 'assistant-delta', text: answer })
        sendBubble({ type: 'assistant-end' })
      }
    }
    if (turn !== this.turnId || controller.signal.aborted) return
    const tts = settingsStore.get()
    if (!answer || !tts.tts.enabled || tts.ui.muted) {
      this.setPhase('idle')
      this.scheduleHide()
      return
    }
    this.speech = new SpeechQueue(
      tts.tts,
      (seq, pcm, rate) => { if (turn === this.turnId) this.pushAudio(seq, pcm, rate) },
      () => {
        if (turn !== this.turnId) return
        getBallWindow()?.webContents.send(IPC.audioEnd)
        if (this.phase === 'acting') {
          this.setPhase('idle')
          this.scheduleHide()
        }
      },
      tts.tts.provider === 'volc' ? 2 : 1
    )
    const splitter = new SentenceSplitter()
    for (const sentence of [...splitter.push(answer), ...splitter.flush()]) this.speech.add(sentence)
    this.speech.finish()
  }

  private async respondWithAgent(userText: string, turn: number, s: Settings): Promise<void> {
    // 和闲聊一样：先等压缩落定，再取历史快照，最后才把本轮写入记录
    await this.settleContext()
    if (turn !== this.turnId) return
    contextStore.clampArchived(historyStore.endIndex())
    const historySnapshot = historyStore.since(contextStore.archivedUpTo())
    // 旧代码只在 Agent 结束时记 assistant，用户的问句从来没进过历史 —— 顺手补上
    historyStore.add('user', userText)
    this.setPhase('acting', '工作中')
    sendBubble({ type: 'reasoning-reset' })
    // 不在这里收：等模型真的开始调工具再收（纯聊天不该把窗口藏起来）
    let hiddenForTask = false
    sendAgentProgress({ active: true, step: 0, mode: 'thinking' })
    const controller = new AbortController()
    this.abortLlm = controller
    const clearProgress = (): void => sendAgentProgress({ active: false, step: 0 })
    controller.signal.addEventListener('abort', clearProgress, { once: true })
    const splitter = new SentenceSplitter()
    const canSpeak = s.tts.enabled && !s.ui.muted
    let audioStarted = false
    let answer = ''

    if (canSpeak) {
      this.speech = new SpeechQueue(
        s.tts,
        (seq, pcm, sampleRate) => {
          if (turn !== this.turnId) return
          if (pcm) audioStarted = true
          this.pushAudio(seq, pcm, sampleRate)
        },
        () => {
          if (turn !== this.turnId) return
          getBallWindow()?.webContents.send(IPC.audioEnd)
          if (!audioStarted && this.phase === 'acting') {
            this.setPhase('idle')
            this.scheduleHide()
          }
        },
        // Breeze 的并发上限是 1，两条一起合成就 429，第二句会直接丢
        s.tts.provider === 'volc' ? 2 : 1
      )
    } else {
      this.speech?.abort()
      this.speech = null
    }

    try {
      // 屏幕理解：Agent 模式同样附截图
      let agentShot: ScreenCapture | null = null
      if (s.llm.vision.enabled) {
        const cap = await captureScreen(controller.signal)
        if (turn !== this.turnId) return
        if (cap.ok) {
          agentShot = cap.shot
          log('vision: Agent 已截屏', `${cap.shot.width}x${cap.shot.height}`)
        }
      }

      const res = await runAgentTask(userText, {
        signal: controller.signal,
        history: historySnapshot,
        image: agentShot ?? undefined,
        events: {
          onReasoning: (text) => {
            if (turn !== this.turnId) return
            sendBubble({ type: 'reasoning-delta', text })
          },
          onNarration: (text) => {
            // 过程叙述不进气泡，只记日志，方便排查模型行为
            log('agent: narration', text.replace(/\s+/g, ' ').slice(0, 80))
          },
          onText: (text) => {
            if (turn !== this.turnId) return
            answer += text
            sendBubble({ type: 'assistant-delta', text })
            if (this.speech) for (const sentence of splitter.push(text)) this.speech.add(sentence)
          },
          onStep: (info) => {
            if (turn !== this.turnId) return
            if (info.mode !== 'waiting' && !hiddenForTask && !isBubblePinned()) {
              hiddenForTask = true
              hideBubble()
            }
            sendAgentProgress({
              active: true,
              step: info.index,
              mode: info.mode,
              text: info.summary
            })
            sendBubble({
              type: 'agent-step',
              index: info.index,
              text: info.summary,
              done: false
            })
          },
          onStepDone: (info) => {
            if (turn !== this.turnId) return
            // 工具返回结果后模型又要思考了：徽标切回"思考中"
            sendAgentProgress({
              active: true,
              step: info.index,
              mode: 'thinking',
              text: info.summary
            })
            sendBubble({
              type: 'agent-step',
              index: info.index,
              text: info.summary,
              done: true,
              ok: info.ok
            })
          },
          onApproval: async (req) => {
            showBubble()
            const ok = await requestApproval(req, turn, controller.signal)
            if (turn === this.turnId && !controller.signal.aborted && hiddenForTask && !isBubblePinned()) hideBubble()
            return ok && turn === this.turnId && !controller.signal.aborted
          }
        }
      })
      if (turn !== this.turnId) return
      showBubble()
      // 兜底：万一 runner 没通过 onText 回传（例如直接返回了错误文本），也要显示出来
      if (!answer.trim() && res.text.trim()) {
        answer = res.text
        sendBubble({ type: 'assistant-delta', text: res.text })
      }
      if (this.speech) {
        for (const sentence of splitter.flush()) this.speech.add(sentence)
      }
      sendBubble({ type: 'assistant-end' })
      if (res.text.trim()) historyStore.add('assistant', res.text.trim())
      if (res.stopped) this.notify('info', '已停止这次操作')
    } catch (e) {
      if (turn !== this.turnId) return
      const msg = e instanceof Error ? e.message : String(e)
      log('agent: 运行失败', msg)
      showBubble()
      this.notify('error', msg, 'open-settings')
      sendBubble({ type: 'assistant-end' })
    } finally {
      controller.signal.removeEventListener('abort', clearProgress)
      if (turn === this.turnId && !controller.signal.aborted) {
        this.speech?.finish()
        clearProgress()
      }
    }

    if (turn !== this.turnId) return
    if (answer.trim()) this.maybeCompact()
    if (!this.speech || !answer.trim()) {
      this.setPhase('idle')
      this.scheduleHide()
      return
    }
    // TTS 全失败时兜底回 idle
    const speech = this.speech
    setTimeout(() => {
      if (turn !== this.turnId || audioStarted) return
      if (this.phase !== 'acting') return
      speech.abort()
      getBallWindow()?.webContents.send(IPC.audioStop)
      this.setPhase('idle')
      this.scheduleHide()
    }, 5000)
  }
  private pushAudio(seq: number, pcm: Buffer | null, sampleRate = 24000): void {
    const win = getBallWindow()
    if (!win) return
    if (pcm) {
      win.webContents.send(IPC.audioChunk, {
        seq,
        pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
        sampleRate,
        last: false
      })
      if (this.phase !== 'speaking') this.setPhase('speaking')
    } else {
      win.webContents.send(IPC.audioChunk, {
        seq,
        pcm: new ArrayBuffer(0),
        sampleRate: 24000,
        last: true
      })
    }
  }

  onAudioDrained(): void {
    if (this.phase === 'speaking' || this.phase === 'thinking') {
      this.setPhase('idle')
    }
    this.scheduleHide()
  }

  /** 设置页试听：把音频块直接推给悬浮球渲染进程播放 */
  previewChunk(seq: number, pcm: Buffer, last: boolean, sampleRate?: number): void {
    this.pushAudio(seq, last ? null : pcm, sampleRate)
  }

  /**
   * 上下文压缩：把「已有摘要 + 待归档对话」压成新摘要，并推进归档游标。
   *
   * 只在两个时机调用：① 回答结束后发现水位超了（后台预压，下一轮前完成）；
   * ② 用户在设置页点「立即压缩」。压缩**不删本地记录**，只推游标。
   */
  private async compact(reason: 'auto' | 'manual'): Promise<{ ok: boolean; message: string }> {
    if (this.compacting) return { ok: false, message: '正在压缩中，稍等一下' }
    const s = settingsStore.get()
    if (s.dsh.enabled) return { ok: false, message: 'DSH 模式下由 DSH 管理上下文' }
    const gen = this.ctxGen
    contextStore.clampArchived(historyStore.endIndex())
    const archived = Math.max(historyStore.startIndex(), contextStore.archivedUpTo())
    const pending = historyStore.since(archived)
    const split = splitForCompaction(pending, s.context.keepRecentTurns)
    if (split.cold <= 0) return { ok: false, message: '最近的对话还不够压，再聊几轮吧' }

    const cold = pending.slice(0, split.cold)
    const budget = budgetFor(s.context.level, resolveModelWindow(s.llm.model, s.context.modelWindow, providerWindow(s.llm.model)).window)
    const before = estimatePrompt(
      assembleMessages({
        systemPrompt: s.llm.systemPrompt,
        summary: contextStore.getSummary(),
        history: pending,
        userText: '',
        now: Date.now(),
        timeAwareness: 'off'
      })
    )

    const controller = new AbortController()
    this.compactAbort = controller
    this.compacting = (async () => {
      const text = await summarizeConversation({
        summary: contextStore.getSummary(),
        messages: cold,
        llm: s.llm,
        maxChars: summaryCharsFor(s.context.level),
        signal: controller.signal
      })
      if (gen !== this.ctxGen) return
      if (!text.trim()) {
        log('context: 摘要为空，保留原状')
        return
      }
      const after = estimatePrompt(
        assembleMessages({
          systemPrompt: s.llm.systemPrompt,
          summary: text,
          history: pending.slice(split.cold),
          userText: '',
          now: Date.now(),
          timeAwareness: 'off'
        })
      )
      contextStore.setSummary({
        summary: text,
        archivedUpTo: archived + split.cold,
        before,
        after
      })
      log('context: 已压缩', `${cold.length} 条 → ${text.length} 字 / 约 ${before} → ${after} tokens (预算 ${budget})`)
      if (reason === 'manual') return
      sendBubble({ type: 'notice', notice: { kind: 'success', text: '上下文已整理，刚才的对话我记住了' } })
    })()

    try {
      await this.compacting
      return { ok: true, message: '已压缩' }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('context: 压缩失败', msg)
      return { ok: false, message: msg }
    } finally {
      this.compacting = null
      this.compactAbort = null
    }
  }

  /** 有压缩在跑就等它（阻塞方案：宁可让这一轮多等，也不要带着旧摘要重复压） */
  private async settleContext(): Promise<void> {
    const running = this.compacting
    if (!running) return
    try {
      await running
    } catch {
      /* compact 内部已记日志 */
    }
  }

  /** 回答结束后：水位超了就预压，用户听播报的这几秒正好用来压缩 */
  private maybeCompact(): void {
    if (this.compacting) return
    const s = settingsStore.get()
    const window = resolveModelWindow(s.llm.model, s.context.modelWindow, providerWindow(s.llm.model)).window
    const budget = budgetFor(s.context.level, window)
    const used =
      this.lastUsage?.actual ??
      estimatePrompt(
        assembleMessages({
          systemPrompt: s.llm.systemPrompt,
          summary: contextStore.getSummary(),
          history: historyStore.since(contextStore.archivedUpTo()),
          userText: '',
          now: Date.now(),
          timeAwareness: 'off'
        })
      )
    if (!needsCompaction(used, budget)) return
    void this.compact('auto').catch(() => {})
  }

  contextInfo(): ContextInfo {
    const s = settingsStore.get()
    const resolved = resolveModelWindow(s.llm.model, s.context.modelWindow, providerWindow(s.llm.model))
    const budget = budgetFor(s.context.level, resolved.window)
    const first = historyStore.startIndex()
    const end = historyStore.endIndex()
    contextStore.clampArchived(end)
    const archived = Math.max(first, contextStore.archivedUpTo())
    const pending = end - archived
    const used =
      this.lastUsage?.actual ??
      estimatePrompt(
        assembleMessages({
          systemPrompt: s.llm.systemPrompt,
          summary: contextStore.getSummary(),
          history: historyStore.since(archived),
          userText: '',
          now: Date.now(),
          timeAwareness: 'off'
        })
      )
    const stats = contextStore.stats()
    const hit = this.lastUsage?.cacheHit
    return {
      summaryChars: contextStore.getSummary().length,
      updatedAt: contextStore.updatedAt(),
      archived: archived - first,
      pending: Math.max(0, pending),
      used,
      budget,
      level: s.context.level,
      window: resolved.window,
      windowSource: resolved.source,
      compressions: stats.compressions,
      lastBefore: stats.lastBefore,
      lastAfter: stats.lastAfter,
      cacheHit: hit === null || hit === undefined ? null : { hit, total: this.lastUsage?.actual ?? 0 }
    }
  }

  /** 设置页「立即压缩」：不等水位 */
  compactNow(): Promise<{ ok: boolean; message: string }> {
    return this.compact('manual')
  }

  /* ----------------------------------------------------------- control ---- */

  switchDshRoute(): void {
    this.stopEverything()
    this.ctxGen += 1
    this.compactAbort?.abort()
  }

  interrupt(): void {
    cancelApprovalsForTurn(this.turnId)
    this.turnId++
    this.asrGeneration.invalidate()
    this.asrStarting = null
    this.asr?.cancel()
    this.asrFinishing?.cancel()
    this.asrFinishing = null
    this.asr = null
    this.asrReady = false
    this.pcmQueue = []
    this.speech?.abort()
    this.speech = null
    this.abortLlm?.abort()
    this.abortLlm = null
    getBallWindow()?.webContents.send(IPC.audioStop)
    sendBubble({ type: 'assistant-end' })
  }

  stopEverything(): void {
    this.interrupt()
    this.cancelListening()
    this.setPhase('idle')
  }

  /** 清空多轮上下文：停掉当前播报，清历史与长期记忆，气泡回到空白状态 */
  clearContext(): void {
    if (settingsStore.get().dsh.enabled) {
      this.stopEverything()
      sendBubble({ type: 'user', text: '', final: false })
      sendBubble({ type: 'assistant-reset' })
      this.notify('info', '要切换上下文，请在 DSH模式设置中选择其他对话')
      return
    }
    historyStore.clear()
    contextStore.clear()
    this.ctxGen += 1
    cancelApprovalsForTurn(this.turnId)
    this.turnId++
    this.speech?.abort()
    this.speech = null
    this.abortLlm?.abort()
    this.abortLlm = null
    getBallWindow()?.webContents.send(IPC.audioStop)
    sendBubble({ type: 'user', text: '', final: false })
    sendBubble({ type: 'assistant-reset' })
    sendBubble({ type: 'assistant-end' })
    this.setPhase('idle')
    this.notify('info', '上下文已清空，重新开始聊吧')
    showBubble()
  }

  async previewSpeech(text: string): Promise<{ ok: boolean; message: string }> {
    const s = settingsStore.get()
    try {
      const seq = this.previewSeq++
      let bytes = 0
      for await (const chunk of synthesize(s.tts, text, new AbortController().signal)) {
        bytes += chunk.pcm.length
        this.pushAudio(seq, chunk.pcm, chunk.sampleRate)
      }
      this.pushAudio(seq, null)
      getBallWindow()?.webContents.send(IPC.audioEnd)
      if (!bytes) return { ok: false, message: '没有拿到音频' }
      return { ok: true, message: '试听中…' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }
}

export const conversation = new Conversation()
