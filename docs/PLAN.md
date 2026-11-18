# BeWithU — 桌面 AI 语音陪伴伙伴 · 项目规划 v0.1

> 状态：**已按本方案实现（v0.1.0）**，技术栈 Electron + React + TS，Windows 安装包 + 便携版已产出。
> 实现说明与使用方式见仓库根目录 [README.md](../README.md)。
> 本文档保留作为方案冻结稿，后续迭代（全屏自动隐藏、多角色、离线识别等）以此为基础扩展。

---

## 1. 定位

一款常驻桌面的"AI 游戏伙伴"：一个半透明、可拖动、可换图的悬浮球始终浮在屏幕上，
玩家按住（或按一下）绑定的开麦键说话 → 语音流式转文字 → 大模型流式回答 →
火山引擎大模型语音合成（TTS）播放 → 识别文字与回答文字从悬浮球旁的气泡对话框弹出，
像队友一样陪玩、陪聊。

**三条设计红线**

1. 零账号体系：不登录、不注册，所有 API Key 由使用者自己填，数据只存在本机。
2. 低打扰：默认半透明、可调透明度/大小、支持全屏游戏自动隐藏、一键隐身。
3. 低延迟：全链路流式（ASR 流式 → LLM 流式 → 分句 TTS 流式），首句出声目标 < 2.5s。

---

## 2. 目标体验（一次完整对话）

```
玩家在看游戏 / 桌面
   │  按住 鼠标侧键(Mouse4) 或 Alt+X
   ▼
[悬浮球] 进入"听"状态：外圈呼吸波纹 + 实时音量律动
   │  边说边把识别中间结果打进气泡（灰色小字）
   ▼
松开按键 → 最终识别文本定格为"你说"气泡内容
   │
   ▼
[悬浮球] 进入"想"状态：三点跳动
   │  同时气泡里 AI 回答开始流式打字
   ▼
第一句满足断句条件 → 立刻送 TTS → 开始播放
   │
   ▼
[悬浮球] 进入"说"状态：随音量脉动
   │  气泡内文字继续流式补齐，已朗读部分做轻微高亮（可选）
   ▼
播完 → 回到 idle，气泡停留 N 秒后淡出（可设置"保持显示"）
```

**打断（barge-in）**：任何时刻按下开麦键 → 立即停播、清空 TTS 队列、可选中止 LLM 请求 → 直接进入"听"。
这是游戏场景最核心的手感，必须做到"秒停"。

---

## 3. 功能范围

### v1 必做（M1-M6）

| # | 功能 | 说明 |
|---|------|------|
| 1 | 悬浮球窗口 | 无边框/透明/置顶/不占任务栏；自由拖动并记忆坐标；可调尺寸 0-100、透明度 0-100；皮肤可换（内置几套 + 自定义本地图片，圆形/圆角/异形遮罩） |
| 2 | 悬浮气泡 | 从球体边缘 spring 弹出的小卡片；显示"你说/TA说"；流式文字；自适应高度；可固定、可 Esc 关闭、可点外部关闭；不抢焦点 |
| 3 | 全局开麦键 | 支持键盘任意键 + 鼠标侧键（X1/X2）绑定；按住说话 / 按一下·再按一下 两种模式；监听全局（游戏窗口内也生效）；冲突检测 |
| 4 | 语音识别 | 麦克风采集 → 16k PCM → 火山流式 ASR；实时中间结果；松键后取最终结果 |
| 5 | 大模型对话 | OpenAI 兼容协议（自定义 BaseURL / Key / 模型名），内置火山方舟、DeepSeek、OpenAI、Ollama 预设；流式输出；多轮上下文；自定义系统提示词；温度/最大长度可调 |
| 6 | 语音合成 | 火山引擎大模型 TTS（V3 接口），自定义 AppID / Token / 音色 / 语速 / 音量；分句流水线 + 预取 + PCM 播放队列；即时打断 |
| 7 | 设置中心 | 独立窗口，五个分区：模型 / 语音 / 悬浮球 / 提示词 / 快捷键；保存即生效；每个 API 都有"测试连接"按钮 |
| 8 | 安全存储 | API Key 走 Windows DPAPI（Electron safeStorage）加密，不落明文、不进日志 |
| 9 | 托盘与常驻 | 托盘菜单：显示/隐藏、静音、设置、退出；开机自启（可关）；单实例 |
| 10 | 打包 | NSIS 安装包 + 便携版 exe；图标；内置 Node 环境（用户无需装 Node） |

### v1.1 推荐做（有余力再加）

- 全屏应用自动隐藏悬浮球（检测前台窗口是否全屏）
- 老板键（一键隐藏全部窗口 + 静音）
- 静音陪玩模式（只出文字不出声）
- 多角色档案（提示词 + 音色 + 头像打包成"伙伴"，一键切换）
- 气泡内历史记录面板（上滑查看本次会话）
- 文字输入模式（不想说话时直接打字）

### 明确不做（v1）

- 屏幕视觉理解（VLM 看游戏画面）、OCR 战局监测
- Live2D / 骨骼动画形象
- 内置游戏攻略库、云端同步、账号体系
- 端到端实时语音大模型（Seeduplex）——未来可作为"通话模式"接入

---

## 4. 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 桌面壳 | **Electron 33+**（锁定大版本，随环境可用版本调整） | 透明/无边框/置顶/多窗口/DPI 处理成熟；渲染层就是 Chromium，气泡动效与流式文字最省力 |
| UI | **React 19 + TypeScript + Vite**（electron-vite 多入口） | 三个独立 renderer 入口：ball / bubble / settings |
| 样式 | 原生 CSS + CSS 变量（不引 UI 框架） | 悬浮球是高度定制的视觉，Tailwind 帮助有限，减少依赖与体积 |
| 状态 | Zustand（renderer）+ 主进程单一 store（JSON 持久化） | 轻量；跨窗口同步用 IPC 广播 |
| 全局输入 | **uiohook-napi**（Rust/N-API，含预编译产物） | 唯一能同时拿到"全局 keydown + keyup + 鼠标键"的成熟方案，按住说话必需 |
| 音频采集 | Chromium `getUserMedia` + `AudioWorklet`（16kHz 重采样、Int16 分帧） | 无需 native 录音库；可拿设备列表、可做电平检测 |
| 音频播放 | WebAudio `AudioBufferSourceNode` 队列（PCM s16le 24k 单声道） | 比 `<audio>` 更适合流式 PCM；天然支持即时 stop、音量、波形分析驱动悬浮球脉动 |
| 网络 | 主进程发起（`fetch` + `ws`），不经 renderer | 避开 CORS、便于统一超时/重试/日志脱敏 |
| 打包 | electron-builder（NSIS + portable） | 一条命令出安装包与绿色版 |
| 开发环境 | 本机无系统 Node ⇒ 用 DSH 内置运行时（`C:\Users\Hamst\.dsh\dsh-runtimes\...\node.exe`），脚本互调用 `scripts/dsh-node.cmd` 包装 | 保证在你的机器上开箱可跑 |

> 备选：Tauri 2（体积 ~10MB）。但透明窗、全局键鼠钩子、流式音频都要自己写 Rust 插件，工期至少翻倍，v1 不选。

---

## 5. 架构

### 5.1 窗口模型（三个独立 BrowserWindow）

```
┌───────────────────────────────────────────────┐
│ BallWindow        160×160 transparent, topmost│
│  - 圆形悬浮球（球体 = 皮肤 + 遮罩 + 光圈）      │
│  - 拖动 / 单击 / 右键菜单 / 双击隐身            │
└──────────────┬────────────────────────────────┘
               │ 相对球体锚点定位（ball.x + ball.w）
┌──────────────▼────────────────────────────────┐
│ BubbleWindow      自适应 260~420 × 80~460      │
│  - 指向球体的小三角（随相对位置翻转）           │
│  - 你说 / TA说 / 状态行 / 波形                  │
└───────────────────────────────────────────────┘

┌───────────────────────────────────────────────┐
│ SettingsWindow    980×640 常规窗口，任务栏可见  │
└───────────────────────────────────────────────┘
```

关键约束：

- 球与气泡都是 `frameless + transparent + alwaysOnTop(level: 'screen-saver') + skipTaskbar + hasShadow:false`。
- 球窗口 `focusable:false` 会抢不到键盘输入，所以取 `focusable:true` 但用 `setIgnoreMouseEvents` 只在透明像素外透传（见风险 6）。
- 气泡窗口 `focusable:false`（不抢游戏焦点），需要输入时仅设置窗口例外。
- 透明度用 CSS `opacity`（视觉）+ 窗口 `setOpacity()` 仅用于"整体隐身"，不用它做静息半透明，避免和层级/阴影冲突。

### 5.2 进程分工

```
main (Node)
├─ app/lifecycle        单实例、托盘、开机自启、DPI、崩溃恢复
├─ windows/*            窗口创建、定位、显隐、点击穿透
├─ input/hotkey         uiohook 监听 → 归一化为 voice:down / voice:up 事件
├─ services/asr         WebSocket 流式识别（二进制帧协议）
├─ services/llm         OpenAI 兼容 SSE，AbortController
├─ services/tts         V3 语音合成，二进制帧 + 音频流
├─ services/pipeline    断句器 → TTS 预取队列 → 播放编排
├─ store/settings       settings.json + secrets.bin（DPAPI）
├─ store/history        最近 N 轮会话（JSON，按天滚动）
└─ ipc                  统一 invoke/on，全部事件带 type 前缀

preload                  contextBridge 白名单 API，contextIsolation:true, sandbox 关
renderer/ball            视觉 + 拖拽 + 状态动效
renderer/bubble          文字流式渲染 + 电平 + 轻量 Markdown（去代码块/去标记）
renderer/settings        表单 + 测试按钮 + 音色试听
```

### 5.3 一次对话的时序

```
hotkey.down ─► ball:state=listening ─► renderer getUserMedia(16k) ─► 100ms PCM 帧 ─► IPC
                                                                            │
                                                              ASR ws ─► partial ─► bubble
hotkey.up ─► flush + end ─► ASR final ─► bubble 定格
                                   │
                                   ▼
                     LLM stream (SSE) ─► bubble 增量 ─► SentenceSplitter
                                                            │ 每句
                                                            ▼
                                          TTS ws (per sentence, 2 并发预取)
                                                            │ pcm chunks
                                                            ▼
                                          AudioQueue 播放 ─► ball:state=speaking + 电平
```

---

## 6. 火山引擎对接方案

### 6.1 语音合成（豆包语音合成大模型）

- 接口：`wss://openspeech.bytedance.com/api/v3/tts/unidirectional`（单向流式，一次文本、流式音频，**支持 2.0 音色**）；
  可选升级 `.../api/v3/tts/bidirection`（双向流式，边说边合成，延迟更低）。
- 鉴权两种都要支持，设置页可切换：
  - 控制台方式：`X-Api-App-Id` + `X-Api-Access-Key`（+ `X-Api-Resource-Id: seed-tts-2.0`）
  - API Key 方式：`X-Api-Key`（+ 同上 Resource-Id）
  - 每次连接需 `X-Api-Connect-Id`（UUID）。
- 请求体 `req_params`：`text` / `speaker`（音色，如 `zh_female_vv_uranus_bigtts`）/ `audio_params{format: pcm, sample_rate: 24000, speech_rate, loudness_rate}` / `additions{disable_markdown_filter, max_length_to_filter_parenthesis}`。
- 返回：带 4 字节头的事件帧（`SessionStarted` / `SessionFinished` / `ConnectionFailed`），音频帧为裸 PCM。
- 协议细节（4 字节 header、message type、event flags）实现前先写一个 `tools/tts-probe.mjs` 独立脚本打通鉴权 → 出声，再进 Electron，避免把协议问题混进 UI 调试。

### 6.2 语音识别（豆包流式语音识别大模型）

- 接口：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`（双向流式）。
- 鉴权：`X-Api-App-Key`（AppID）+ `X-Api-Access-Key`（Token）+ `X-Api-Resource-Id: volc.bigasr.sauc.duration` + `X-Api-Connect-Id`。
- 音频：16kHz / 16bit / 单声道，100~200ms 一帧；`end_window_size` 控制判停（PTT 下松键主动 flush）。
- 结果：`definite=false` 为中间结果、`true` 为分句终态；拼出完整文本。
- 备选实现（抽象成 `AsrProvider` 接口，一行配置切换）：
  - `openai-whisper`：录完音后 `POST /v1/audio/transcriptions`，简单但多 ~1s 延迟；
  - 本地 `faster-whisper`：后续可作为离线方案。

### 6.3 大模型

- 统一走 OpenAI 兼容 `/v1/chat/completions`（`stream:true`），覆盖豆包方舟、DeepSeek、OpenAI、Moonshot、智谱、Ollama、LM Studio。
- 预设只填 BaseURL 与默认模型名，Key 与模型名永远可手改。
- Token 用量统计写进气泡脚注（可选显示），方便用户自己估成本。

---

## 7. 配置与数据

```jsonc
// %APPDATA%/BeWithU/settings.json（密钥部分存 secrets.bin，DPAPI 加密）
{
  "llm": {
    "preset": "ark", "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "model": "doubao-seed-1.6-flash", "temperature": 0.8, "maxTokens": 600,
    "historyTurns": 8, "systemPrompt": "你是我的游戏搭子，说话短、有梗、别念稿子……",
    "stream": true
  },
  "tts": {
    "provider": "volc", "authMode": "console",
    "appId": "", "accessToken": "", "resourceId": "seed-tts-2.0",
    "speaker": "zh_female_vv_uranus_bigtts", "speed": 0, "loudness": 0,
    "sampleRate": 24000, "format": "pcm", "volume": 0.9
  },
  "asr": {
    "provider": "volc", "appId": "", "accessToken": "",
    "resourceId": "volc.bigasr.sauc.duration", "language": "zh-CN",
    "endWindowMs": 800, "endpoint": "", "apiKey": "", "model": "whisper-1"
  },
  "voice": { "hotkey": "Mouse4", "mode": "hold", "minHoldMs": 250, "autoStopOnSilence": false },
  "ball": { "image": "builtin:dafiyu", "size": 100, "opacity": 85, "x": 1720, "y": 780,
            "alwaysOnTop": true, "autoHideFullscreen": true, "hideInTaskbar": true },
  "bubble": { "side": "auto", "holdMs": 6000, "keepOpen": false, "showWaveform": true },
  "ui": { "theme": "dark", "fontSize": 14, "silentMode": false }
}
```

- `settings.json` 原子写（临时文件 + rename），损坏时自动回退默认值并备份。
- 会话历史只保留最近 200 条 / 7 天，可在设置里一键清空。
- 日志脱敏：任何 Key/Token 打印前替换为 `sk-****`。

---

## 8. 目录结构

```
BeWithU/
├─ docs/PLAN.md
├─ package.json                 scripts: dev / build / dist
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ scripts/
│   ├─ dsh-node.cmd             # 用内置运行时执行 node/pnpm
│   └─ setup.ps1                # 首次安装依赖
├─ tools/tts-probe.mjs          # 火山 TTS/ASR 协议联调脚本（独立于 UI）
├─ src/
│   ├─ main/
│   │   ├─ index.ts
│   │   ├─ windows/{ball,bubble,settings}.ts
│   │   ├─ input/hotkey.ts
│   │   ├─ services/{asr,llm,tts,pipeline,sentence-splitter}.ts
│   │   ├─ store/{settings,secrets,history}.ts
│   │   ├─ tray.ts, ipc.ts, logger.ts
│   │   └─ assets/
│   ├─ preload/index.ts
│   ├─ renderer/
│   │   ├─ ball/    (index.html, Ball.tsx, ball.css, useDrag.ts)
│   │   ├─ bubble/  (index.html, Bubble.tsx, bubble.css)
│   │   ├─ settings/(index.html, Settings.tsx, panes/*.tsx)
│   │   └─ shared/  (types.ts, ipc-client.ts, theme.css)
│   └─ shared/  (settings schema, defaults, types)
└─ build/ icon.ico, tray.png
```

---

## 9. 交互细节（决定"手感"的部分）

- **拖动 vs 点击**：`pointerdown` 后位移 > 4px 判为拖动；否则 `pointerup` 判为点击（开/关气泡）。拖动时用 `screen.getCursorScreenPoint()` 在主进程移动窗口，避免 DPI 缩放抖动。
- **球体锚定气泡**：气泡默认出现在球体"空闲侧"（靠近屏幕边缘时自动翻转），三角指向球心；屏幕下方空间不足时向上弹。
- **状态动效**：idle（缓慢呼吸光）→ listening（外圈声波 + 电平条）→ thinking（三点）→ speaking（随播放电平脉动）。全部 CSS/Canvas 实现，不用 Lottie，保证 60fps。
- **气泡文字**：去 Markdown 标记后再显示（大模型爱输出 `**`、列表），保留换行与代码块缩进；单条超长时限制高度并内部滚动。
- **失败态**：401/超时/余额不足 → 气泡内红色提示 + "去设置"按钮；ASR 全空 → 轻提示"没听清"；TTS 失败 → 静默降级为纯文字，不打断对话。
- **隐身**：双击球体 → 全部窗口隐藏 + 全局键仍可唤起（可选，默认关，避免误触）；托盘/快捷键恢复。

---

## 10. 里程碑

| 阶段 | 交付物 | 验收标准 | 预估 |
|------|--------|----------|------|
| M0 骨架 | 工程可 `dev` 启动；三窗口出现；托盘 | 悬浮球能拖动、坐标重启后保留；设置窗可开 | 0.5d |
| M1 悬浮球 | 视觉完整；皮肤/尺寸/透明度可调；右键菜单 | 换皮肤即时生效；球体在游戏窗口之上不闪 | 0.5d |
| M2 语音输入 | 全局键监听 + 录音 + 火山 ASR + 实时字幕 | 按住说话松手后 0.5s 内气泡出现完整句子 | 1.5d |
| M3 对话 | LLM 流式 + 提示词 + 多轮 + 气泡打字 | 首字 < 1.5s；上下文可连续 8 轮 | 1.0d |
| M4 语音输出 | 火山 TTS + 分句流水线 + 播放 + 打断 | 首句出声 < 2.5s；说话间按麦 200ms 内静音 | 1.5d |
| M5 设置中心 | 五分区 + 加密存储 + 连通性测试 | 换 Key/音色/提示词免重启生效 | 1.0d |
| M6 打包 | 安装包 + 便携版 | 干净机器（无 Node）双击可用 | 0.5d |

> 预估为"集中开发"口径，实际按你的确认结果与调试反馈滚动调整。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 火山 TTS 二进制帧协议写错 | 无声、握手失败 | 先写 `tools/tts-probe.mjs` 打通，UI 只消费已验证的客户端 |
| 全局键鼠钩子在管理员权限游戏里收不到 | 开麦键失效 | 提示"以管理员身份运行"；备用 `globalShortcut` 方案；设置页显示钩子状态 |
| 独占全屏游戏遮挡悬浮窗 | 看不见球 | 文档提示改无边框窗口化；v1.1 检测全屏并提示 |
| 麦克风被游戏/语音软件独占 | 无法录音 | 设备选择 + 明确的错误提示 |
| 回声（AI 说话被自己麦克风听到） | 自问自答 | PTT 期间不录音即天然规避；VAD 模式下自动闪避 |
| 透明窗口在个别显卡驱动下黑底 | 视觉异常 | 设置里提供"关闭硬件加速/透明兼容模式"开关 |
| 本机无系统 Node | 你无法自行 `npm i` | 仓库内 `scripts/dsh-node.cmd` 指向内置运行时；README 写清两条命令 |
| 杀软误报、体积大 | 分发体验 | 标准 NSIS、不混淆、不静默装驱动 |

---

## 12. 待你确认的 5 件事

1. **技术栈**：Electron + React（推荐，装出来约 120MB）还是 Tauri（约 10MB，但工期长一倍）？
2. **语音识别来源**：只用火山流式 ASR（推荐，与 TTS 同一套 AppID/Token）？还是要额外支持 OpenAI 兼容 Whisper 接口？
3. **开麦方式**：按住说话（推荐，误触最少）／按一下开始再按一下结束（像逗逗的 Alt+X）／两种都做可切换？
4. **形象形态**：只要一个可换图的圆形悬浮球 + 气泡（v1 推荐）？还是需要带角色立绘/表情切换？
5. **平台范围**：只做 Windows 安装包 + 便携版即可，还是以后要兼容 macOS？

确认后我按 M0 → M6 直接开工，每个里程碑给你一次可运行的构建。
