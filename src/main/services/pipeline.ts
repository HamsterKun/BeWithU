import type { Phase, Settings } from '../../shared/types'
import { IPC } from '../../shared/ipc'
import { historyStore } from '../store/history'
import { memoryStore } from '../store/memory'
import { settingsStore } from '../store/settings'
import { log } from '../logger'
import { VolcAsr } from './asr'
import { streamChat, type ChatMessage } from './llm'
import { synthesize } from './tts'
import { SentenceSplitter } from './splitter'
import { summarizeConversation } from './summarizer'
import { captureScreen, type ScreenCapture } from './vision'
import { LocalAsrSession } from './local-asr'
import { modelReady } from './local-asr'
import { runAgentTask } from '../agent/runner'
import { classifyIntent, wantsScreenReference } from '../agent/router'
import { isVisionUnsupported, markVisionUnsupported } from '../agent/vision-state'
import { requestApproval, resolvePendingByText } from '../agent/approval'

/** 云端 / 本地识别共用的会话接口 */
type AsrSession = {
  sendAudio(pcm: Buffer): void
  finish(): Promise<string>
  cancel(): void
}

/** 判断错误是否属于"模型不支持图片输入" */
function isVisionReject(message: string): boolean {
  return /image|vision|multi-?modal|content[ _-]?type|unsupported/i.test(message)
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
import { prettyChord } from '../input/hotkey'
import { formatHits, webSearch } from './web-search'

/** 闲聊模式判断"这句话要不要联网"：够不够像时效性问题 */
const SEARCH_HINT =
  /(最新|今天|今日|昨天|前天|最近|这几天|这周|本周|本月|今年|新闻|热搜|头条|比分|赛果|赛程|排名|价格|多少钱|汇率|股价|票房|发布|上线|发售|开售|新版本|更新了什么|谁是|怎么样了|发生了什么|有没有出|什么时候出|夺冠|冠军|销量)/

function shouldSearch(text: string): boolean {
  const t = text.trim()
  if (t.length < 4 || t.length > 200) return false
  return SEARCH_HINT.test(t)
}

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
    private onChunk: (seq: number, pcm: Buffer | null) => void,
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
        this.onChunk(item.seq, chunk.pcm)
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
        if (!this.aborted && /429|concurren|并发/i.test(msg)) {
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
  /** 上一轮走的是聊天还是干活（用于「继续/改成」这类续说） */
  private lastRoute: 'chat' | 'task' = 'chat'
  private phase: Phase = 'idle'
  private listening = false
  private holdStartedAt = 0
  private pcmQueue: Buffer[] = []
  private asr: AsrSession | null = null
  private asrReady = false
  private turnId = 0
  private abortLlm: AbortController | null = null
  private speech: SpeechQueue | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private maxHoldTimer: NodeJS.Timeout | null = null
  private previewSeq = 900000
  private summarizing = false
  private memoryGen = 0
  private visionWarned = false

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
    if (s.voice.mode === 'toggle') {
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
    const s = settingsStore.get()
    this.clearHideTimer()
    // 球可能被「隐藏悬浮球 / 隐藏全部窗口」收起来了，用侧键唤醒时一起叫回来
    if (!isBallVisible()) showBallWindow()

    if (this.phase === 'speaking' || this.phase === 'thinking') {
      if (s.voice.bargeIn) this.interrupt()
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
      if (this.listening) void this.stopListening()
    }, MAX_HOLD_MS)

    if (useLocal) {
      // 本地整句识别：先把 PCM 攒起来，松手后一次性识别
      this.asr = new LocalAsrSession()
      this.asrReady = true
      this.pcmQueue = []
      return
    }

    try {
      const asr = await VolcAsr.create(s.asr, (text) => {
        if (!this.listening && this.phase !== 'thinking') return
        sendBubble({ type: 'user', text, final: false })
      })
      if (!this.listening) {
        asr.cancel()
        return
      }
      this.asr = asr
      this.asrReady = true
      for (const buf of this.pcmQueue) asr.sendAudio(buf)
      this.pcmQueue = []
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('asr: 建立连接失败', msg)
      if (this.listening) {
        this.listening = false
        getBallWindow()?.webContents.send(IPC.voiceRecStop)
        this.notify('error', msg, 'open-voice')
        this.setPhase('idle')
        this.scheduleHide()
      }
    }
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
    if (s.voice.mode === 'hold' && held < s.voice.minHoldMs) {
      this.asr?.cancel()
      this.asr = null
      this.asrReady = false
      this.pcmQueue = []
      this.setPhase('idle')
      return
    }

    this.setPhase('thinking', '整理中')
    const asr = this.asr
    this.asr = null
    this.asrReady = false
    this.pcmQueue = []
    if (!asr) {
      this.setPhase('idle')
      this.scheduleHide()
      return
    }

    let text = ''
    try {
      text = (await asr.finish()).trim()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.notify('error', msg, 'open-voice')
      this.setPhase('idle')
      this.scheduleHide()
      return
    }

    if (!text) {
      this.notify('info', '没听清，按住再说一次')
      this.setPhase('idle')
      this.scheduleHide()
      return
    }
    await this.respond(text)
  }

  cancelListening(): void {
    if (this.listening) getBallWindow()?.webContents.send(IPC.voiceRecStop)
    this.listening = false
    this.asr?.cancel()
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
    if (this.phase === 'speaking' || this.phase === 'thinking') this.interrupt()
    if (this.listening) this.cancelListening()
    showBubble()
    await this.respond(text)
  }

  /* ----------------------------------------------------------- respond ---- */

  private async respond(userText: string): Promise<void> {
    const s = settingsStore.get()

    // 正在等用户确认时，一句话"同意/拒绝"直接当作答复，不开启新回合
    if (resolvePendingByText(userText) !== null) {
      sendBubble({ type: 'user', text: userText, final: true })
      return
    }

    const turn = ++this.turnId
    sendBubble({ type: 'user', text: userText, final: true })
    sendBubble({ type: 'assistant-reset' })

    // Agent 总开关打开时：先判断这句是「聊天」还是「要干活」
    if (s.agent.enabled) {
      const route = classifyIntent(userText, { lastWasTask: this.lastRoute === 'task' })
      this.lastRoute = route.route
      log('route:', `${route.route}(${route.reason}) ${userText.slice(0, 40)}`)
      if (route.route === 'task') {
        await this.respondWithAgent(userText, turn, s)
        return
      }
    }

    this.setPhase('thinking', '思考中')

    if (!s.llm.model.trim() || !s.llm.baseUrl.trim() || !s.llm.apiKey.trim()) {
      this.notify('error', '还没配置大模型（Base URL / 模型名 / API Key）', 'open-settings')
      this.setPhase('idle')
      this.scheduleHide()
      return
    }

    const history = historyStore.recent(s.llm.historyTurns)
    const rawName = (s.ui.assistantName || '').trim()
    const name = rawName || 'TA'
    // 没设名字就不往提示词里塞自称，避免模型自称「TA」
    const systemPrompt =
      rawName && !s.llm.systemPrompt.includes(rawName)
        ? `${s.llm.systemPrompt}\n\n补充：你的名字是「${rawName}」，需要自称时用这个名字。`
        : s.llm.systemPrompt
    const memory = memoryStore.get()
    // 摘要并进同一条 system，兼容只接受单条 system 的服务端
    let systemContent = memory
      ? `${systemPrompt}\n\n【长期记忆摘要】以下是更早之前聊过的要点，回答时当作你已经知道：\n${memory}`
      : systemPrompt

    // 闲聊模式（没开 Agent）也能用联网搜索：命中时效性关键词就先查，再把资料塞进 system
    if (s.search.enabled && s.search.auto && shouldSearch(userText)) {
      try {
        const { provider, hits } = await webSearch(userText)
        if (hits.length) {
          systemContent +=
            `\n\n【联网搜索结果 · ${provider}】以下是刚为你检索到的资料，回答时优先采用，并在末尾附上来源链接：\n` +
            formatHits(hits).slice(0, 4000)
        }
        log('search: 闲聊自动搜索', `${provider} ${hits.length} 条`)
      } catch (e) {
        log('search: 自动搜索失败', e instanceof Error ? e.message : e)
      }
    }
    historyStore.add('user', userText)

    // 屏幕理解：只有用户这句话确实指向屏幕时才截图，避免闲聊被"看图说话"
    let shot: ScreenCapture | null = null
    if (s.llm.vision.enabled && wantsScreenReference(userText)) {
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

    const buildMessages = (withImage: boolean): ChatMessage[] => {
      const list: ChatMessage[] = [{ role: 'system', content: systemContent }]
      list.push(...history.map((m) => ({ role: m.role, content: m.content })))
      if (withImage && shot) {
        list.push({
          role: 'user',
          content: [
            { type: 'text', text: `${userText}\n\n（附一张当前屏幕截图，仅作参考：只有当用户问的是屏幕/界面/画面里的内容时才用它回答，不要主动描述屏幕上有什么。）` },
            { type: 'image_url', image_url: { url: shot.dataUrl } }
          ]
        })
      } else {
        list.push({ role: 'user', content: userText })
      }
      return list
    }

    let useImage = Boolean(shot)
    let messages = buildMessages(useImage)

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
        (seq, pcm) => {
          if (pcm) audioStarted = true
          this.pushAudio(seq, pcm)
        },
        () => {
          if (turn === this.turnId) getBallWindow()?.webContents.send(IPC.audioEnd)
        }
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
        if (!controller.signal.aborted && useImage && !attemptedWithoutImage && !answer && isVisionReject(msg)) {
          attemptedWithoutImage = true
          useImage = false
          markVisionUnsupported()
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
    void this.maybeSummarize()

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
  private async respondWithAgent(userText: string, turn: number, s: Settings): Promise<void> {
    this.setPhase('acting', '工作中')
    sendBubble({ type: 'reasoning-reset' })
    // 任务可能要跑一会儿：先收起气泡别挡视线（用户手动钉住时不动）
    if (!isBubblePinned()) hideBubble()
    sendAgentProgress({ active: true, step: 0, total: s.agent.maxSteps, mode: 'thinking' })
    const controller = new AbortController()
    this.abortLlm = controller
    const splitter = new SentenceSplitter()
    const canSpeak = s.tts.enabled && !s.ui.muted
    let audioStarted = false
    let answer = ''

    if (canSpeak) {
      this.speech = new SpeechQueue(
        s.tts,
        (seq, pcm) => {
          if (pcm) audioStarted = true
          this.pushAudio(seq, pcm)
        },
        () => {
          if (turn === this.turnId) getBallWindow()?.webContents.send(IPC.audioEnd)
        },
        // Breeze 的并发上限是 1，两条一起合成就 429，第二句会直接丢
        s.tts.provider === 'breeze' ? 1 : 2
      )
    } else {
      this.speech?.abort()
      this.speech = null
    }

    // 屏幕理解：Agent 模式下也要带截图；但模型已经明确拒绝过图片就不再抓（省一次抓屏）
    let agentShot: ScreenCapture | null = null
    if (s.llm.vision.enabled && !isVisionUnsupported()) {
      const cap = await captureScreen()
      if (turn !== this.turnId) return
      if (cap.ok) {
        agentShot = cap.shot
        log('vision: Agent 已截屏', `${cap.shot.width}x${cap.shot.height}`)
      }
    }

    try {
      const res = await runAgentTask(userText, {
        signal: controller.signal,
        image: agentShot ? { dataUrl: agentShot.dataUrl } : undefined,
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
            sendAgentProgress({
              active: true,
              step: info.index,
              total: info.total,
              mode: 'working',
              text: info.summary
            })
            sendBubble({
              type: 'agent-step',
              index: info.index,
              total: info.total,
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
              total: info.total,
              mode: 'thinking',
              text: info.summary
            })
            sendBubble({
              type: 'agent-step',
              index: info.index,
              total: info.total,
              text: info.summary,
              done: true,
              ok: info.ok
            })
          },
          onApproval: async (req) => {
            showBubble()
            const ok = await requestApproval(req)
            if (!isBubblePinned()) hideBubble()
            return ok
          }
        }
      })
      if (turn !== this.turnId) return
      sendAgentProgress({ active: false, step: res.steps, total: s.agent.maxSteps })
      showBubble()
      // 兜底：万一 runner 没通过 onText 回传（例如直接返回了错误文本），也要显示出来
      if (!answer.trim() && res.text.trim()) {
        answer = res.text
        sendBubble({ type: 'assistant-delta', text: res.text })
      }
      if (this.speech) {
        for (const sentence of splitter.flush()) this.speech.add(sentence)
        this.speech.finish()
      }
      sendBubble({ type: 'assistant-end' })
      if (res.text.trim()) historyStore.add('assistant', res.text.trim())
      if (res.stopped) this.notify('info', '已停止这次操作')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('agent: 运行失败', msg)
      showBubble()
      this.notify('error', msg, 'open-settings')
      sendBubble({ type: 'assistant-end' })
    }

    if (turn !== this.turnId) return
    if (!this.speech || !answer) {
      this.setPhase('idle')
      this.scheduleHide()
      return
    }
    // TTS 全失败时兜底回 idle
    const speech = this.speech
    setTimeout(() => {
      if (turn !== this.turnId || audioStarted) return
      if (this.phase !== 'thinking') return
      speech.abort()
      this.setPhase('idle')
      this.scheduleHide()
    }, 5000)
    void this.maybeSummarize()
  }
  private pushAudio(seq: number, pcm: Buffer | null): void {
    const win = getBallWindow()
    if (!win) return
    if (pcm) {
      win.webContents.send(IPC.audioChunk, {
        seq,
        pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
        sampleRate: 24000,
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
  previewChunk(seq: number, pcm: Buffer, last: boolean): void {
    this.pushAudio(seq, last ? null : pcm)
  }

  /**
   * 记忆压缩：对话条数达到 轮数×2 时，把「已有摘要 + 这批对话」合成新摘要，
   * 然后把已归档的对话从记录里移除，下一轮只带摘要 + 新增对话。
   */
  private async maybeSummarize(): Promise<void> {
    const s = settingsStore.get()
    const turns = Math.max(0, Math.floor(s.llm.historyTurns))
    if (turns <= 0) return
    if (historyStore.count() < turns * 2) return
    if (this.summarizing) return

    this.summarizing = true
    const gen = this.memoryGen
    const snapshot = historyStore.all()
    try {
      const text = await summarizeConversation({
        summary: memoryStore.get(),
        messages: snapshot,
        llm: s.llm
      })
      if (gen !== this.memoryGen) return
      if (!text) {
        log('memory: 总结返回为空，保留原对话')
        return
      }
      memoryStore.set(text)
      historyStore.drop(snapshot.length)
      log('memory: 摘要已更新', `${text.length} 字 / 归档 ${snapshot.length} 条`)
      sendBubble({ type: 'notice', notice: { kind: 'success', text: '已自动整理刚才的对话记忆' } })
    } catch (e) {
      log('memory: 总结失败', e instanceof Error ? e.message : e)
    } finally {
      this.summarizing = false
    }
  }

  memoryInfo(): { summary: string; updatedAt: number; pending: number; threshold: number } {
    const turns = Math.max(0, Math.floor(settingsStore.get().llm.historyTurns))
    return {
      summary: memoryStore.get(),
      updatedAt: memoryStore.updatedAt(),
      pending: historyStore.count(),
      threshold: turns * 2
    }
  }

  /** 手动触发一次记忆整理（不等阈值） */
  async summarizeNow(): Promise<{ ok: boolean; message: string }> {
    if (this.summarizing) return { ok: false, message: '正在整理中，稍等一下' }
    const snapshot = historyStore.all()
    if (!snapshot.length) return { ok: false, message: '还没有可以整理的对话' }
    this.summarizing = true
    const gen = this.memoryGen
    try {
      const text = await summarizeConversation({
        summary: memoryStore.get(),
        messages: snapshot,
        llm: settingsStore.get().llm
      })
      if (gen !== this.memoryGen) return { ok: false, message: '上下文已被清空，已放弃这次整理' }
      if (!text) return { ok: false, message: '这次没能整理出内容，已保留原有记忆' }
      memoryStore.set(text)
      historyStore.drop(snapshot.length)
      log('memory: 手动整理完成', `${text.length} 字`)
      return { ok: true, message: '记忆已更新' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    } finally {
      this.summarizing = false
    }
  }

  /* ----------------------------------------------------------- control ---- */

  interrupt(): void {
    this.turnId++
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
    historyStore.clear()
    memoryStore.clear()
    this.memoryGen += 1
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
        this.pushAudio(seq, chunk.pcm)
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
