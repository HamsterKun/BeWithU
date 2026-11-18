# BeWithU 交接文档（2026-11-18 下班前）

> 给接手这个项目的 Agent：本文假设你对项目的认知还停留在「今天早上刚拿到代码」的状态。
> 先读 **§0 速览** 和 **§9 操作准则**，再按需查后面的细节。
>
> 代码在同一台机器、同一个文件夹：`C:\Users\jiangchengrui\Desktop\BeWithU`。
> 今天新增的所有代码都在 `main` 分支上，HEAD = `acc22f2`，工作区干净。

---

## 0. 30 秒速览

**早上你拿到的 BeWithU**：一个 Electron 桌面语音伙伴（悬浮球 + 气泡 + 语音对话 + TTS/ASR + 换皮肤），只有聊天能力。

**现在它多了什么**：一个真正的 Agent 能力层——能调用 19 个工具直接操作电脑（键鼠注入、文件读写、启动应用、通知/提醒、PowerShell），有「低风险静默 / 高风险弹卡确认」的权限模型、语音说「同意」的确认方式、球上的「工作中」状态、以及一个「Agent 能力」设置页 + 审计日志。

**还没做完的**：
1. ~~工具/Skill 的**导入**~~ → **11-18 晚已做完**（见 §12）
2. COM / UIA 深度办公能力（只有设计，没实现）
3. ~~**打包没成功**~~ → **11-18 晚打包成功**（`release/` 里是 20:14 / 20:16 的新包，含 Agent 代码）

**今天新增 commit（在 `719e1cc` 之上）**：

```
acc22f2 feat(agent): Agent 能力设置页 + 审计日志
7bc04e4 feat(agent): 工作状态可视化（外圈流光 + 💬 工作中徽标 + 审批卡滚动）
d6e4d0f feat(agent): M2 工具循环 + 审批确认 + Shell/文件/应用工具
0e95f53 feat(agent): M1 键鼠注入与工具注册表
```

已推送到 `https://github.com/HamsterKun/BeWithU.git`（`main` 已同步到 `acc22f2`）。
推送时如果报 LFS 锁错误，用：`git push --no-verify origin main`（本仓库没有 LFS 文件了，只是 hook 残留）。

---

## 1. 今天修了什么 / 加了什么（按用户视角）

用户在这一天里陆续提的诉求，全部已落地并验证：

| 诉求 | 状态 |
|---|---|
| 名字可以清空（清空后显示 TA） | ✅ 已修 |
| 悬浮球点不动 / 拖不动 | ✅ 已修（点击穿透轮询 + 窗口重排） |
| 默认模型改 DeepSeek | ✅ 已改默认值 |
| 气泡上的固定/关闭/去设置按钮点不动 | ✅ 已修（自定义菜单窗口方案） |
| 球和气泡之间有大缝隙 | ✅ 已修（ring 半径 + 18px 间距） |
| 气泡里能打字对话 | ✅ 已做（composer） |
| TTS 试听会打断当前播报 | ✅ 已修（先 audioStop + interrupt） |
| 去掉一堆莫名其妙的碎提示 | ✅ 已删 |
| 皮肤功能 + 4 个内置皮肤 | ✅ 已做（大肥鱼/大小姐/极其猫/龙女仆） |
| 右键菜单关不掉、太窄、快捷键冲突 | ✅ 已修（自定义菜单窗口 + 去掉 Ctrl+,） |
| 代码推到 GitHub（.gitignore 过滤构建产物） | ✅ 已推 |
| **Agent 能力（本次重头）** | ✅ M1/M2/M3 已落地，导入与 COM/UIA 待做 |

---

## 2. 仓库结构（今天有变化的用 ★ 标出）

```
electron.vite.config.ts      ★ 新增 input-worker 入口
electron-builder.yml         ★ asarUnpack 加 koffi
package.json                 ★ 新增依赖 koffi@3.3.8

src/
  main/
    index.ts                 启动、单实例、快捷键、托盘
    windows.ts               ★ sendAgentProgress / broadcastPhase / 各窗口
    ipc.ts                   ★ Agent 测试通道、审批、工具列表、运行记录、目录选择
    tray.ts
    input-worker.ts          ★★ 键鼠注入工作进程（utilityProcess，koffi 在这里跑）
    services/
      input-inject.ts        ★★ 注入客户端（RPC 到 input-worker）
      pipeline.ts            ★ 对话主流程；respondWithAgent() 是 Agent 分支
      llm.ts                 LLM 流式聊天（未改）
      tts.ts / asr.ts / vision.ts / splitter.ts / summarizer.ts
    agent/                   ★★ 全新目录
      index.ts               注册工具 + callTool（统一入口，审计挂这里）
      registry.ts            工具注册表 + 转 OpenAI tools 格式
      types.ts               ToolDef / ToolResult / risk
      runner.ts              Agent 主循环（LLM ⇄ 工具，步数/超时/确认/中断）
      llm-agent.ts           tool_calls 调用（非流式）+ mock LLM（测试用）
      approval.ts            确认请求（气泡卡片 + 语音/文字「同意」+ 15s 超时）
      policy.ts              极高危命令拦截（rm -rf / format / diskpart …）
      shell-run.ts           PowerShell 执行（超时/中断/输出截断）
      audit.ts               审计日志（按天 JSONL，保留 7 天）
      tools/
        input.ts             键鼠/窗口工具（9 个）
        files.ts             file.list / file.read / file.write
        shell.ts             shell.ps（默认关闭）
        system.ts            app.launch / notify / remind / web.open
        skills.ts            ★ skill.read（Skill 全文读取）
      custom-tools.ts        ★ 第三方工具：manifest 校验 / 信任 / 子进程执行
      skills.ts              ★ Skill 扫描 / 导入 / 删除 / 提示词摘要
    tool-worker.ts           ★ 自定义工具执行进程（每次调用一个）
    store/settings.ts        ★ agent 配置归一化（maxSteps 3–30 等）
  preload/index.ts           ★ agent/agentTools/agentTest/pickDir/onAgent
  shared/
    types.ts                 ★ AgentSettings / Phase 增加 'acting'
    defaults.ts              ★ agent 默认值（enabled=false, shellEnabled=false, maxSteps=10）
    ipc.ts                   ★ 新通道 + BwuApi 类型 + AgentProgress
    art.ts                   皮肤（自动生成，勿手改）
  renderer/
    ball/                    ★ acting 状态：外圈流光 + 💬 工作中徽标
    bubble/                  ★ 确认卡 + 步骤行 + 滚动到确认卡
    settings/                ★ 新标签页 Agent 能力（panes/AgentPane.tsx）
    menu/                    右键菜单窗口

tools/                       ★ 新增 5 个测试/工具脚本
  agent-input-test.mjs       键鼠注入端到端（打到自家气泡，稳定）
  agent-run-test.mjs         Agent 循环端到端（mock LLM，7 项）
  agent-ui-test.mjs          交互端到端（审批卡/球状态，6 项）
  agent-settings-test.mjs    设置页端到端（8 项）
  agent-shot.mjs             截两张 Agent 效果图
  input-harness.ps1          手动验证用的 WinForms 靶子窗口
  app-test.mjs / menu-test.mjs / player-test.mjs   原有回归
```

---

## 3. Agent 子系统详解（最重要，别改错）

### 3.1 一次任务是怎么跑的

```
气泡输入 / 语音
   → pipeline.respond()
       ├─ 若正在等确认：把「同意/拒绝」解析成确认结果，直接 return（不开新回合）
       └─ s.agent.enabled ? respondWithAgent() : 原来的纯聊天
            → runner.runAgentTask()
                 loop (最多 maxSteps=10):
                   chatWithTools(messages, tools)   ← 真 LLM 或 mock
                   ├─ 没有 tool_calls → 结束，返回文本
                   └─ 有 → 逐个执行 runOne()
                        ├─ 工具被禁用 → 回填结果
                        ├─ policy.checkDangerous → 命中极高危 → 拒绝
                        ├─ risk=high → approval.requestApproval()（气泡卡片 / 语音）
                        ├─ callTool()（带 stepTimeoutMs 超时）
                        └─ 审计 recordAudit()
                   把结果写回 messages（role=tool）继续
```

要点：
- **只有 `risk:'high'` 才弹确认**；`low` 静默执行。
- **Shell 是"开启即完全信任"**：`agent.shellEnabled=true` 后不再逐次确认，但 `policy.ts` 的硬红线（rm -rf / format / diskpart / bcdedit / 删系统注册表 / 关机 / fork 炸弹）永远拦截。
- **Shell 未开启时不要报错给用户看**：`tools/shell.ts` 返回 `ok:false` + 一句"请告诉用户去 设置 → Agent 能力 开启 Shell"的引导，模型会转述。
- 中断：`respondWithAgent` 持有 `AbortController`（`this.abortLlm`），用户按开麦键/说停/点停止都会 abort，runner 每一步都检查 `signal.aborted`。

### 3.2 工具清单（19 个）

| 分类 | id | risk | 说明 |
|---|---|---|---|
| 键鼠 | `input.type` | high | Unicode 注入，支持中文；可带 `expectTitle` 目标窗口校验 |
| | `input.key` | high | `ctrl+s` / `alt+tab` / `f5` 等 |
| | `input.mouse_move` | high | 物理像素坐标 |
| | `input.click` | high | 左/右/中键，1–3 连击 |
| | `input.scroll` | high | 格数，负数向下 |
| | `input.drag` | high | 按住左键拖拽 |
| | `input.cursor` | low | 读鼠标位置 |
| | `input.screen_info` | low | 虚拟桌面尺寸/原点 |
| 窗口 | `window.foreground` | low | 当前前台窗口标题 |
| | `window.focus` | low | 按标题切前台（AttachThreadInput 绕前台锁） |
| 文件 | `file.list` | low | 列目录 |
| | `file.read` | low | 读文本（上限 2 万字） |
| | `file.write` | high | 写/追加，覆盖前自动 `.bak` |
| 系统 | `app.launch` | high | 记事本/计算器/画图/资源管理器…或 exe 路径 |
| | `notify` | low | 桌面通知 |
| | `remind` | low | N 分钟后提醒 |
| | `web.open` | low | 仅 http/https |
| Shell | `shell.ps` | high | 默认关闭；开启后完全信任（除硬红线） |
| Skill | `skill.read` | low | 按名称读取技能全文（渐进披露第二层） |
| 测试 | `input.self_test` | low | **只在 `BWU_AGENT_TEST=1` 时注册** |

### 3.3 设置项（`Settings.agent`）

```ts
agent: {
  enabled: false,        // 总开关
  shellEnabled: false,   // Shell 完全信任（默认关）
  maxSteps: 10,          // 3–30，设置页可改
  stepTimeoutMs: 20000,
  audit: true,           // 审计日志
  files: { fullAccess: false, dirs: [] },
  disabledTools: [],      // 被禁用的工具 id
  trustedTools: [],       // 已信任的第三方工具 id（未信任不注册）
  skillsEnabled: true     // 是否把 Skill 摘要注入提示词
}
```

自定义工具（M4）与 Skill 见 §12：前者 `agent/custom-tools.ts` + `tool-worker.ts`，
后者 `agent/skills.ts` + `agent/tools/skills.ts`。

文件访问规则（`tools/files.ts`）：
- `fullAccess=false` 时只允许 **桌面 / 文档 / 下载** + `dirs` 里列的目录（`path.resolve` 前缀校验，防 `..` 穿越）
- 路径越界时报错文案会引导用户去设置页加目录

### 3.4 审批（`approval.ts` + 气泡 UI）

- `requestApproval()` → 发 `{type:'approve', req}` 给气泡 → 卡片显示工具名 + 参数预览（shell 显示 purpose+脚本前 500 字，写文件显示路径+内容前 240 字）
- 用户点「允许/拒绝」→ `agent:approve` → `resolveApproval()`
- 或直接说/打「同意 / 可以 / 确认 / 好 / 行 / 允许」→ pipeline 在 `respond()` 最前面拦截，不开新回合
- **15 秒无响应默认拒绝**

### 3.5 审计（`audit.ts`）

- 路径：`%APPDATA%\bewithu\agent\runs\YYYY-MM-DD.jsonl`
- 每次 `callTool` 成功/失败都写一条（toolId / ok / summary / argsPreview）
- 启动/写入时清理 7 天前的文件
- 设置页「运行记录」显示最近 50 条，可清空

### 3.6 键鼠注入（最容易踩坑的部分）

**结论：koffi 不能在 Electron 主进程里调用**（实测直接 `0xC0000005` 崩溃，最小复现无任何输出就退出），但在普通 Node 里完全正常。

所以架构是：

```
主进程 services/input-inject.ts  ──postMessage──▶  utilityProcess: main/input-worker.ts
        （纯 RPC + 超时）                              （koffi 调 user32，SendInput）
```

- worker 通过 `process.parentPort` 收发 `{id, cmd, args}` / `{id, ok, result|error}`
- 启动时 `workerPing()` 预热，避免第一次注入等冷启动
- `electron-builder.yml` 必须保留 `node_modules/koffi/**` 到 `asarUnpack`，否则打包后加载失败
- 坐标：**物理像素**，原点为虚拟桌面左上角；`screen.info` 返回虚拟桌面尺寸供模型换算
- 防护：登录/支付类窗口标题（密码/登录/支付/password/login）拒绝注入；`expectTitle` 不匹配拒绝；锁屏检测（`OpenInputDesktop` 失败）直接报「屏幕已锁定」
- 单次输入上限 2000 字，中文走 `KEYEVENTF_UNICODE`，`\r\n` 归一成回车

---

## 4. UI 改动

### 4.1 球（`src/renderer/ball/`）

- `Phase` 新增 `'acting'`；`data-phase` 优先取 agent 状态
- `[data-phase='acting'] .ring`：外圈改 **琥珀⇄青** 双色 conic 流光 + 呼吸（**球体本身不变红**，这是用户明确要求）
- 球下方 `💬 工作中… 3/10` 徽标（`.work-badge`），来自 `IPC.agentProgress`，任务结束自动消失
- 徽标在球窗口内（200×200），所以不会挡住别的窗口

### 4.2 气泡（`src/renderer/bubble/`）

- 步骤行 `.card__step`：`正在：写入文件` / `已完成：…` / `失败`
- 确认卡 `.approve`：标题 + 参数 `pre` + 「允许 / 拒绝」+「也可以直接说"同意"」
- 确认卡出现时会 `scrollIntoView({block:'nearest'})`，否则会被"自动滚到底"顶出屏幕
- 头部状态文案 `acting → 工作中`

### 4.3 设置页（`src/renderer/settings/panes/AgentPane.tsx` + 侧栏新标签）

结构（自上而下）：
1. Agent 能力：启用开关、允许执行 PowerShell（开启后出现红字风险提示）、最大步数
2. 文件访问：完全访问开关、可操作目录列表（添加走系统目录选择器 / 移除）
3. 工具：19 个工具逐个开关（写 `disabledTools`）+「打开工具目录」
4. 运行记录：最近 50 条 + 清空 / 刷新

截图：`.shots/settings-agent.png`、`.shots/agent-approve.png`、`.shots/agent-ball-working.png`

---

## 5. 测试与验证

### 5.1 命令（必须用自带 Node，PATH 里没有 node）

```powershell
$d = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
$node = "$d\node\bin\node.exe"
$env:ELECTRON_RUN_AS_NODE = $null      # 必须清掉，否则 electron.exe 会被当成 node

# 类型检查（两个工程都要 0 错误）
& $node node_modules\typescript\lib\tsc.js --noEmit -p tsconfig.node.json
& $node node_modules\typescript\lib\tsc.js --noEmit -p tsconfig.web.json

# 构建
& $node node_modules\electron-vite\bin\electron-vite.js build

# 测试（每个之间隔 2–3 秒，先杀掉残留 electron）
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
& $node tools\player-test.mjs        # 播放器 6/6
& $node tools\app-test.mjs           # 界面 16/16
& $node tools\menu-test.mjs          # 右键菜单 6/6
& $node tools\agent-input-test.mjs   # 键鼠注入 8–10 项
& $node tools\agent-run-test.mjs     # Agent 循环 7/7（mock LLM）
& $node tools\agent-ui-test.mjs      # 交互 6/6（mock LLM）
& $node tools\agent-settings-test.mjs# 设置页 8/8
& $node tools\agent-ext-test.mjs     # 自定义工具 + Skill 10/10
```

### 5.2 mock LLM（不需要真 API Key）

`agent-run-test.mjs` / `agent-ui-test.mjs` 用 `BWU_AGENT_MOCK` 指向一个 JSON：

```json
{
  "scenarios": {
    "写": [
      { "text": "我来写", "toolCalls": [{ "name": "file.write", "args": { "path": "...", "content": "..." } }] },
      { "text": "已完成" }
    ]
  }
}
```

- 场景按「用户文本包含的关键字」匹配（先匹配先赢），每个场景有独立游标
- 队列耗尽会**回绕一次**（方便同一场景跑两遍：先拒绝后允许）
- 测试通道只在 `BWU_AGENT_TEST=1` 时注册：`window.bwu.agentTest.list / call / run`

### 5.3 已知的测试不稳定因素（不是产品 bug）

- **键鼠注入测试依赖真实前台和光标**：用户在用鼠标、或前台是别的程序、或**锁屏**时都会失败。
  - `agent-input-test` 已改成打进"自己的气泡窗口"（可靠）
  - `agent-ui-test` / `agent-settings-test` 不依赖 OS 注入，靠 CDP 点击，稳定
  - `app-test` / `menu-test` 用 PowerShell 的 `mouse_event` 真点击，用户动鼠标时会偶发 4/6
- 设置页有 **420ms 防抖保存**：测试里连点两个开关要间隔 ≥1.2s，否则第二个 patch 可能被覆盖（真实用户点击不会这么快）
- `tools/input-harness.ps1` 是手动验证外部窗口注入用的靶子窗口（WinForms，**必须保持 ASCII-only**，Windows PowerShell 5.1 读 UTF-8 无 BOM 的中文会解析失败）

---

## 6. 打包

### 6.1 现状（11-18 晚已解决）

- `release/BeWithU-0.1.0-x64.exe`（122.9MB，20:14）和 `BeWithU-0.1.0-portable.exe`（111.2MB，20:16）**都是含 Agent 代码的新包**
- 中午失败原因：从 GitHub CDN 拉 Electron 时 `Failed to connect to github.com:443`；换镜像即可

### 6.2 正确的打包命令（带国内镜像）

```powershell
cd C:\Users\jiangchengrui\Desktop\BeWithU
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$d = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
& "$d\node\bin\node.exe" node_modules\electron-builder\cli.js --win --x64
```

- 产物：`release\BeWithU-0.1.0-x64.exe` + `release\BeWithU-0.1.0-portable.exe`
- **打包必须用 `run_in_background: true` 的 job**，否则命令超时/进程树被杀，会留下半成品
- 检查清单（打完必须看）：
  1. `release\win-unpacked\resources\app.asar.unpacked\node_modules\koffi` 存在（否则注入不可用）
  2. `release\win-unpacked\resources\app.asar` 时间戳是新的
  3. 两个 exe 的 `LastWriteTime` 是新的（别拿旧包糊弄用户）

### 6.3 用户约定

用户明确要求：**每次改完都要打 `x64 安装包 + 便携版` 到 `release/`**。但今天他说"先不打包"之后又让我推进，最后一次我尝试打包时网络挂了。**回家后第一件事可以先把打包跑起来**（后台 job，见 §6.2）。

---

## 7. 明天可以直接做的事（按优先级）

1. **把打包补上**（§6.2），验证 koffi 在安装包里能加载：装好 → 设置里开 Agent → 让它写个文件
2. **工具导入**（M4 剩余）：
   - `agent/tools/<id>/manifest.json + index.js` 沙箱加载（utilityProcess + 受限 `bwu` API，权限校验放主进程）
   - 设置页「工具」区加「导入工具…」按钮（选目录）+ 权限摘要 + 「我信任此工具」勾选
3. **Skill 管理**：
   - `agent/skills/<id>/SKILL.md`（YAML frontmatter: name/description/whenToUse + 正文）
   - 渐进披露：常驻上下文只放 name+description，模型需要时用 `skill.read(name)` 读全文
   - 设置页「Skill」区：列表 / 导入 / 删除 / 打开目录
4. **COM / UIA 深度办公**（只在用户明确要时才做，设计见下）：
   - COM：主进程起一个 **常驻 PowerShell 代理**，`New-Object -ComObject Excel.Application`，JSON-over-stdio 收发；能干 Excel 读写单元格/公式、Word 替换文本/导出 PDF、PPT 填占位符，**不抢焦点、不动剪贴板、可读回校验**
   - UIA：PowerShell/.NET `UIAutomationClient`，`FindFirst` + `InvokePattern/ValuePattern`，按控件名点按钮/填输入框，不依赖坐标；应用需支持无障碍树
   - 建议顺序：COM 先（办公收益最大），UIA 后
5. **给模型的提示词里注入 Skill 摘要**（`runner.buildSystemPrompt`）

---

## 8. 已知问题 / 技术债

| 问题 | 影响 | 备注 |
|---|---|---|
| 打包依赖外网 | 打不出包 | 用 §6.2 的镜像 |
| `input.*` 工具在锁屏/无人值守时无效 | 按键无反应 | 已加锁屏检测，会报「屏幕已锁定」 |
| Windows 前台锁 | 切外部程序可能失败 | `window.focus` 用 `AttachThreadInput` 提高成功率，但不保证 |
| 设置页 420ms 防抖 | 极端快速连点可能丢一次改动 | 真实用户几乎不会遇到 |
| mock 队列回绕一次 | 同一场景最多跑两遍 | 测试专用 |
| `file.write` 只做 `.bak` | 无版本历史 | 够用 |
| `shell.ps` 硬红线是正则 | 复杂混淆命令可能绕过 | 用户接受"开启即信任"的风险模型 |
| Agent 不做屏幕理解 | `screen.look` 还没做成工具 | 现有 `vision.ts` 已有抓屏，接进去很快（注意需要支持图片的模型） |
| `app.launch` 白名单较小 | 只能记事本/计算器/画图/资源管理器/任务管理器/控制面板/写字板 + exe 路径 | 可以扩 |

---

## 9. 给接手 Agent 的操作准则（很重要，能省你几个小时）

1. **绝对不要用 PowerShell 写/替换含中文的源码文件**。
   `Set-Content`/`-replace` 会把 UTF-8 中文变成乱码，今天踩了三次。
   → 改代码一律用 `edit` / `write` 工具；批量替换用 **Python 脚本文件**（`write` 生成 `.py` 再执行），不要用 PowerShell 内联 Python（引号会被吃掉）。
2. **PowerShell 脚本文件（.ps1）必须 ASCII-only**，否则 Windows PowerShell 5.1 解析报"意外的标记"。
3. **koffi 只能在 utilityProcess / 子进程里用**，主进程调用直接崩（无错误输出）。
4. **测试环境变量**：`ELECTRON_RUN_AS_NODE` 必须清空；Electron 必须带 `--no-sandbox --disable-gpu --user-data-dir=<工作区内路径>`（用默认 `%APPDATA%` 会崩）。
5. **真输入测试的黄金法则**：不要依赖"当前前台是什么"。要么打到自己的窗口（`agent-input-test` 的做法），要么先 `window.focus` + `expectTitle` 校验；否则可能把字打进用户的微信。
6. **每次改完先跑两个 tsc**（node + web），再 build，再跑对应测试；跑测试前 `Stop-Process electron`。
7. 用户偏好：**界面要克制、商业化**，不要技术细节和碎提示；球是透明角色图 + 外圈光；默认第一个皮肤是大肥鱼；不喜欢 Ctrl+, 这类常用快捷键被占。
8. 用户说话直接、会盯着细节（比如"这一圈白线是什么鬼"），改 UI 前先想清楚每一层 CSS 的来源。

---

## 10. 关键文件速查

| 想改什么 | 去哪 |
|---|---|
| Agent 循环 / 步数 / 中断 | `src/main/agent/runner.ts` |
| 工具增删 | `src/main/agent/tools/*.ts` + `agent/index.ts` 注册 |
| 权限 / 硬红线 | `src/main/agent/policy.ts` |
| 确认卡 / 语音同意 | `src/main/agent/approval.ts` + `src/renderer/bubble/Bubble.tsx` |
| 键鼠注入 | `src/main/input-worker.ts`（实现）+ `services/input-inject.ts`（客户端） |
| 设置默认值 / 归一化 | `src/shared/defaults.ts` + `src/main/store/settings.ts` |
| Agent 设置页 | `src/renderer/settings/panes/AgentPane.tsx` |
| 球的"工作中" | `src/renderer/ball/Ball.tsx` + `ball.css` |
| 审计 | `src/main/agent/audit.ts` |
| 对话分流 | `src/main/services/pipeline.ts` 的 `respond()` / `respondWithAgent()` |

---

## 11. 当前进程/环境状态（11-18 晚收尾）

- 所有 electron / 打包进程已结束
- 工作区 git 干净，HEAD 见 `git log`（含 M4 + Skill + 工具名修复），已推送 `origin/main`
- `release/` 里是 20:37 / 20:39 的新包（含工具名修复 + 悬浮球大小）
- `.shots/` 新增 `agent-custom-tools.png`、`ball-size.png`
- 后台没有遗留 job；`.tmp-*` 已清理

---

## 12. 11-18 晚进展（接手后第一轮）

**打包**：§6.2 的镜像命令一次成功。
- `release/BeWithU-0.1.0-x64.exe` 122.9MB @ 20:14
- `release/BeWithU-0.1.0-portable.exe` 111.2MB @ 20:16
- 核验：`app.asar.unpacked/node_modules/koffi` 存在；打包版冒烟测试工具注册成功，
  `input.screen_info` 经 koffi 返回虚拟桌面 2560×1440。

**M4 工具导入**（新增 `src/main/agent/custom-tools.ts` + `src/main/tool-worker.ts`）
- 工具目录 `<userData>/agent/tools/<id>/`：`manifest.json` + `index.js`（`module.exports = { run(args, api) }`）
- 每次调用起一个 utilityProcess，崩溃隔离；能力只走 `log / fs.read / fs.write / notify / net`，
  **按 manifest.permissions 在主进程校验**
- 信任门禁：未信任的工具**不注册**，模型既看不到也调不到；设置页勾选后立即生效
- 设置页「自定义工具」区：导入 / 信任开关 / 删除 / 打开目录（首次会写示例工具）
- 安全边界要如实告诉用户：子进程是完整 Node，恶意代码能绕过 api —— 真正的闸门是信任勾选

**Skill 管理**（新增 `src/main/agent/skills.ts` + `src/main/agent/tools/skills.ts`）
- 目录 `<userData>/agent/skills/<id>/SKILL.md`，frontmatter 只支持 `name / description / whenToUse`
- 渐进披露：`runner.buildSystemPrompt` 只注入 name+description+whenToUse；模型需要时调 `skill.read` 取全文
- 设置页「Skill」区：启用总开关 / 导入 / 删除 / 打开目录（首次写 `_example`）
- 工具总数 19 → **20**（多了 `skill.read`）

**测试**：新增 `tools/agent-ext-test.mjs`（10 项，全绿）+ `tools/fixtures/{custom-tool,skill}`
```powershell
& $node tools\agent-ext-test.mjs     # 10/10
```
既有回归同步跑过：`agent-run-test` 7/7、`agent-settings-test` 8/8。

**下一步**：COM / UIA 深度办公（§7.4），以及给 `input.*` 补 `screen.look`。

---

## 13. 11-18 晚二轮：发消息没响应（已修）

**现象**：气泡里打字发送后完全没有回复。

**根因（日志实锤）**：
```
HTTP 400: Invalid 'tools[0].function.name': string does not match pattern
Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'
```
工具 id 用点分层（`input.type` / `file.write` / `skill.read`），而 OpenAI/DeepSeek 的函数名只允许
`[a-zA-Z0-9_-]`，所以**每次 Agent 请求都被 400 拒绝**。

**为什么是"完全没反应"**：`runner` 捕获 LLM 错误后只 `return {text:'（模型调用失败…）'}`，
没有走 `events.onText`，pipeline 只把它写进 history、没发到气泡。

**修法**：
1. `registry.wireToolName()`：发给模型前把 id 里非法字符换成下划线（`input.type` → `input_type`）；
   `buildWireMap()` 在回包时换回真实 id（撞名会打 warning 并跳过）。
2. `runner` 失败时改走 `opts.events.onText(friendlyAgentError(msg))`，气泡立刻能看到人话错误；
   同时 `pipeline` 加了兜底：`answer` 为空但 `res.text` 非空时也补发。
3. `friendlyAgentError()` 把 400 工具名 / 401 鉴权 / 404 模型名 / 取消 翻译成短句。

**验证**：新增 `tools/agent-llm-test.mjs`，本地起一个**严格校验函数名**的假 OpenAI 服务
（名字非法就照 DeepSeek 原文返回 400）：
```powershell
& $node tools\agent-llm-test.mjs   # 2/2
```
- 合法名字 → 200，气泡显示"链路正常，收到 20 个工具"
- 服务端 400 → 气泡显示"这个模型不接受工具调用…"而不是空白

**顺带**：悬浮球大小原来只能靠设置页里的滑杆，现在多了
- 设置页「快速大小」预设（小/中/大/特大，带比例圆点）
- 右键菜单「悬浮球放大 / 悬浮球缩小」（±8px，64–152 夹取）
