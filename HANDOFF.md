# BeWithU 交接文档（2026-11-19，1.0.11 开发中）

> 接手先读 §0 和 §10。工作区包含未提交源码改动、未跟踪测试及发布文档；不要仅从 HEAD 导出。

---

## 0. 30 秒速览

| 项 | 值 |
|---|---|
| 代码位置 | `D:\coding\BeWithU` |
| 版本 | **1.0.11**（安全与可靠性修复开发中，尚未打包/发布） |
| HEAD | `2b2a24d`（1.0.10 基线） |
| 产物 | `out/` 是本轮源码 bundle；`release/` 仍只有 1.0.10 旧安装器/便携包，未生成 1.0.11 产物 |
| 工作区 | 有未提交的源码和文档改动，也有未跟踪的测试、安装校验脚本和审查报告。带回家应打包工作区文件，不能只导出 HEAD |

**白天那版**：Agent 能力层 M1（键鼠注入）+ M2（工具循环/审批/审计）+ 设置页，19 个内置工具。
**今晚这版**：把 Agent 能力补完整（自定义工具、Skill、MCP、联网搜索），修掉一批把功能打到不可用的 bug，
补了亮/暗主题、用量统计、模型列表，并出了 **1.0.x 正式版**。

**一句话现状**：能聊天、能看屏（需视觉模型）、能干活（21 个内置工具 + MCP）、能联网、有主题、有用量统计。
**最大的遗留**：没有代码签名（SmartScreen 会拦一次）、`input.*` 依赖真实前台、COM/UIA 还没做。

---

## 1. 今晚做了什么（按主题，含根因）

### 1.1 致命 bug：工具名让所有请求 400

- **现象**：气泡里发消息完全没反应。
- **根因**：工具 id 用点分层（`input.type`），而 OpenAI/DeepSeek 的函数名只允许 `[a-zA-Z0-9_-]`，
  每次 Agent 请求都被 400 拒；而 `runner` 捕获错误后只 `return` 文本、没走 `onText`，所以界面一片空白。
- **改法**：`registry.wireToolName()` 发送前把点换下划线，`buildWireMap()` 回包映射回真实 id；
  LLM 失败改走 `events.onText(friendlyAgentError(msg))`；pipeline 加兜底转发。
- **验证**：`tools/agent-llm-test.mjs`（本地假服务，函数名非法就照 DeepSeek 原文返回 400）。

### 1.2 工具 / Skill / MCP 三件套（M4 剩余）

| 能力 | 入口 | 存储 | 说明 |
|---|---|---|---|
| 自定义工具 | 设置 → Agent 能力 → 自定义工具 | `<userData>/agent/tools/<id>/` | `manifest.json` + `index.js`（`run(args, api)`），每次调用起一个 `utilityProcess`，能力只有 `log/fs.read/fs.write/notify/net` 且在**主进程**按 `permissions` 校验 |
| Skill | 同上 → Skill | `<userData>/agent/skills/<id>/SKILL.md` | frontmatter 只解析 `name/description/whenToUse`；渐进披露：提示词只放摘要，模型需要时调 `skill.read` 取全文 |
| MCP | 同上 → MCP 服务器 | 设置里的 `mcp.servers` | 手写极简客户端（**没引 SDK**）：stdio 走换行 JSON-RPC，HTTP 支持 SSE；任务开始前拉 `tools/list` 注册成 `mcp.<server>.<tool>` |

- **信任门禁**：自定义工具导入后默认「未信任」，不注册、模型看不到；勾选后才可用。
  UI 里明确写了"子进程是完整 Node，恶意代码能绕过 api，真正的闸门是信任勾选"。
- **zip 导入**：`agent/import-archive.ts` 用系统自带 `tar -xf` 解压（Windows 10+ 的 bsdtar 支持 zip），
  解到临时目录再走目录导入。工具/Skill 都有「导入压缩包…」，目录导入保留为次要入口。
- **测试**：`tools/mcp-zip-test.mjs` 6/6（zip 导工具/技能、MCP 连接/注册/真实调用）。

### 1.3 联网搜索（Tavily / DeepSeek Search）

- 服务：`services/web-search.ts`；工具：`agent/tools/web.ts`（`web.search`，第 21 个内置工具）。
- **两套触发**：
  - 开了 Agent：模型按需调 `web.search`（系统提示第 7 条：时效问题先搜、闲聊不搜）；
  - **没开 Agent**：`search.auto` 命中「最新/今天/新闻/比分/价格/版本…」时先搜，把结果塞进 system。
- 设置位置：**大模型页**（不是 Agent 页），两种 Key 分开存（`search.tavilyApiKey` / `search.deepseekApiKey`）。
- 计费：成功才收费（失败/空结果/超时不计），这一点在 README 里也写了。

### 1.4 亮 / 暗主题

- `ui.theme` 字段早就有但从没被应用。现在 `src/renderer/theme.ts` 的 `initTheme()` 在四个渲染入口都调用，
  设置变化通过 `settingsChanged` 广播到所有窗口。
- CSS 令牌化（`tools/theme-tokens.py`、`tools/theme-tokens-2.py`，可重跑）：
  - `rgba(255,255,255,a)` → `rgba(var(--ink),a)`，亮色下 `--ink` 翻成深色；
  - 浅灰文字 → `--text-2` / `--muted` / `--muted-ink` / `--text2-ink`；
  - 深色底 → `--sidebar-bg` / `--input-focus-bg` / `--btn-hover-bg` / `--pop-bg`。
- 侧栏底部有「☀ 亮色 / ☾ 暗色」按钮（图一红框位置），`settingsWin` 的 `titleBarOverlay` 也跟主题走。

### 1.5 窗口 / 菜单 / 徽标一批修复

| 问题 | 根因 | 改法 |
|---|---|---|
| 大球阴影被切 | 球窗 200px 容不下投影 | `BALL_WIN_SIZE` → **260**，默认位置按中心补偿 |
| 菜单开着拖球不跟 | 只在 show/size 时布局 | 监听球窗 `move` 实时布局 + 200ms 兜底 + show 后 60ms 再钉一次 |
| 菜单周围有黑框 | 去投影后仍留 14px `MENU_PAD`，透明窗口那圈被画成黑色 | `MENU_PAD = 0` + `.menu { margin: 0 }` |
| 菜单/气泡有灰底 | 透明窗口上的 `backdrop-filter` 会画一层灰 | 两者都去掉 `backdrop-filter`，气泡也不再 `setBackgroundColor` |
| 托盘菜单左右间距乱 | 系统 `Menu.popup` 的勾选列留白 | 托盘右键改**自绘菜单**（`showBallMenu(items, anchor)`，右对齐图标向上展开） |
| 隐藏球后用侧键只出气泡 | `startListening` 没查可见性 | 开头 `if (!isBallVisible()) showBallWindow()` |
| 菜单/气泡谁优先 | `showBubble()` 在菜单开着时直接 return | 改成先收菜单再弹气泡；点哪个开哪个 |
| 弹出方向 | 原来"右边放得下就右" | 按球心是否在**屏幕左半区**决定，放不下才反向 |
| 徽标位置/状态 | `bottom: 2px` 固定 + 只有"工作中" | `top: calc(50% + size/2 + 8px)`；两态 `💬 思考中…` / `💻 工作中…`；气泡头部状态文字删掉 |

### 1.6 TTS 只念前半句（Breeze）

- 日志实锤：`breeze http error 429 GENERATION_CONCURRENCY_EXCEEDED`。
- Breeze 计划并发上限 1，而 `SpeechQueue` 默认并发 2 → 第二句 429 被丢。
- 改法：构造时按 provider 传并发（breeze=1），`run()` 对 429 退避 1.2s 重试一次。

### 1.7 屏幕理解（Agent 模式一直没截图）

- 根因：只有纯聊天分支调了 `captureScreen`，`respondWithAgent` 从来没调，模型只能拿到 `input.screen_info` 的分辨率。
- 改法：Agent 任务开始前截图，作为首轮 user 消息的 `image_url`；模型不支持图片时去掉图重试一次并提示。
- 日志验证：`vision: Agent 已截屏 1600x900`。
- ⚠️ **要看画面必须用视觉模型**（gemini-flash 之类）。`deepseek-flash` 是纯文本模型，会走降级提示。

### 1.8 "（没有需要汇报的内容）"

- 根因：模型跑满步数却没写收尾文本，兜底把步骤日志摊给用户。
- 改法：**收尾轮**——循环结束仍无文本时，再发一次 `tools: []` + `tool_choice: 'none'` 的请求，
  提示"用 1-3 句话汇报结果"；只有收尾轮也失败才用 `fallbackText()`（只说结论/卡点，不列步骤）。

### 1.9 完全信任模式

- `agent.shellEnabled` 语义升级：开启后**所有**高风险工具（Shell / 写文件 / 键鼠 / MCP）跳过确认卡，
  不再只是 `shell.ps`；`policy.ts` 的硬红线仍然拦（删盘、格式化、关机、改启动项、fork 炸弹）。
- 工具列表徽标会从「需确认」变「已信任」；系统提示第 4 条同步改口径。
- 验证：`shellEnabled=true` + `autoApprove=false` 时 `file.write` 直接执行成功。

### 1.10 模型列表 + 用量统计

- **模型列表**：`llm.listModels()` 走 OpenAI 兼容 `GET /models`（baseUrl 自动推导），
  设置 → 大模型 → 模型名旁「获取列表」→ 下拉选择。实测 DeepSeek 返回 `deepseek-flash`、`deepseek-v4-pro`。
- **用量统计**：`store/usage.ts` 存 `usage.json`，按天记账：
  - 对话 / 记忆总结：token（流式用 `stream_options.include_usage`，Agent 非流式读响应体）
  - TTS：合成字数；云端 ASR：音频秒数（16kHz 16bit → 字节/32000）
  - 设置 → 关于 → 用量统计：今日 / 本月，可刷新 / 清零
  - 注意：从 1.0.2 才开始记账，之前的数据没有。

### 1.11 发版

- **1.0.0 正式版**（`2dacc16`）→ **1.0.1**（`feab632`）→ **1.0.2**（`62bea6f`）。
- 规则：**每次更新都改 `package.json` 的 `version`**，打包前**先清空 `release/`**。
- 历史版本曾自动解除安装包下载标记；该行为已在第一批修复中移除。当前用法以 [安装校验说明](README.md) 和 §10 为准。

---

## 1.12 v1.0.3（本次）

| 改动 | 位置 | 说明 |
|---|---|---|
| **Agent 自动路由** | `agent/router.ts`（新）、`pipeline.respond()` | 不再需要"自动档"开关：`agent.enabled` 打开后，按规则判断这句是聊天还是干活。打分制（明确任务词权重 3、泛任务词 2、路径/文件名 +3、闲聊词 -2），阈值 3；`lastWasTask` + 「继续/改成/好了」续说会继续走 Agent。单测 `tools/router-test.mjs` 18 条 |
| **闲聊不再乱发截图** | `pipeline.respond()` | 只有 `wantsScreenReference(text)` 命中（看/屏幕/界面/这个/报错…）才截图；带图提示词改成"仅作参考、不要主动描述画面" |
| **任务中自动收起气泡** | `pipeline.respondWithAgent()` | 任务开始 `hideBubble()`（用户钉住时不动）；确认卡出现时临时 `showBubble()`，确认后收起；任务结束 `showBubble()` 弹回 |
| **徽标两态 + 绿/金** | `AgentProgress.mode`、`Ball.tsx`、`ball.css` | 模型思考 = `💬 思考中…`（绿 `#6ee7b7`）；调工具 = `💻 工作中… 3/10`（金 `#fde68a`）；工具返回后自动切回思考 |
| **球默认不透明度 100%** | `shared/defaults.ts` | 新装默认 `opacity: 100`（老配置不动） |
| **亮色对比度** | `settings.css` | `.agent-tool__name` 等硬编码浅灰改成 `var(--text)` / `rgba(var(--ink),a)`；工具风险徽标加了亮色覆盖 |

验证：`router-test` 18/18、`agent-ui-test` 13/13（新增：气泡自动收起/确认弹回/结束弹回、徽标绿金两态、progress 顺序 thinking→working→thinking）、`menu-test` 6/6（修了负坐标传参 + 首次引导气泡顶掉菜单的测试问题）、其余回归全绿。
截图：`.shots/settings-agent-light.png`、`badge-thinking.png`、`badge-working.png`。

> 注意：首次运行引导气泡弹出时会收掉右键菜单（气泡与菜单互斥的既有行为）。测试里靠提前写入占位 API Key 规避。

---

## 1.13 v1.0.4（本次）

| 改动 | 位置 | 说明 |
|---|---|---|
| 亮色工具名太黑 | `settings.css` | `.agent-tool__name` 从 `var(--text)`（近纯黑）改成 `var(--muted)` + 500 字重，跟分区说明文字同一档灰 |
| 徽标去掉进度数字 | `Ball.tsx` | 「💻 工作中…」不再带 `3/10`，只保留状态 |
| **Shell 输出乱码** | `agent/shell-run.ts` | 根因：Windows PowerShell 5.1 按控制台代码页（中文系统 GBK）写 stdout，直接用 UTF-8 解码就成了「锟斤拷」。改法：先 UTF-8 解码，出现替换字符再回退 `TextDecoder('gbk')`；同时清理 CLIXML / ANSI 噪音。**不要**再往命令里塞编码前缀（PowerShell 报错会把前缀抄进错误文本） |
| 中文报错 | 同上 | `Write-Error "出错了…"` 现在能正常显示中文，不再是一串乱码 |

验证：`tools/shell-encoding-test.mjs` 3/3（中文 stdout、中文 stderr + 非 0 退出、中文文件名）；`agent-ui 13/13`、`app 16/16`、`menu 6/6`、`router 18/18`、`agent-run 7/7`。
截图：`settings-agent-light.png`、`badge-working.png`。

---

## 1.14 v1.0.5（本次）

| 改动 | 位置 | 说明 |
|---|---|---|
| 模型名不预填 | `shared/presets.ts` + `ModelPane` | 切服务商只填 Base URL，模型名留空（输入框里的 `doubao-seed-1.6-flash` 是 placeholder，不是值）；用户点「获取列表」或手填 |
| 默认亮色 | `shared/defaults.ts` | `ui.theme` 默认 `light`（老用户已保存的配置不变） |
| **思考模式** | `LlmSettings.thinking`、`llm.ts`、`llm-agent.ts` | 设置 → 大模型：「启用思考」+「思考等级」低/中/高（默认中） |
| 报文兼容 | `thinkingParams()` / `looksLikeParamReject()` | 默认发 `reasoning_effort`；模型/域名像 qwen 时加 `enable_thinking`；像 openrouter/anthropic 时加 `thinking:{type:'enabled'}`。**服务端 400 且报错提到这些参数时，自动去掉参数重试一次**，并记住该端点不再带参数 |
| 思考内容展示 | `Bubble.tsx` + `bubble.css` | 气泡顶部折叠块「💭 思考过程」，默认收起；点击展开；不播报、不进上下文/记忆 |
| 思考解析 | `llm.ts` / `llm-agent.ts` | 同时兼容 `reasoning_content`（DeepSeek/多数中转）与 `reasoning`（OpenRouter 等）字段；流式和非流式都解析 |

验证：`tools/thinking-test.mjs` 6/6 —— 聊天带 `reasoning_effort:"high"`、思考块展示、Agent 非流式同样带参数、服务端 400 时自动降级后仍能正常回答。
回归：`app 16/16`、`menu 6/6`、`agent-ui 13/13`、`agent-run 7/7`、`router 18/18`、`agent-settings 8/8`。
截图：`settings-model-thinking.png`（亮色 + 思考开关 + 空模型名）。

---

## 1.15 v1.0.6（本次）

### 气泡结构（思考/步骤区）

- 思考（灰底）与步骤（绿底）两行**左右各缩进 12px**，不再通栏贴边；
- 外层 `.proc` 用 1px 分割线与**头部**和**消息区**分开（`rgba(var(--ink),0.14)`）；
- 审批卡从 proc 里移出，回到消息层（`.card__body > .approve` 缩进 12px）；
- 结构：`头部 ─ 分割线 ─ [思考][步骤] ─ 分割线 ─ [审批卡] ─ 消息 ─ composer`
- 注意：`bubble.css` 里没有 `--border` 变量，气泡内的分割线必须用 `rgba(var(--ink), a)`，用 `var(--border)` 会因为变量不存在而整条边框失效（这次踩过）。

### 思考混进回答（真因与三层修复）

1. **中间轮的过程叙述被当成回答**：带 `tool_calls` 的那一轮，模型常写"好，我先把 B 站打开…"；之前每轮 `text` 都 append 到同一条回答里，于是看起来像"思考掺进回复 / 分段冒出来"。
   → `runner` 现在把带工具调用那轮的 text 归为 `onNarration`（只写日志），**只有最后一轮/收尾轮的 text 才进气泡**。
2. **提示词收紧**：Agent 系统提示第 7/8 条 —— 调用工具前不要写过程叙述、汇报时不要复述用户原话/不要描述思考与工具选择。
3. **正文去重**：`stripReasoningLeak()` 去掉 `<thinking>…</thinking>` 标签，并在 `content` 与 `reasoning` 公共前缀 ≥12 字时裁掉重复段（应对少数把思考抄进正文的实现）。
4. **诊断**：新增日志 `agent: llm turn content=<len> reasoning=<len> tools=<n> model=…`（只记长度不记内容），下次可直接确认模型返回形态。

### 气泡"说收起却没收起"（真因）

- `setBubbleCardSize()` 无条件调用 `layoutBubble()`；任务中隐藏时，渲染进程仍在测量尺寸（步骤/思考在变），主进程就把已经挪到屏幕外的窗口**又挪回了可见位置**，而 `bubbleVisible` 标志仍是 false —— 所以日志显示 hide、用户看到还在。
- 修复：`layoutBubble()` 在 `!bubbleVisible` 时直接 return；`setBubbleCardSize()` 隐藏时只更新尺寸不布局；`isBubbleVisible()` 改成**同时检查窗口真实坐标**（`|x|<30000`），避免测试被标志位骗过。

验证：`agent-ui 14/14`（新增布局分割线/缩进断言、真实可见性断言）、`agent-run 8/8`（新增"过程叙述不混入回答"）、`thinking 6/6`、`app 16/16`、`menu 6/6`、`router 18/18`、`agent-settings 8/8`、`shell-encoding 3/3`。
截图：`agent-approve.png`。

---

## 1.16 v1.0.7（本次）

| 问题 | 根因 | 修法 |
|---|---|---|
| 图一：模型说"工具集里没有截图" | Agent 只有任务开始时的一张**输入图片**，没有截图工具；而 `deepseek-flash` 之类纯文本模型根本看不到那张图，于是它"诚实地"说自己没有截图能力 | 新增第 22 个工具 `screen.capture`（截屏存 PNG 返回路径）；系统提示第 9 条说明"能否看图取决于模型"；模型一旦拒绝图片就记到 `vision-state`，后续任务不再抓屏也不再硬塞图 |
| 图二：上面分割线会跟着滚 | `.proc` 原来在 `.card__body`（滚动容器）里 | `.proc` 移到 header 与 body 之间，`flex: none`；body 只滚消息。测试新增 `procNotScrollable`（滚动 body 后 proc 位置不变） |
| 分割线深浅不一 | `.proc` 用 0.14、`.composer`/`.card__foot` 用 0.06 | 新增 CSS 变量 `--line: rgba(var(--ink), 0.1)`，三处统一用它 |

验证：`agent-ui 15/15`（新增 proc 不滚动断言）、`agent-run 8/8`（工具清单含 `screen.capture`）、`thinking 6/6`、`app 16/16`。
截图：`agent-approve.png`。

---

## 1.17 v1.0.8（本次）

上一版把 `.proc` 移出滚动容器后，**卡片没有总高度上限**，于是展开思考会把整个窗口撑大；同时 `.card__body` 只有 `max-height` 没有 `flex`，在固定头部/输入区挤压下滚动会失效。这次把"三段式"补齐：

| 区域 | 规则 |
|---|---|
| 头部 / 思考步骤区（`.proc`）/ 输入区（`.composer`、`.card__foot`） | `flex: none`，永远固定 |
| 消息区（`.card__body`） | `flex: 1 1 auto; min-height: 96px; max-height: 302px; overflow-y: auto` —— 唯一可伸缩、可滚动 |
| 卡片（`.card`） | `max-height: 520px` —— 展开思考时压缩消息区，而不是顶大窗口 |
| 思考正文（`.think__body`） | `max-height: 108px; overflow: auto` —— 内容多时自己滚 |
| 审批卡 | `margin: 12px 12px 10px`，与上方分割线留白 |

验证：`agent-ui 18/18`，新增三条断言：`bodyStillScrollable`（滚动 body 生效）、`thinkExpandNoGrow`（展开思考后卡片 ≤520）、`approveSpacing`（审批卡与分割线间距 ≥8px，实测 12px）。
截图：`agent-approve.png`。

---

## 1.18 v1.0.9（本次）：把决策权还回模型

| 改动 | 说明 |
|---|---|
| **删除意图路由** | `src/main/agent/router.ts`、`tools/router-test.mjs`、IPC `agent:test-classify` 全部删除。开了 Agent 后**所有话都进 Agent**，由模型自己决定"只回一句"还是"调工具" |
| **删除关键词匹配** | 闲聊截图不再要求命中"看/屏幕"等词；关键词自动搜索（`search.auto` + `shouldSearch`）整段删除（设置项、类型、默认值、UI 一并清掉） |
| **删除束缚模型的视觉提示** | 删掉 Agent 提示词第 9 条、`screen.capture` 里"你能否看到取决于模型"的措辞、图片被拒时弹给模型的"不支持看图"文字、`vision-state` 模块 |
| **提示词全部可改** | 新增 `Settings.prompts`：`agent`（支持 `{{max_steps}}` / `{{shell_rule}}` 占位符）、`closing`、`summary`、`visionNote`；设置 → 提示词页四个区块都能看、能改、能恢复默认 |
| **收起时机** | 不再"任务一开始就收起"，改为**模型第一次真的调工具时**才收起；纯聊天保持窗口可见（审核卡临时弹出后按需再收起） |

验证：`prompts-test 4/4`（默认值存在、四个区块可见、自定义能持久化、请求里真的用上自定义内容）、`agent-ui 18/18`、`agent-run 8/8`、`thinking 6/6`、`app 16/16`。

---

## 1.19 v1.0.10（本次）

| 改动 | 说明 |
|---|---|
| **气泡布局改回方案 A** | 头部固定（`.card__head` 加 `border-bottom: var(--line)`）→ 思考/步骤 + 消息都在 `.card__body` 里一起滚 → 输入区固定。`.proc` 回到 body 内、去掉上下分割线，只保留 12px 缩进 |
| **悬浮球置顶看门狗** | 现象：一开始置顶，用着用着就谁都能盖。修复：`ensureBallTop()` 每 1.5s 重新 `setAlwaysOnTop(true,'screen-saver')`；监听 `always-on-top-changed` 与 `show` 立刻拉回。只声明标志、不 `moveTop`，所以不会把气泡/菜单压下去 |
| 搜索提示文案 | 去掉"自动搜"的旧说法 |

测试：`agent-ui 19/19`，新增 `procInScrollBody`、`headerDividerAndInset`、`ballTopWatchdog`（故意 `setAlwaysOnTop(false)`，1.5s 内必须恢复）。

---

## 2. 代码结构（今晚新增的用 ★）

```
src/main/
  agent/
    index.ts            ★ 工具注册 + MCP 动态注册 + callTool（审计挂这里）
    registry.ts         ★ wireToolName / buildWireMap（工具名映射）
    runner.ts           ★ 主循环 + 收尾轮 + 信任模式 + 图片降级
    llm-agent.ts        ★ chatWithTools(toolChoice) + usage 记账 + mock
    approval.ts         确认卡（气泡 + 语音"同意"）
    policy.ts           硬红线
    audit.ts            审计 JSONL
    custom-tools.ts     ★ 第三方工具：manifest/信任/子进程执行
    import-archive.ts   ★ zip 解压（系统 tar）
    skills.ts           ★ Skill 扫描/导入/删除/提示词摘要
    mcp.ts              ★ 手写 MCP 客户端（stdio + HTTP/SSE）
    tools/{input,files,shell,system}.ts   原有 19 个
    tools/{skills,web}.ts                  ★ skill.read / web.search
  tool-worker.ts        ★ 自定义工具执行进程
  services/
    web-search.ts       ★ Tavily / DeepSeek Search
    pipeline.ts         ★ 模式分流、闲聊自动搜索、Agent 截图、SpeechQueue 并发/重试
    llm.ts              ★ listModels / usage 解析 / purpose
    tts.ts asr.ts       ★ 用量记账
  store/
    usage.ts            ★ 按天用量
    settings.ts         ★ 新字段归一化（trustedTools/skillsEnabled/search/mcp）
  windows.ts            ★ 主题、菜单跟随、半屏方向、互斥、BALL_WIN_SIZE=260
  tray.ts               ★ 自绘托盘菜单
src/renderer/
  theme.ts              ★ 主题应用
  settings/panes/{AgentPane,ModelPane,AboutPane,BallPane,VoicePane}.tsx
  menu/menu.css         ★ 无投影、无留白
src/shared/{types,defaults,ipc}.ts   ★ 新类型/通道
tools/                  ★ 新增 4 个测试 + fixtures
scripts/install-app.cmd ★
```

内置工具 **21 个**（19 + `skill.read` + `web.search`），MCP 工具运行时动态追加。

---

## 3. 关键机制速记

- **模式选择**：只有全局开关 `agent.enabled`，**没有意图路由**。开着=每句都进工具循环（非流式）；
  关着=纯聊天（流式，无工具，但仍有屏幕理解 + 关键词自动搜索）。
  想加自动路由的话，建议「关键词 + 手动三档（始终 Agent / 始终聊天 / 自动）」。
- **一轮 Agent**：`respondWithAgent` → 截图 → `runAgentTask`（最多 `maxSteps`）→ 每步 `runOne`
  （禁用检查 → 硬红线 → 信任模式/审批 → 执行带超时）→ 结果回填 → 没有文本就**收尾轮**。
- **审批**：高风险工具默认提示确认，MCP 不受本地免确认设置影响；15 秒超时默认拒绝。确认绑定当前对话，停止或切换对话会撤销待确认请求。文字/语音只接受完整确认短句。
- **审计**：`<userData>/agent/runs/YYYY-MM-DD.jsonl`，保留 7 天。
- **键鼠注入**：koffi 只能在 `utilityProcess`（`input-worker.ts`）里跑，主进程调用会 0xC0000005。
- **用量**：只统计本机调用，不上报；本地 TTS/本地识别不产生费用。

---

## 4. 新增/变更的设置字段（`src/shared/types.ts`）

```ts
ui.theme: 'dark' | 'light'          // 现在真的生效了
agent.trustedTools: string[]        // 已信任的自定义工具
agent.skillsEnabled: boolean        // 是否注入 Skill 摘要
search: { enabled, provider: 'tavily'|'deepseek', tavilyBaseUrl, tavilyApiKey,
          deepseekBaseUrl, deepseekApiKey, maxResults, auto }
mcp: { servers: McpServerConfig[] } // transport: 'stdio' | 'http'
```

---

## 5. 测试（都需要清 `ELECTRON_RUN_AS_NODE`，且用自带 Node）

```powershell
$d = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
$node = "$d\node\bin\node.exe"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

& $node node_modules\typescript\lib\tsc.js --noEmit -p tsconfig.node.json
& $node node_modules\typescript\lib\tsc.js --noEmit -p tsconfig.web.json
& $node node_modules\electron-vite\bin\electron-vite.js build

& $node tools\agent-ext-test.mjs      # 自定义工具 + Skill   10/10
& $node tools\agent-llm-test.mjs      # 工具名合法性/错误可见 2/2
& $node tools\search-test.mjs         # 联网搜索两条通路     4/4
& $node tools\mcp-zip-test.mjs        # zip 导入 + MCP       6/6
& $node tools\agent-run-test.mjs      # Agent 主循环         7/7
& $node tools\agent-settings-test.mjs # 设置页               8/8
& $node tools\agent-input-test.mjs    # 键鼠注入（依赖真实前台，可能不稳）
& $node tools\app-test.mjs            # 界面回归（真鼠标点击，用户动鼠标会偶发失败）
& $node tools\menu-test.mjs           # 右键菜单
& $node tools\player-test.mjs         # 播放器
```

- 每个测试之间先 `Stop-Process electron`，否则单实例锁会让新实例直接退出。
- mock LLM：`BWU_AGENT_MOCK` 指向 JSON，场景按用户文本包含的关键字匹配；**JSON 必须是 UTF-8 无 BOM**，
  场景 key 用英文（中文会被 `Set-Content -Encoding ascii` 之类的写法毁掉）。
- `BWU_AGENT_TEST=1` 才注册测试通道（`agentTest.list/call/run/importTool...`、`mcpTools`）。
- 打包版也能跑：`BWU_TEST_EXE=release\win-unpacked\BeWithU.exe node tools\agent-llm-test.mjs`。

---

## 6. 打包发版

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$d = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
& "$d\node\bin\node.exe" node_modules\electron-builder\cli.js --win --x64
```

**流程（1.0.0 之后固定）**
1. 改 `package.json` 的 `version`
2. `Remove-Item -Recurse -Force release\*`（别把旧包一起发出去）
3. 后台跑打包（必须 background job，前台会超时留半成品）
4. 校验：`release/win-unpacked/resources/app.asar.unpacked/node_modules/koffi` 存在、
   `app.asar` 时间戳是新的、两个 exe 时间是新的
5. `git add -A && git commit && git push`

产物命名由 `artifactName: ${productName}-${version}-${arch}` 自动生成；便携版单独一条 `portable.artifactName`。

**SmartScreen**：没有代码签名，下载后首次运行会提示"Windows 已保护你的电脑"。
右键属性「解除锁定」或跑 `scripts/install-app.cmd` 可绕过；要彻底消除得买代码签名证书
（EV 立刻生效、OV 要攒信誉、Azure Trusted Signing 要求 3 年企业历史）。README 的 FAQ 有完整说明。

---

## 7. 已知问题 / 下一步

| 项 | 说明 |
|---|---|
| **意图路由** | 现在只有全局开关。建议加「自动」档（关键词先分流，闲聊走流式聊天） |
| **COM / UIA** | 还没做。设计见旧文档：常驻 PowerShell 代理做 Excel/Word/PPT，UIA 按控件名点击 |
| **输入注入** | 依赖真实前台/未锁屏；`expectTitle` 可做兜底校验 |
| **file.write** | 只做 `.bak`，没有版本历史 |
| **shell 硬红线** | 正则匹配，复杂混淆命令可能绕过（用户接受"开启即信任"的风险模型） |
| **MCP** | 只实现 initialize / tools.list / tools.call；没有 resources/prompts/采样；stdio 不支持自定义 env |
| **TTS** | Breeze 并发 1 已适配；切回声线时注意 429 退避只有一次 |
| **用量** | 仅 token/字数/秒数，不折算金额（各家单价不同） |
| **主题** | ball 窗口是透明角色图，未做亮暗区分；气泡亮色下已补对比度，但样式是 second-pass 的 |
| **签名** | 无（见 §6） |

---

## 8. 环境坑（能省几小时，按重要性排）

1. **别用 `Get-Content` / `Select-String` 判断文件内容**：本机 PowerShell 默认按 GBK 解码 UTF-8，
   中文会显示成乱码（`锛?`）。文件其实是好的。**读代码用 read 工具，或 `Get-Content -Encoding UTF8`**。
   今晚差点因为它们去"修"一堆没坏的文件。
2. **`.cmd` / `.ps1` 只能 ASCII**；含中文的源码一律用 write/edit 工具，不要用 PowerShell 重写。
3. **`ELECTRON_RUN_AS_NODE` 必须先清**，否则 `electron.exe` 会被当成 node。
4. **单实例锁**：残留的 `BeWithU.exe` 会让新实例启动即退（exit 0）。测试前 `Stop-Process BeWithU,electron`。
5. **koffi 只能在 utilityProcess 里**（主进程调用无输出崩溃）。
6. **pnpm store 漂移**：`node_modules` 是用另一台机器的 store（`C:\Users\jiangchengrui\...\.pnpm-store`）装的，
   现在直接 `pnpm add` 会报错。**不要随便加依赖**——zip 用系统 `tar`、MCP 手写客户端就是为了避开这个。
   真需要装：先 `pnpm install --store-dir D:\coding\BeWithU\.pnpm-store`。
7. **mock JSON 的 BOM**：`Set-Content -Encoding UTF8` 在 5.1 会加 BOM，`JSON.parse` 直接报错；
   用 `[IO.File]::WriteAllText(path, text, [Text.UTF8Encoding]::new($false))`。
8. **透明窗口三不要**：不要 `backdrop-filter`、不要 `setBackgroundColor`、窗口尺寸不要比内容大（会被画成黑框）。
9. **打包必须后台 job**；前台会因超时被杀，留下半成品。

---

## 9. 关键文件速查

| 想改什么 | 去哪 |
|---|---|
| Agent 循环 / 收尾轮 / 信任模式 | `src/main/agent/runner.ts` |
| 工具名映射（400 问题） | `src/main/agent/registry.ts` |
| 自定义工具 / 信任 / 子进程 | `agent/custom-tools.ts` + `src/main/tool-worker.ts` |
| Skill | `agent/skills.ts` + `agent/tools/skills.ts` |
| MCP | `agent/mcp.ts` + `agent/index.ts(ensureMcpTools)` |
| 联网搜索 | `services/web-search.ts` + `agent/tools/web.ts` + `ModelPane.tsx` |
| 用量 | `store/usage.ts` + `AboutPane.tsx` |
| 模式分流 / TTS 队列 / 截图 | `services/pipeline.ts` |
| 主题 | `src/renderer/theme.ts` + `settings.css` / `bubble.css` / `menu.css` |
| 窗口几何 / 菜单 / 托盘 | `src/main/windows.ts` + `src/main/tray.ts` |
| 设置页 | `src/renderer/settings/panes/*.tsx` + `src/shared/{types,defaults,ipc}.ts` |

---

## 10. 当前状态：安全与可靠性修复

### 已完成，未提交、未发布

- **审批与 MCP**：停止或切换对话会撤销待确认操作；执行前复核权限和取消状态。MCP 配置变更会撤销旧工具和连接，远端工具仍逐次确认。[审批](src/main/agent/approval.ts) · [MCP 注册](src/main/agent/index.ts) · [执行入口](src/main/agent/runner.ts)
- **文件与窗口权限**：校验允许目录和实际落点，包括备份与自定义工具入口；preload 按窗口角色暴露接口，主进程核验窗口和主框架，生产版不开放测试 IPC。路径检查和子进程均不是操作系统沙箱。[文件工具](src/main/agent/tools/files.ts) · [IPC](src/main/ipc.ts) · [preload](src/preload/index.ts)
- **截图隐私**：新配置默认关闭，启用时提示截图范围和传输对象；已有配置原样保留。普通截图和 WGC 使用同一目标显示器，无法匹配时不换屏；WGC 回包带请求 ID。[视觉服务](src/main/services/vision.ts) · [WGC](src/main/vision-grab.ts)
- **迁移与安装**：迁移包含用量和 Agent 数据，经 SHA-256 校验后才切换，源目录保留；恢复默认时先归档之前的默认应用数据。安装脚本不解除下载标记，要求显式路径和可信摘要或发布者证书指纹。[迁移](src/main/data-dir.ts) · [安装脚本](scripts/install-app.cmd) · [校验脚本](scripts/check-installer.ps1)
- **本轮追加**：ASR 会话 generation 防止跨轮回写；MCP headers 加密落盘且公开 DTO 脱敏；Agent 单次多工具调用按剩余步数截断，拒绝未知工具并在超时请求取消；LLM 400 视觉回退与 Breeze 429 重试改用结构化 HTTP 状态；设置保存失败显式显示并保留 patch。

### 已验证与待验证

- 交接前验证记录：主进程及渲染端 TypeScript 检查通过，Electron/Vite 生产构建成功（输出到系统临时目录），四个新增测试 **14/14** 通过。该记录对应交接生成时的环境，不代表下方本次复验。
- 本轮环境：Node.js **v24.21.0**、pnpm **11.28.5**；依赖按 frozen lock 恢复，`pnpm-lock.yaml` 未修改。主/渲染 TypeScript 检查通过，Electron/Vite bundle 构建通过（输出至 `out/`）。最新全量结果：unit/security **21/21**、Agent runner E2E **10/10**、扩展/Skill E2E **10/10**、MCP ZIP E2E **6/6**、播放器 **6/6**；另新增 `asr-model-manifest.test.mjs`（2 assertions grouped in 1 test），单独通过。`git diff --check` 通过。
- E2E 管理操作使用最小权限窗口：Agent runner 设置通过设置窗，Skill/MCP 管理通过气泡打开设置窗；没有放宽生产 IPC。
- 安装校验脚本正反例曾用一次性 `-ExecutionPolicy Bypass` 子进程验证；未改系统执行策略，也未启动安装器。
- 版本为 **1.0.11**，但尚未完成该版本生产打包/安装器验收。`release/` 保留原 1.0.10 产物；本轮未清理或覆盖。
- **ASR 当前进度**：已从官方 sherpa-onnx GitHub release `asr-models` 的 `checksum.txt` 找到 int8 archive SHA-256 `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`；官方 release API 中该 checksum 清单的 asset digest 为 `sha256:a96a8ecfa4377305cce41cf5cc3833552477e547ff7ad10a2c9615b3e6921f1a`，上传者为 `github-actions[bot]`。代码已改为固定官方 release archive、校验归档和两个文件 hash/size 后再 staging 发布，`modelReady()` 也校验每个文件 hash。**未完成实测**：归档下载因网络速度低而停止，临时文件 `%TEMP%\\bwu-sensevoice-int8-2024-07-17.tar.bz2` 仅约 16 MB（完整 163,002,883 bytes），不可解包/使用；需续下后比对 archive SHA、检查 tar 清单和文件 hash，再测试提取流程。不要把该 partial 当作模型。
- **下一步**：先续传并完整校验上述官方 ASR archive；运行 ASR manifest/download/extraction tests。随后执行 typecheck、全量 E2E，再启动本轮 `out/` 对应源码 GUI 做隔离冒烟。确认 `koffi` 可用于当前 Node/Electron ABI 后，将 builder 输出设到独立 staging，不清理旧 `release/`；校验 app.asar 时间、koffi unpacked 文件、版本与 exe，再算 SHA-256。只有全部通过后才将 1.0.11 产物放入 `release/` 并生成独立发布清单。
- **发布阻塞**：1.0.11 新安装器和 portable 尚未生成；需验证 koffi 原生模块被 builder 正确打入，并做新包隔离启动、测试和 SHA-256 发布清单。真实多屏/WGC、ASR 设备、代码签名及外部发布也未完成。

### 源码搬运

- 打包当前工作区，不要用仅包含已提交内容的 `git archive HEAD`。务必带上这份交接、[审查报告](REVIEW.md)、[安装校验脚本](scripts/check-installer.ps1)和所有未跟踪测试文件（包含审批、迁移、文件边界、抓屏、MCP 密钥、ASR manifest/retry、工具预算及 ASR generation 测试；仅按 Git 跟踪文件打包会漏掉它们）。
- 可排除 `node_modules/`、`.pnpm-store/`、`.cache/`、`out/`、`release/`、`.shots/` 和本地日志/录音样本；保留源码、脚本、资源、构建配置及锁文件。不要打入真实应用数据目录、API Key 或凭据。是否带 `.git/` 按是否需要保留历史决定。
