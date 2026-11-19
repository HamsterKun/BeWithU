# BeWithU 交接文档（2026-11-19，1.0.12 已打包待签名/发布）

> 接手先读 §0 和 §10。1.0.12 已提交、已打包、已跑完整回归（含本轮新增的 SSE 尾帧与录音取消测试），
> 剩下的都是签名、外部发布、真机矩阵和官方 ASR 归档整包。

---

## 0. 30 秒速览

| 项 | 值 |
|---|---|
| 代码位置 | `D:\coding\BeWithU` |
| 版本 | **1.0.12**（C8 SSE 尾帧 + C1 录音启动取消 + A8 文件 I/O 限流；已打包，未签名，未对外发布） |
| HEAD | `main` 上 1.0.12 的提交：产品代码/测试在 `b343897`，本文档与发布清单紧随其后一个提交（`git log --oneline -3` 可看到） |
| 产物 | `release/` 已是 1.0.12 安装器 + 便携包（含 `SHA256SUMS-1.0.12.txt`、`RELEASE-1.0.12.md`）；1.0.10 / 1.0.11 产物分别在 `release/archive-1.0.10/`、`release/archive-1.0.11/` |
| 工作区 | 干净（`git status` 无输出）；`out/` 是本轮源码 bundle，`release/`、`out/` 都被 gitignore |

**白天那版**：Agent 能力层 M1（键鼠注入）+ M2（工具循环/审批/审计）+ 设置页，19 个内置工具。
**今晚这版**：把 Agent 能力补完整（自定义工具、Skill、MCP、联网搜索），修掉一批把功能打到不可用的 bug，
补了亮/暗主题、用量统计、模型列表，并出了 **1.0.x 正式版**。

**一句话现状**：能聊天、能看屏（需视觉模型）、能干活（22 个内置工具 + MCP）、能联网、有主题、有用量统计；
1.0.11 把评审里的权限、隐私、迁移、供应链问题补完，产物已打包并通过完整回归。
**最大的遗留**：没有代码签名（SmartScreen 会拦一次）、`input.*` 依赖真实前台、COM/UIA 还没做、官方 ASR 归档整包未下载校验。

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

## 1.20 v1.0.11（本次）：安全与可靠性修复 + 打包验收

评审报告在 [REVIEW.md](REVIEW.md)，逐条修完后这一版把"能发"补齐。

| 主题 | 改法 | 关键文件 |
|---|---|---|
| 审批撤销 | 待确认请求绑定对话/轮次，停止、切轮、关窗即撤销并默认拒绝；执行前再复核取消状态 | `agent/approval.ts`、`agent/runner.ts`、`services/pipeline.ts` |
| MCP 撤权 | 配置变更/移除时注销旧工具并断开连接，调用时按实时配置校验；远端工具仍逐次确认 | `agent/index.ts`、`agent/mcp.ts` |
| 文件边界 | 允许目录 + 实际落点都校验（含 `.bak` 与自定义工具入口），拒绝 reparse point | `agent/tools/files.ts` |
| 工具预算 | 单次响应内多工具按剩余步数截断，拒绝未公开的工具名，超时请求取消 | `agent/tool-budget.ts`、`agent/runner.ts` |
| 窗口角色 | preload 按 `--bwu-role=` 只暴露该窗口需要的接口，主进程校验发送窗口与主 frame；生产版不注册测试 IPC | `src/preload/index.ts`、`main/ipc.ts`、`main/windows.ts` |
| 截图隐私 | 新配置默认关闭、开启时说明范围；匹配不到目标显示器就跳过；WGC 回包带请求 ID 并校验图像 | `services/vision.ts`、`vision-grab.ts` |
| 数据迁移 | 迁移清单覆盖用量/Agent/Skill/模型，逐文件 SHA-256 校验后才切指针，源目录保留 | `main/data-dir.ts` |
| ASR 完整性 | 固定官方 release 归档 + 两个文件的 hash/size，先 staging 校验再发布；`modelReady()` 也验哈希 | `services/asr-model.ts`、`asr-model-manifest.ts` |
| 结构化错误 | LLM 400 视觉回退、Breeze 429 退避改用 HTTP 状态码而不是猜错误文本 | `services/http-error.ts`、`retry-policy.ts` |
| ASR 竞态 | 录音会话 generation，旧回调不能写进新轮 | `services/asr-generation.ts` |
| 安装脚本 | 不再解除下载标记；要求显式路径 + 可信 SHA-256 / 发布者证书指纹 | `scripts/install-app.cmd`、`check-installer.ps1` |
| 测试入口 | 管理类 E2E 改走真实路径：点球 → 气泡 → 设置窗（球窗已经没有管理接口） | `tools/lib/settings-window.mjs` + 各 E2E |

**验收（本轮实跑）**：typecheck 双端通过；`electron-vite build` 通过；单元/安全 **23/23**；
E2E 13 个套件共 **95 条断言全绿**；隔离冒烟 `out/` 11/11、打包版 11/11；安装器 SHA-256 与
`check-installer.ps1` 正/反例都验过。产物清单见 [docs/RELEASE-1.0.11.md](docs/RELEASE-1.0.11.md)。

**新增测试脚本**：`tools/smoke-test.mjs`（隔离 userData 冒烟，支持 `BWU_TEST_EXE` 指打包产物）、
`tools/lib/settings-window.mjs`（E2E 共用的"气泡 → 设置窗"入口）。

---

## 1.21 v1.0.12（本次）：把三个"边界问题"补掉

| 改动 | 位置 | 说明 |
|---|---|---|
| **SSE 尾帧**（REVIEW C8） | `services/sse.ts`（新）、`llm.ts`、`tts.ts` | 统一行切分：LF / CRLF / 单独 CR、跨块被切开的 `\r`、多字节字符跨块，**并且流结束时把没有换行符的最后一条事件也吐出来**。原来最后一段回答/音频会被丢 |
| **录音启动取消**（REVIEW C1） | `renderer/ball/recorder.ts`、`Ball.tsx` | `Recorder` 加 generation：每个 `await` 之后校验是否已被 stop/新一次 start 取代；被取消时释放已拿到的流与 `AudioContext`，抛 `RecorderCancelled`（不再当"麦克风打不开"上报）。失败的启动不会再把 `active` 卡成 true |
| **文件 I/O 限流**（REVIEW A8） | `agent/tools/files.ts` | `file.read` 只读前缀：按字节上限 + 8s 预算，大文件不再整读进内存；`file.list` 用目录迭代器分页（`offset`/`limit`，默认 200、上限 500）并报告"还有更多"；拒绝非普通文件 |
| **测试加固** | `tools/*` | 真鼠标类测试改按主进程的真实窗口可见性断言（`agentTest.bubbleVisible`），拖动方向随屏幕边缘变化（避免被钳制），负坐标改用命名参数传给 `input-helper.ps1` |

验证：typecheck 双端通过；单元/安全 **34/34**（新增 `sse-parse` 5、`file-io` 6）；
E2E **15 个套件 / 106 条断言全绿**（新增 `sse-tail` 3、`recorder-cancel` 8）；隔离冒烟 `out/` 11/11。

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

内置工具 **22 个**（19 + `skill.read` + `web.search` + `screen.capture`），MCP 工具运行时动态追加。

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

# —— 单元 / 安全（node:test，不需要 Electron；12 个文件 34 条）——
& $node --test tools\agent-tool-budget.test.mjs tools\approval.test.mjs tools\asr-generation.test.mjs `
  tools\asr-model-manifest.test.mjs tools\data-dir-migration.test.mjs tools\file-boundary.test.mjs `
  tools\file-io.test.mjs tools\mcp-secrets.test.mjs tools\retry-policy.test.mjs tools\sse-parse.test.mjs `
  tools\vision-grab.test.mjs tools\player-test.mjs

# —— E2E（每个都要先 Stop-Process electron）——
& $node tools\agent-run-test.mjs      # Agent 主循环         10/10
& $node tools\agent-ext-test.mjs      # 自定义工具 + Skill   10/10
& $node tools\agent-llm-test.mjs      # 工具名合法性/错误可见 3/3
& $node tools\agent-settings-test.mjs # 设置页               8/8
& $node tools\agent-ui-test.mjs       # 气泡/徽标/布局       19/19
& $node tools\prompts-test.mjs        # 提示词页 + 实际生效   4/4
& $node tools\thinking-test.mjs       # 思考参数/展示/降级    6/6
& $node tools\sse-tail-test.mjs       # SSE 尾帧（无尾换行）   3/3
& $node tools\search-test.mjs         # 联网搜索两条通路      4/4
& $node tools\shell-encoding-test.mjs # Shell 中文输出        3/3
& $node tools\mcp-zip-test.mjs        # zip 导入 + MCP        6/6
& $node tools\menu-test.mjs           # 右键菜单              6/6
& $node tools\app-test.mjs            # 界面回归              16/16
& $node tools\recorder-cancel-test.mjs # 录音启动取消/失败清理  8/8
& $node tools\local-asr-test.mjs      # 本机 ASR 真实识别（需要已装模型）
& $node tools\agent-input-test.mjs    # 键鼠注入（依赖真实前台，可能不稳）
```

- 每个测试之间先 `Stop-Process electron`，否则单实例锁会让新实例直接退出。
- mock LLM：`BWU_AGENT_MOCK` 指向 JSON，场景按用户文本包含的关键字匹配；**JSON 必须是 UTF-8 无 BOM**，
  场景 key 用英文（中文会被 `Set-Content -Encoding ascii` 之类的写法毁掉）。
- **mock 里的工具名必须用下划线写法**（`file_write`、`shell_ps`），模型收到的就是 wire 名；
  写成 `file.write` 会被 runner 当未知工具拒绝（1.0.11 起）。
- `BWU_AGENT_TEST=1` 且**非打包**时才注册测试通道（`agentTest.*`、`mcpTools`）。
  打包版故意没有这条通道，所以 `BWU_TEST_EXE` 只能配 `tools/smoke-test.mjs`
  （`BWU_TEST_EXE=release\win-unpacked\BeWithU.exe node tools\smoke-test.mjs`）；
  旧的"打包版跑 agent-llm-test"已不成立。
- 隔离冒烟：`node tools\smoke-test.mjs`（全新 userData，检查启动、四个窗口、角色隔离、无异常日志）。
- **真鼠标类测试（menu / app）的已知前提**：桌面若被全屏游戏等前台窗口霸占，真实鼠标到不了球窗。
  脚本会退回应用内等价入口（球窗 IPC / 气泡页 CDP 输入）并打印"真实鼠标投递被挡住"的提示；
  要算完整覆盖，得在没有前台全屏窗口的桌面上复跑。

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
2. 后台跑打包（必须 background job，前台会超时留半成品），**输出先给独立 staging**：
   `--config.directories.output=D:\coding\bwu-staging-<版本>`，不要直接覆盖 `release\`
3. 校验 staging：`win-unpacked\resources\app.asar` 时间戳是新的、
   `app.asar.unpacked\node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node`（1,060,352 bytes）、
   `uiohook-napi\prebuilds\win32-x64\uiohook-napi.node`、`sherpa-onnx-win-x64\*.dll|*.node` 都在、
   asar 里 `package.json` 是目标版本、两个 exe 时间戳是新的
4. 隔离启动冒烟：`BWU_TEST_EXE=<staging>\win-unpacked\BeWithU.exe node tools\smoke-test.mjs`
5. 算 SHA-256，写发布清单（见 [docs/RELEASE-1.0.11.md](docs/RELEASE-1.0.11.md) 的格式），
   再用 `scripts/check-installer.ps1 -ExpectedSha256 <值>` 正/反例各验一次
6. 全部通过后才把产物放进 `release\`，旧版本产物移进 `release\archive-<旧版本>\`
7. `git add -A && git commit && git push`

产物命名由 `artifactName: ${productName}-${version}-${arch}` 自动生成；便携版单独一条 `portable.artifactName`。

**已知打包环境坑**：本机 PATH 里没有 `pnpm`，electron-builder 的 `pnpm list` 会失败并回退到手工遍历
`node_modules`（日志里是一条 `node module collection failed`，不影响产物，1.0.10 也是这样）。
打包用的 TEMP 要设到仓库内可写目录（`scripts/package.cmd` 里已设 `.cache\tmp`）。

**SmartScreen**：没有代码签名，下载后首次运行会提示"Windows 已保护你的电脑"。现在**不再建议**"解除锁定"绕过
（安装脚本也不再替用户去标记），正确做法是从可信渠道拿到该版本的 SHA-256 后，用
`scripts/check-installer.ps1` 校验再运行；要彻底消除得买代码签名证书
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
| **快捷键降级**（REVIEW C7） | 驱动不可用时提示"已降级"，但降级只模拟 60ms 按键，按住说话基本不可用；默认 Mouse4 也不在这条路上 |
| **审计内容**（REVIEW B4） | 审计 JSONL 仍记录参数与结果片段（可能含文件内容）；历史/记忆明文落盘。建议默认只记元数据 |
| **ASR 归档整包** | 官方 163 MB 归档在本机下载太慢（约 5–15 KB/s），续传一个多小时仍不到 1/4；归档 SHA 来自官方 checksum，两个文件的 hash/size 已与本机模型核对一致。续传脚本：`powershell -NoProfile -ExecutionPolicy Bypass -File D:\coding\bwu-asr-dl\fetch-asr.ps1`（下完自动比对 SHA-256） |

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
10. **真鼠标 E2E 怕前台全屏窗口**：桌面被游戏等全屏窗口盖住时，`SendInput`/`mouse_event` 到不了悬浮球
    （`WindowFromPoint` 会返回那个全屏窗口）。要么先让开桌面，要么接受脚本打印的"退回应用内入口"提示。
11. **本机工作区权限**：`D:\coding\BeWithU` 曾缺少当前用户对写权限（`WRITE_OWNER`），
    导致 DSH 沙箱无法给工作区授权、命令直接跑不起来；用 DSH 的
    `diagnose-windows-sandbox-acl.ps1 -Path <workspace> -AllowRoot <workspace> -Out <回滚目录>` 修好，
    回滚脚本在 `D:\coding\bwu-acl-recovery\`。以后新建/搬运目录注意别沿用别的用户的 ACL。


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

## 10. 当前状态：1.0.12 已提交、已打包、已验证

### 已完成

- **1.0.11（commit `23f55b6`）**：审批撤销、MCP 撤权、文件落点校验、窗口角色收敛、截图隐私、数据迁移校验、ASR 固定归档、结构化错误重试、安装脚本收紧（详见 §1.20 与 [REVIEW.md](REVIEW.md) 的对应条目）。
- **1.0.12（commit `b343897`）**：SSE 尾帧（C8）、录音启动取消与失败清理（C1）、文件 I/O 限流与目录分页（A8），见 §1.21。

### 已验证（本轮实跑，可复现）

- 运行环境：Node.js **v24.21.0**、Electron **45.3.3**、electron-builder **26.18.0**；`pnpm-lock.yaml` 未改。
- TypeScript 双端检查通过；`electron-vite build` 通过（输出 `out/`）；`git diff --check` 通过。
- 单元/安全 **34/34**（12 个 `node --test` 文件：审批、迁移、文件边界、文件 I/O 分页、SSE 解析、抓屏、MCP 密钥、ASR manifest/generation、工具预算、重试策略、播放器）。
- E2E **15 个套件 / 106 条断言全绿**：agent-run 10、ext 10、mcp-zip 6、agent-llm 3、agent-settings 8、agent-ui 19、prompts 4、thinking 6、sse-tail 3、search 4、shell-encoding 3、menu 6、app 16、recorder-cancel 8；local-asr 用本机真实模型完成识别（RTF≈0.035）。
- 隔离冒烟 `tools/smoke-test.mjs`：`out/` 11/11、`release/win-unpacked/BeWithU.exe` 11/11；包含"球窗没有管理接口、打包版没有测试 IPC"的角色隔离断言。
- **打包验收**：先输出到 `D:\coding\bwu-staging-1.0.12`，校验 `app.asar`（10,118,743 bytes，版本 1.0.12）、
  `@koromix/koffi-win32-x64/win32_x64/koffi.node`、`uiohook-napi`、`sherpa-onnx-win-x64` 均在 unpacked 里，
  asar 内 `out/main/index.js` 带 ASR 归档 SHA 常量与 `--bwu-role=`；`koffi 3.3.8` 在 Electron 45.3.3/Node 24.22.3(ABI 150)
  下可加载，应用日志出现 `input: 工作进程已启动`；安装器 129,021,885 bytes / `00a0241a…ec5a`，
  便携版 116,745,110 bytes / `c883a5e5…ce6f`，`check-installer.ps1` 正/反例/缺摘要三种情况都验过。
  完整记录见 [docs/RELEASE-1.0.12.md](docs/RELEASE-1.0.12.md)。
- **产物已就位**：`release/` 是 1.0.12；1.0.10 / 1.0.11 分别在 `release/archive-1.0.10/`、`release/archive-1.0.11/`；
  `release/SHA256SUMS-1.0.12.txt`。

### 仍未完成（不是本轮能闭的）

- **ASR 官方归档整包**：`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`
  （163,002,883 bytes，SHA-256 `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`）
  在本机只有约 5–15 KB/s，续传一个多小时仍不到 1/4（半成品在 `D:\coding\bwu-asr-dl\archive.tar.bz2`，
  **不要当模型用**）。归档 SHA 来自官方 `checksum.txt`（该清单的 asset digest 是 `sha256:a96a8ecf…1f1a`，
  上传者 `github-actions[bot]`）；归档里两个文件的 hash/size 已用**本机已装模型**逐字节核对一致。
  要彻底闭环：找个带宽好的网络把归档下完，比对 SHA-256，再跑一次"下载 → 解包 → 发布"全流程
  （`tools/asr-model-manifest.test.mjs` 只校验固定值）。
- **代码签名**：没有证书，安装器未签名。
- **真机矩阵**：真实多屏/WGC、ASR 麦克风设备、`input.*` 前台依赖，都只在单机上验过。
- **外部发布**：没有上传安装器/做分发页；`git push` 在本机网络下会超时（本次两个提交都还是本地提交）。

### 源码搬运

- 现在可以直接 `git archive HEAD` 或 clone（工作区已提交、`git status` 干净），但要带上 `release/` 里的产物与清单
  （`release/` 被 gitignore，不在仓库里）、以及 [docs/RELEASE-1.0.12.md](docs/RELEASE-1.0.12.md)。
- 可排除 `node_modules/`、`.pnpm-store/`、`.cache/`、`out/`、`release/archive-*`、`.shots/` 和本地日志/录音样本；
  不要打入真实应用数据目录（`%APPDATA%\BeWithU`）、API Key 或凭据。
