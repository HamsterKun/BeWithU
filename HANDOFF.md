# BeWithU 交接文档（2026-11-20，1.1.0 已打包待发布）

> 接手先读 §0 和 §10。当前状态：**1.1.0 已开发完、已打包、回归全绿，卡在发 GitHub Release**（缺 `GH_TOKEN`）。
>
> 这一天的顺序，方便追溯：
> 1. **C2 / A6 修复**（REVIEW 最后两条）+ 修好长期跑不起来的 `tools/agent-input-test.mjs` → §1.23
> 2. **上下文管理**（取代「对话记忆」：三挡预算、水位压缩、时间感知、缓存友好）→ §1.24
> 3. **数据与日志页**（用量统计从关于搬出）+ 关于页点星卡 → §1.25
> 4. **自动更新**（electron-updater）+ 版本定为 **1.1.0** → §1.26
>
> `release/` 里现在是 **1.1.0** 的安装器与便携包；1.0.13 及更早的产物已归档到 `release/archive-1.0.x/`。

---

## 0. 30 秒速览

| 项 | 值 |
|---|---|
| 代码位置 | `C:\Users\jiangchengrui\Desktop\BeWithU`（原 `D:\coding\BeWithU`；D 盘已不存在，见 §11） |
| 版本 | **1.1.0**（自动更新 + 上下文管理）。含 C2/A6 修复。安装包已出，**Release 未发布**，见 §1.26 |
| HEAD | 1.0.13 打包版提交在 `006c229`；C2/A6、上下文管理、数据与日志、自动更新都在 1.1.0 的提交里 |
| 产物 | `release/` = **1.1.0** 安装器 + 便携包 + `.blockmap` + `latest.yml`（校验见 `SHA256SUMS-1.1.0.txt`、`docs/RELEASE-1.1.0.md`）；旧版在 `release/archive-1.0.10…1.0.13/` |
| 工作区 | 1.1.0 提交完成后应为干净；`out/`、`release/`、`.shots/` 都被 gitignore |
| 搬家 | **先看 §11**：哪些目录必带/可以删、一键压缩命令、新机器恢复与自检步骤 |

**白天那版**：Agent 能力层 M1（键鼠注入）+ M2（工具循环/审批/审计）+ 设置页，19 个内置工具。
**今晚这版**：把 Agent 能力补完整（自定义工具、Skill、MCP、联网搜索），修掉一批把功能打到不可用的 bug，
补了亮/暗主题、用量统计、模型列表，并出了 **1.0.x 正式版**。

**一句话现状**：能聊天、能看屏（需视觉模型）、能干活（22 个内置工具 + MCP）、能联网、有主题、有用量统计；
1.0.11 把评审里的权限、隐私、迁移、供应链问题补完，产物已打包并通过完整回归。
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

验证：typecheck 双端通过；单元/安全 **37/37**（新增 `sse-parse` 5、`file-io` 6、`asr-download` 3）；
E2E **15 个套件 / 106 条断言全绿**（新增 `sse-tail` 3、`recorder-cancel` 8）；隔离冒烟 `out/` 11/11。

---

## 1.22 v1.0.13（本次）：快捷键降级 + 落盘隐私

| 改动 | 位置 | 说明 |
|---|---|---|
| **降级即切换模式**（REVIEW C7） | `input/voice-mode.ts`（新）、`input/hotkey.ts`、`services/pipeline.ts` | 降级监听（globalShortcut）拿不到按下/抬起时序，`effectiveVoiceMode()` 在降级时强制 `toggle`；`hotkeyStatus()` 区分"鼠标键监听不了/注册失败/已降级"三种文案；设置页显示提示，并在降级时隐藏"最短按住时长"。默认 Mouse4 在降级路径注册不了，会明确提示改键盘组合 |
| **审计默认只记元数据**（REVIEW B4） | `agent/audit.ts`、`agent/index.ts` | 默认只写工具 id、成败、耗时、参数名与字节数；新增设置 `agent.auditDetail`（默认关），打开后才写结果摘要与参数片段，写入前对 `key/token/secret/password/authorization/cookie` 类字段和 `Bearer …` 打码。运行记录页显示"仅元数据 · 参数名 · 耗时" |
| **历史与记忆加密落盘**（REVIEW B4） | `store/secure-json.ts`（新）、`store/history.ts`、`store/memory.ts` | 优先用系统加密（DPAPI/safeStorage），文件为一行 `BWU1:` + 密文；旧明文文件照常读取、下次保存自动升级；加密不可用时退回明文并记日志，设置 → 关于显示"本机加密：可用/不可用" |
| **测试** | `tools/*` | 新增 `voice-mode`、`audit`、`secure-json` 单测与 `hotkey-fallback`、`privacy-at-rest` 端到端 |

验证：typecheck 双端通过；单元/安全 **49/49**（16 个文件，新增 `voice-mode` 1、`audit` 4、`secure-json` 7）；
E2E **17 个套件 / 115 条断言全绿**（新增 `hotkey-fallback` 4、`privacy-at-rest` 5）；隔离冒烟见下。

> `hotkey-fallback` 用 `BWU_HOTKEY_FALLBACK=1`（仅 `BWU_AGENT_TEST=1` 时生效）强制走降级路径，
> 断言"第一次按开始录音、第二次按结束录音"；本机没有本地识别模型时该行为项会打印 SKIP。
> `privacy-at-rest` 直接检查落盘文件：`history.json` 以 `BWU1:` 开头且搜不到聊天原文；审计默认无 summary/argsPreview，开详细后有。

---

## 1.23 REVIEW C2 + A6（2026-11-20 下午，**未打包**）

| 改动 | 位置 | 说明 |
|---|---|---|
| **滚动也过输入守卫**（C2） | `src/main/input-worker.ts` | `scroll` 处理器直接 `send(...)`，绕过了 `assertSafe()`（锁屏检测 + 登录/支付页标题拦截），而 click / move / type / drag 四个都过了守卫。补上后，Agent 发起的滚轮不再能在密码/支付类窗口上改变前台状态 |
| **归档导入加资源上限 + 失败清理**（A6） | `agent/import-archive.ts` | ① 解压**前**看清单：条目数 ≤ 2000、只允许普通文件/目录（拒绝 `l`/`h`/`c`/`b`/`p`/`s`）、拒绝含 `../` 的越级路径；② 用 `tar -xO` 把内容流到 stdout **边读边计数**（≤ 64MB，超限立即杀进程，**完全不落盘**）；③ 解压后按真实文件系统复核：无 symlink/junction、单文件 ≤ 32MB、层级 ≤ 8；④ 任一步失败都递归删除临时目录（原来异常路径会留下半包） |
| **固定用系统 tar** | 同上 | 不再从 PATH 找 `tar`：PATH 上的同名程序可被安装包或当前目录劫持，而这里正是处理不可信输入的入口。改用 `%SystemRoot%\System32\tar.exe`，非 Windows 才退回 PATH |
| **修好 `agent-input-test.mjs`** | `tools/agent-input-test.mjs` | 该套件自 1.0.11 做完窗口角色隔离后就一直跑不起来（它调用球窗口上已不存在的 `settings.update`）。改为借气泡打开设置窗口写占位 Key；气泡被设置窗口挤到隐藏（Windows 最小化坐标 ≈ -32000）时重开再量坐标；`eval` 失败补上真实异常描述 |
| **新增单测** | `tools/archive-limits.test.mjs` | 8 条：正常解包/下钻/cleanup、条目数、总体积、单文件、层级、符号链接、越级路径、默认上限合理性。恶意归档用手写 ustar 头构造，不依赖 python |

> 为什么不解析 `tar -tvf` 里的尺寸字段：清单的日期列会跟随系统 locale（本机是 `11月 20 11:59`），
> 列位置不稳定；而 `tar -tf` 还会把 `../` 前缀 strip 掉，不能用来判断越级。
> 所以「体积」改用流式真实计量，「越级/类型」用 `-tvf` 的**整行**特征判断，都不依赖列位置。

验证：typecheck 双端通过；单测 **54/54**（16 个文件，新增 `archive-limits` 8 条）；
`agent-input-test` **11/11**（新增 `scrollGateOnBlockedTitle`：把气泡窗口标题改成「登录确认」后
`input.scroll` 必须返回失败——改前实测是 `ok:true`，改后是 `ok:false` 并给出拦截原因）；
`smoke-test` 11/11、`agent-run-test` 10/10、`mcp-zip-test` 6/6（确认真实 zip 导入没被上限误伤）。
**没有打包**，`release/` 未改动。

---

## 1.24 v1.0.14（本次）：对话记忆 → 上下文管理

把「攒满 N 轮压成 300 字摘要」换成**按 token 预算管理上下文**。详细设计见
[docs/PLAN-CONTEXT.md](docs/PLAN-CONTEXT.md)，这里只记结论和坑。

| 改动 | 位置 | 说明 |
|---|---|---|
| **预算制替代轮数制** | `services/context.ts`（新）、`shared/model-window.ts`（新） | `llm.historyTurns` 退役。可用上限 = 模型窗口 − 输出预留 `min(8192, 15%)` − 4k 估算缓冲；三挡 = 可用上限的 1/3、2/3、全部 |
| **水位 + 滞回替代滑动窗口** | `services/pipeline.ts` | 涨到预算 85% 才压，一次压到 45% 以下。**这是缓存命中率的关键**：原来的 `recent(N)` 每轮移出最老一条，前缀从第 2 条就变，缓存基本只剩 system 段 |
| **压缩用主模型** | `services/summarizer.ts` | 删掉 `llm.summary.*`（Base URL / Key / 模型）与对应 secret；温度 0.2、60s 超时、可被 AbortSignal 打断 |
| **压缩不删本地记录** | `store/context.ts`（新）、`store/history.ts` | 改推 `archivedUpTo` 游标，`historyStore.since(n)` 取未归档段。原来 `drop()` 直接销毁，压缩不可回退 |
| **摘要按档位放宽** | `shared/defaults.ts` | 1800 / 3000 / 4500 字（旧的写死 1200 字 + "300 字以内"）。提示词改成「叙事 + 【关键事实】清单」，强制保留数字、路径、命令、结论、待办、时间锚点 |
| **时间感知** | `services/context.ts` | `off / current / full` 三档，默认 `current`。**历史消息的时间在写入时冻结**（绝对时间，手写 `MM-DD HH:mm`，不能用 `toLocaleString`，否则换 locale 就变字节、前缀立刻失效）；只有本轮消息带「现在 + 距上一条多久」 |
| **聊天 / Agent 共用组装器** | `agent/runner.ts` | Agent 以前是 `recent(6)` 且**完全没注入摘要**；现在和闲聊同一套 `assembleMessages`。顺带修了 Agent 模式从不把用户问句写进历史的老 bug |
| **缓存命中可观测** | `services/llm.ts`、`store/...` | `streamChat` 新增 `onUsage`，读 `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens`；设置页显示最近一次命中率 |
| **设置页** | `panes/ContextPane.tsx`（新）、`Settings.tsx` | 新增「上下文」tab；删掉「记忆轮数」字段与「对话记忆」整段。**不给**总开关、**不给**摘要字数上限（跟档位走）、**不给**摘要正文查看（可能几万字） |

**迁移**：`historyTurns === 0` 也一律开启上下文（新设计不提供关闭）；`llm.summary.*` 丢弃；
`memory.json` 存在时读一次，之后落到 `context.json`；`data-dir.ts` 的搬家清单已加 `context.json`。

**踩过的两个坑**：
1. **时间格式不能用 `toLocaleString()`**：它受系统语言影响（本机是 `2026/11/20 12:32:23`），
   一旦写进历史消息，换机器/换语言就变字节，前缀缓存立刻失效。统一手写 `MM-DD HH:mm`。
2. **设置页刷新会拿到旧预算**：`patch()` 有 420ms 防抖，改档位后立刻调 `contextInfo()` 读到的还是旧档位。
   两个修法都要：离散开关用 `patch(..., true)` 立即落盘，刷新再延后 300ms（见 `ContextPane` 的 effect）。

**验证**：typecheck 双端通过；单测 **77/77**（新增 `context-budget` 10、`context-plan` 8、`context-migrate` 5）；
E2E：`context-ui` **10/10**（三挡切换后预算数字真的变、立即压缩给的是人话、没有查看按钮）、
`context-compact` **6/6**（本地假 SSE 服务端：压缩真的触发，3274 → 872 tokens，游标推进 8 条，
摘要确实出现在下一轮请求里，current 模式下历史无时间戳）、`smoke` 11/11、`agent-run` 10/10、
`mcp-zip` 6/6、`agent-settings` 8/8、`app` 16/16、`agent-input` 11/11。
**未打包**，`release/` 未改动。

---

## 1.25 v1.0.14 补丁：数据与日志页 + 关于页点星卡（只提交，未打包）

| 改动 | 位置 | 说明 |
|---|---|---|
| **新增「数据与日志」页** | `panes/DataPane.tsx`（新）、`Settings.tsx` | 放在「快捷键」和「关于」之间。三块：用量统计（从关于页搬来）、运行日志、数据目录（也从关于页搬来——页名叫"数据"，目录留在这里更顺） |
| **运行日志查看器** | `services/log-tail.ts`（新）、`ipc.ts`、`preload` | 只读文件**最后 512KB**（A8 的教训，不整包读），从中间截断时丢掉半行；支持关键字搜索（不区分大小写）、「只看问题」、最近 50–2000 行、3 秒自动刷新（页面不可见时跳过） |
| **级别是推断的** | 同上 | 日志格式本身没有级别字段。只在出现 `失败/错误/异常/error/fail/ECONN` 时标红，`超时/重试/降级/warn` 标黄。**不是权威分级**，只是把问题捞出来 |
| **关于页加项目卡** | `panes/AboutPane.tsx` | 「喜欢的话给我们一颗星星吧」+「去 GitHub 点星」按钮 |
| **外链只走固定地址** | `ipc.ts` 的 `appOpenRepo` | 渲染进程传不了 URL，主进程用 `APP_REPO_URL` 常量并校验 `https + github.com`，避免这条通道变成任意协议的外链入口 |
| **用量统计口径文案** | `DataPane.tsx` | 「记忆总结模型」改成「上下文压缩」，与 1.0.14 的措辞对齐 |

**验证**：typecheck 双端通过；单测新增 `log-tail` 6 条（尾部截断不返回半行、关键字、级别推断、只看问题）；
E2E `data-pane-test` **10/10**（三个区块都在、日志渲染出本地时间、关键字过滤到 0 行再恢复、
塞一条 401 日志后能标红且「只看问题」只剩它、关于页有项目卡且用量已搬走）；
`smoke` 11/11、`context-ui` 10/10。**未打包**。

---

## 1.26 v1.1.0：自动更新（electron-updater）

| 改动 | 位置 | 说明 |
|---|---|---|
| **接 electron-updater** | `services/update.ts`（新）、`package.json` | `autoDownload=false`（点了才下）、`autoInstallOnAppQuit=true`（点「稍后」直接退出也能装）、禁预发布、禁降级 |
| **状态机** | 同上 | `idle / checking / available / downloading / ready / error`，每次变化广播给所有窗口 |
| **安装版** | 同上 | 检查 → 后台**差分**下载（走 `.blockmap`）→ `quitAndInstall(false, true)` |
| **便携版** | 同上 | 没有原位可换，只用 GitHub Releases API 比 `tag_name`，点了 `shell.openExternal` 去 release 页；`download()` 被显式挡住 |
| **侧栏横幅** | `settings/UpdateBanner.tsx`（新）、`Settings.tsx` | 绿色，放在侧栏底部（暗色模式上方）。文案随状态变：`新版本 x · 点击更新` → `正在下载 42%`（带进度条）→ `立即重启完成更新` |
| **版本比较** | `shared/version.ts`（新） | 自己写的 semver 比较，不引依赖；`1.0.10 > 1.0.9`、`-beta` 小于正式版 |
| **发布源** | `electron-builder.yml` | `publish: github / HamsterKun / BeWithU`，打包时带 `GH_TOKEN` 会自动生成 `app-update.yml` 并上传 `latest.yml` + 安装包 + blockmap |

**关键认知**：更新检测读的是**已发布的 Release**（`latest.yml` 里的 `version` 字段），
不是仓库代码、也不是 branch。只打 tag 不发 release、发成 draft、或标成 prerelease，客户端都看不到。

**开发/测试怎么跑（不用真发版）**：给 `BWU_UPDATE_CONFIG` 指一个 `dev-app-update.yml`
（`provider: generic` + 本地 http 目录），`BWU_UPDATE_API` 顶掉便携版用的 GitHub API 地址，
`BWU_UPDATE_DELAY` 改启动检查延迟（默认 10s，测试里用 1.2s）。

**验证**：typecheck 双端通过；单测 **89/89**（新增 `version` 6 条）；
E2E `update-test` **6/6**（本地 generic feed：横幅出现 → 点击 → 看到下载进度 → 变「立即重启」→ 状态 ready 9.9.9）、
`update-portable-test` **5/5**（模拟 `PORTABLE_EXECUTABLE_DIR`：文案是「点此下载 / 便携版需手动替换」，
`download()` 被挡住，API 确实被打到）；
回归 `smoke` 11/11、`context-ui` 10/10、`data-pane` 10/10、`agent-run` 10/10。

**1.1.0 打补丁（同日，仍在 1.1.0 内，未发布）**：
- 更新横幅去掉第二行小字，单行显示（`新版本 x · 点击更新` / `正在下载 42%` / `立即重启完成更新`）；
  便携版文案改成 `便携版点此下载`（原来那句"需手动替换"在副标题里）。
- 新增**开机自启动**（`ui.autoLaunch`，默认 **开**）：`services/auto-launch.ts` 用
  `app.setLoginItemSettings` 对齐注册表，幂等（值没变不写）。**只在安装版生效** —— 便携版的
  `process.execPath` 指向临时解压目录，注册进去是死链，所以直接跳过并在关于页显示「不可用」。
  实测：打包版首次启动写入了 `HKCU\...\Run\com.bewithu.app`，把设置改成 false 再启动会被移除。
- 开关位置：设置 → 关于 → 开机自启动（`AppInfo.portable` 决定是否可用）。

**1.1.0 第二组修补（同日，仍在 1.1.0 内，未发布）**：
- 「系统提示词」全面改名 **「人格提示词」**（侧栏 tab、页头、分区标题三处）。
- 日志查看器：**默认贴底**（用户手动往上翻就不再抢滚动位置）、滚动条改成正常观感、
  「复制当前内容 / 打开日志目录」缩短成「复制 / 打开目录」并给 `.btn` 加 `nowrap`（之前会被挤成两行）。
- 「更改目录…」原本是 `variant="primary"`（青紫渐变），在数据目录那块显得突兀，已改回普通按钮。
- 上下文窗口**优先用供应商上报值**：新增 `services/model-info.ts` + `shared/model-window.ts` 的
  `pickProviderWindow()`，从 `/v1/models` 里认 `context_length / context_window / max_context_length /
  max_input_tokens / context`（含 `meta`/`limits` 嵌套）。优先级 手动 > 供应商 > 内置表 > 128k 兜底。
  换模型/换地址/换 Key 时强制刷新，启动后 3s 拉一次；**没填 Key 且非本地服务时直接跳过**（否则日志里刷 401）。
  内置表里 deepseek 也从 64k 改成 128k（原来的值太旧，会把高档压得很小）。
- 占用条在占用极低时保留 2% 的可见填充，否则整条看着像坏的。

**1.1.0 第三组修补（同日，未发布）**：
- 模型元信息**只在启动后拉一次**（不轮询）；换模型/地址/Key 时再拉一次。去掉了原来的 10 分钟 TTL，
  改成「同一 baseUrl+模型拉过就不再打」，代码里不再有定时器语义。
- token 显示修成 `1M`（之前 1 000 000 会写成 `1000k`）：抽了 `shared/format.ts` 的 `formatTokens`，
  十万以下保留一位小数（77.1k），百万级用 M。

**发布步骤（没有令牌做不了）**：设置环境变量 `GH_TOKEN`（需 repo 权限），
然后跑 `node node_modules\electron-builder\cli.js --win --x64 --publish always`；
或者用 `gh release create v1.1.0` 手动把 `release/` 里的 exe、blockmap、latest.yml 传上去。
**发版顺序必须跟版本号顺序一致**：`/releases/latest` 是按发布时间取的，倒着发会让客户端以为"没有更新"。

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

**1.0.11–1.0.13 新增/拆出的模块**（上面的树是早期版本，这里补齐）：

```
src/main/agent/tool-budget.ts        单次响应内多工具按剩余步数截断
src/main/agent/audit.ts              审计：默认只记元数据；auditDetail 才写摘要/参数并脱敏
src/main/services/sse.ts             统一 SSE 行切分（含流结束尾帧）
src/main/services/asr-model-manifest.ts  官方 ASR 归档与两个文件的 size/sha256 固定值
src/main/services/asr-generation.ts  录音会话代次（防跨轮回写）
src/main/services/http-error.ts      结构化 HTTP 错误（状态码不再靠猜文案）
src/main/services/retry-policy.ts    视觉回退 / Breeze 429 的重试判定
src/main/store/secure-json.ts        历史/记忆的 BWU1: 加密落盘（safeStorage）
src/main/input/voice-mode.ts         按键监听降级时强制切换模式
tools/lib/settings-window.mjs        E2E 共用：点球 → 气泡 → 设置窗（管理接口只在该窗口）
tools/smoke-test.mjs                 隔离 userData 冒烟（支持 BWU_TEST_EXE 指打包产物）
```

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

## 5. 测试

**统一入口是 `tools/run.mjs`**，不用再手抄文件名，也不用自己杀 Electron：

```bash
node tools/run.mjs unit    # 单元/安全（node:test，不启动 Electron）
node tools/run.mjs e2e     # 端到端：逐个跑，前后自动 taskkill
node tools/run.mjs all     # 全量
node tools/run.mjs list    # 清单：22 个单元文件 / 24 个 E2E 套件 / 手工脚本

node tools/run.mjs e2e --only=context,update   # 按名字过滤，改完哪块跑哪块
node tools/run.mjs e2e --timeout=600           # 放宽单个套件的超时（默认 300s）
```

`e2e` 会从每个套件的输出里读「通过 N/M」，跟内置的期望条数比对 —— **少跑几条也算失败**，
不会再出现「看着全绿其实有断言被跳过」。

前置的类型检查与构建不在 runner 里（它们不是测试）：

```bash
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.node.json
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.web.json
node node_modules/electron-vite/bin/electron-vite.js build
```

> 这台机器没有系统级 Node，用 `$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；
> `run.mjs` 内部已经清掉 `ELECTRON_RUN_AS_NODE`，直接调单个脚本时才需要自己清。
> ASR 归档那条单独跑：`node --test tools/asr-download-test.mjs`（没有归档会 SKIP）。

- `run.mjs e2e` 会自动在套件之间杀 Electron；**手动单独跑某个脚本时**要先 `Stop-Process electron`，否则单实例锁会让新实例直接退出。
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
| 审批 / 审计 | `agent/approval.ts` / `agent/audit.ts`（默认元数据，`agent.auditDetail` 开详细） |
| 历史 / 记忆落盘 | `store/history.ts`、`store/memory.ts` + `store/secure-json.ts`（`BWU1:` 加密） |
| SSE 解析（回答/音频尾帧） | `services/sse.ts` → 被 `llm.ts` 与 `tts.ts` 使用 |
| 快捷键 / 降级行为 | `input/hotkey.ts` + `input/voice-mode.ts` + `pipeline.onHotkey` |
| 本地语音模型下载/校验 | `services/asr-model.ts` + `asr-model-manifest.ts` + `tools/asr-download-test.mjs` |
| 发版清单 / 校验 | `docs/RELEASE-<版本>.md` + `release/SHA256SUMS-<版本>.txt` + `scripts/check-installer.ps1` |

---

## 10. 当前状态：1.0.13 已提交、已打包、已验证

### 已完成

- **1.0.11（commit `23f55b6`）**：审批撤销、MCP 撤权、文件落点校验、窗口角色收敛、截图隐私、数据迁移校验、ASR 固定归档、结构化错误重试、安装脚本收紧（详见 §1.20 与 [REVIEW.md](REVIEW.md) 的对应条目）。
- **1.0.12（commit `b343897`）**：SSE 尾帧（C8）、录音启动取消与失败清理（C1）、文件 I/O 限流与目录分页（A8），见 §1.21。
- **1.0.13（commit `0b7fea6`）**：快捷键降级 = 切换模式（C7）、审计默认只记元数据 + 可选详细（B4）、历史/记忆加密落盘（B4），见 §1.22。
- **未打包（工作区）**：C2（滚动绕过输入守卫）、A6（归档导入无资源上限/失败不清理），见 §1.23。
  至此 REVIEW 里需要改代码的条目**才**全部处理完（此前 1.0.13 那句"全部处理完"是过头话，C2/A6 当时还开着）。

### 已验证（本轮实跑，可复现）

- 运行环境：Node.js **v24.21.0**、Electron **45.3.3**、electron-builder **26.18.0**；`pnpm-lock.yaml` 未改。
- TypeScript 双端检查通过；`electron-vite build` 通过（输出 `out/`）；`git diff --check` 通过。
- 单元/安全 **49/49**（16 个 `node --test` 文件：审批、迁移、文件边界、文件 I/O 分页、SSE 解析、ASR 下载/解包/发布、审计、安全 JSON、语音模式、抓屏、MCP 密钥、ASR manifest/generation、工具预算、重试策略、播放器）。
- E2E **17 个套件 / 115 条断言全绿**：agent-run 10、ext 10、mcp-zip 6、agent-llm 3、agent-settings 8、agent-ui 19、prompts 4、thinking 6、sse-tail 3、search 4、shell-encoding 3、menu 6、app 16、recorder-cancel 8、hotkey-fallback 4、privacy-at-rest 5；local-asr 用本机真实模型完成识别（RTF≈0.037）。
- 隔离冒烟 `tools/smoke-test.mjs`：`out/` 11/11、`release/win-unpacked/BeWithU.exe` 11/11；包含"球窗没有管理接口、打包版没有测试 IPC"的角色隔离断言。
- **打包验收**：先输出到 `D:\coding\bwu-staging-1.0.13`，校验 `app.asar`（10,126,107 bytes，版本 1.0.13）、
  `@koromix/koffi-win32-x64/win32_x64/koffi.node`、`uiohook-napi`、`sherpa-onnx-win-x64` 均在 unpacked 里，
  asar 内 `out/main/index.js` 带 ASR 归档 SHA 常量与 `--bwu-role=`；`koffi 3.3.8` 在 Electron 45.3.3/Node 24.22.3(ABI 150)
  下可加载，应用日志出现 `input: 工作进程已启动`；安装器 129,023,638 bytes / `a3f27713…0063`，
  便携版 116,745,124 bytes / `1a0af2c7…a1bb`，`check-installer.ps1` 正/反例/缺摘要三种情况都验过。
  完整记录见 [docs/RELEASE-1.0.13.md](docs/RELEASE-1.0.13.md)。
- **产物已就位**：`release/` 是 1.0.13；1.0.10 / 1.0.11 / 1.0.12 分别在 `release/archive-1.0.10/`、`archive-1.0.11/`、`archive-1.0.12/`；
  `release/SHA256SUMS-1.0.13.txt`。
- **ASR 官方归档整包（已闭环）**：`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`
  163,002,883 bytes / SHA-256 `7d1efa21…d347e`，已在 `D:\coding\bwu-asr-dl\archive.tar.bz2` 下完并比对通过
  （续传脚本 `fetch-asr.ps1` 自带校验）。tar 清单 12 项、根目录与 manifest 的 `root` 一致、无符号链接/越界路径；
  `model.int8.onnx` 239,233,841 / `c71f0ce0…cd51`、`tokens.txt` 315,894 / `f449eb28…a1dc` 解包后逐个核对通过，
  且与本单位已装模型逐字节一致。`tools/asr-download-test.mjs` 用本地服务把官方归档喂给真实的
  `downloadModel()`，验证"坏归档被拒（不落盘、临时目录清理）→ 好归档解包发布 → modelReady()"整条链路（3/3，约 13s）。

### 仍未完成（不是本轮能闭的）

- **代码签名**：没有证书，安装器未签名。
- **真机矩阵**：真实多屏/WGC、ASR 麦克风设备、`input.*` 前台依赖，都只在单机上验过。
- **外部发布**：没有上传安装器/做分发页（代码已 `git push` 到 origin/main）。

### 源码搬运

见 **§11 打包工作区 / 搬家清单**：目录体积、必带与可删、一键压缩命令、新机器恢复与自检步骤。

---

## 11. 打包工作区 / 搬家清单（2026-11-20 实测）

> 目标：把"能继续开发 + 能发版 + 能复现验证"的最小集合带走，不要把 4 GB 的缓存和旧安装包一起搬。

### 11.1 体积构成（本机实测，`Get-ChildItem -Recurse | Measure-Object Length -Sum`）

| 路径 | 体积 | 带不带 | 说明 |
|---|---:|---|---|
| git 跟踪的源码/文档/脚本（183 个文件） | ~2 MB | **必带** | 就是全部可维护内容 |
| `release/BeWithU-1.0.13-*.exe` + 清单/校验/latest.yml | ~247 MB | **必带** | 安装器 129 MB + 便携版 117 MB；发版/验收用 |
| `release/win-unpacked/` | 392 MB | 选带 | 打包版冒烟（`BWU_TEST_EXE`）用；不带也能从安装器/重新打包得到 |
| `release/archive-1.0.10|1.0.11|1.0.12/` | 各 ~626 MB | 不带 | 旧版本，需要时重新打包即可 |
| `node_modules/` | 553 MB | **不带** | pnpm 符号链接指向别的机器的 store，换机必坏（§8.6） |
| `.git/` | 1.17 GB | 选带 | 其中 `.git/lfs/` 932 MB 是**旧对象**：当前树没有任何 LFS 指针，构建不需要它 |
| `.cache/` | 15 MB | 不带 | electron-builder 缓存，重下即可 |
| `.pnpm-store/` | 32 MB | 不带 | 本机 pnpm store 的残留；新机器按 §11.3 重装 |
| `out/` | 1.5 MB | 不带 | `electron-vite build` 可重建 |
| `.shots/` | 43 MB | 不带 | 截图与测试临时 userData |

结论：**带源码 + `release/1.0.13` 两个 exe 与清单 ≈ 236 MB**；再带 `win-unpacked` ≈ 389 MB；全带 4.3 GB。

### 11.2 一键打包（推荐：轻量包，约 640 MB）

在任意 PowerShell 里执行（`tar.exe` 是 Windows 自带的 bsdtar，本项目打包脚本也在用它）：

```powershell
$src = 'D:\coding\BeWithU'
$out = 'D:\coding\bwu-1.0.13-handoff.zip'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out }
Push-Location $src
tar.exe -a -c -f $out `
  --exclude='node_modules' --exclude='.cache' --exclude='.pnpm-store' `
  --exclude='out' --exclude='.shots' --exclude='.git' `
  --exclude='release/archive-*' --exclude='*.log' --exclude='*.wav' `
  .
Pop-Location
Get-Item -LiteralPath $out | Select-Object FullName, Length
```

实测（不含 `win-unpacked`）：**236 MB / 216 个条目 / 5 秒**；带 `win-unpacked` 时 **389 MB / 297 个条目 / 16 秒**。
zip 内已确认没有 `node_modules`、`.git`、`.cache`、`.pnpm-store`、`.shots`、`out`、`release/archive-*`，
且包含 1.0.13 安装器、便携版、`SHA256SUMS-1.0.13.txt` 与 `docs/RELEASE-1.0.13.md`。

- 想再小一点（不要 `win-unpacked`，约 250 MB）：加一条 `--exclude='release/win-unpacked'`。
- 想连 git 历史一起带：**不要**整个 `.git`（1.17 GB，且大头是没用的旧 LFS 对象），用 bundle：

  ```powershell
  Set-Location 'D:\coding\BeWithU'
  git bundle create 'D:\coding\bwu-1.0.13.bundle' --all   # 实测约 1.7 MB
  ```

  新机器 `git clone D:\coding\bwu-1.0.13.bundle BeWithU` 即可拿到完整提交历史。
  bundle 不含 `.git/lfs` 里的旧对象——当前 HEAD 用不到；要翻极老版本再需要时从 GitHub 拉。

### 11.3 新机器恢复步骤

1. **解压**到任意目录（建议同盘符固定路径，文档里的 `D:\coding\BeWithU` 是默认假设）。
   注意本机曾遇到目录 ACL 缺少当前用户写权限（§8.11）；换用户/换机器解压后如果命令跑不起来，用
   `diagnose-windows-sandbox-acl.ps1` 那套流程检查，或直接在解压目录属性里给自己完全控制。
2. **装依赖**（不要拷 `node_modules`）：
   ```powershell
   Set-Location <解压后的目录>
   .\scripts\install.cmd          # 或： pnpm install --frozen-lockfile --store-dir .pnpm-store
   ```
   `pnpm-lock.yaml` 是唯一的依赖真值；`package.json` 里是范围版本，别用 `npm install`。
3. **构建**：
   ```powershell
   Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   $d = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"   # 没有 DSH 就用系统 node
   & "$d\node\bin\node.exe" node_modules\electron-vite\bin\electron-vite.js build
   ```
4. **自检**（三条，几十秒）：
   ```powershell
   & $node tools\smoke-test.mjs            # 期望 11/11
   & $node --test tools\approval.test.mjs  # 单测：完整列表见 §5，期望 54/54（+ASR 归档 3 条）
   & $node tools\agent-run-test.mjs        # 冒烟一条 E2E，期望 10/10
   ```
5. **打包版验收**（可选，需 `release/win-unpacked`）：
   ```powershell
   $env:BWU_TEST_EXE = 'release\win-unpacked\BeWithU.exe'; & $node tools\smoke-test.mjs
   ```
   安装器校验用 `release/SHA256SUMS-1.0.13.txt` 里的 SHA-256 配 `scripts/check-installer.ps1`。
6. **本地语音模型不在仓库里**：`%APPDATA%\BeWithU\models\sensevoice-2024-07-17` 需要在新机器上重新下载
   （设置 → 语音 → 下载模型）。想离线装：带上 `D:\coding\bwu-asr-dl\archive.tar.bz2`（163 MB，官方归档，
   SHA-256 已核对），用 `tools/asr-download-test.mjs` 的流程验证后手工放进上述目录。

### 11.4 仓库外的资产（本机专用）

| 路径 | 体积 | 处理 |
|---|---:|---|
| `D:\coding\bwu-asr-dl\` | 155 MB | 选带：`archive.tar.bz2`（已校验的官方 ASR 归档）+ `fetch-asr.ps1`（续传/校验）+ `run-e2e.ps1`（E2E 驱动）+ 最近一次 E2E 日志 |
| `D:\coding\bwu-staging-1.0.13\`（还有 1.0.11/1.0.12） | 各 ~626 MB | **删**：与 `release/win-unpacked` 重复，只是打包中间产物 |
| `D:\coding\bwu-acl-recovery\` | 0.1 MB | 不带：本机工作区权限修复的回滚记录，换机器无意义 |

### 11.5 绝对不要打包的东西

- `%APPDATA%\BeWithU\`（或自定义数据目录）：真实设置、`secrets.bin`、`history.json`、`memory.json`、
  日志、本地模型。里面有你的 API Key、MCP 凭据和聊天记录。
- 任何 `.env` / Key 文件 / MCP headers。
- `.shots/` 里的临时 userData（测试用的假配置，混进去容易误判）。
- 打好的 zip/bundle 本身不要放进仓库目录再压一次。

### 11.6 交接前 30 秒自检

```powershell
Set-Location 'D:\coding\BeWithU'
git status --porcelain          # 应为空
git log --oneline -5            # 确认 HEAD 与 origin/main 一致（git rev-parse HEAD; git rev-parse origin/main）
Get-Content release\SHA256SUMS-1.0.13.txt
Get-FileHash release\BeWithU-1.0.13-x64.exe -Algorithm SHA256   # 与清单一致
```

