# BeWithU 1.0.10 代码审查报告

- 审查基线：`2b2a24d`（1.0.10），Windows 工作区；审查开始时 Git 工作区干净。
- 审查范围：仓库自有主进程、Agent 与扩展、preload、四个渲染窗口、共享模块、构建和发布配置、维护脚本、测试及夹具；依赖锁文件作为构建输入审视，未逐行审计第三方依赖、安装包、媒体资源或本地缓存。
- 严重度：**P1** 建议发版前处理；**P2** 显著的正确性、可靠性或防御问题；**P3** 较局部的问题或工程改进。除验证表中另有说明，发现来自静态代码路径，不表示已在用户机器上发生，也不包含攻击复现。

## 一、Agent 权限与扩展

### A1 · P1：停止任务后，待审批的旧工具仍可能执行

[停止流程](src/main/services/pipeline.ts#L832-L846) 会中止轮次，但[审批请求](src/main/services/pipeline.ts#L677-L681)没有订阅中止信号；[审批后的执行](src/main/agent/runner.ts#L292-L305)也不重新检查。即使信号已中止，[统一入口](src/main/agent/index.ts#L43-L63)仍直接调用工具；[文件写入](src/main/agent/tools/files.ts#L108-L119)等实现不消费信号。所以「停止」不能保证旧审批失效。另有[语音/文字前缀匹配](src/main/agent/approval.ts#L59-L79)把含保留条件的句子当作允许，且文本确认只选最早待定请求。

**建议：**审批绑定轮次和调用 ID，停止、切轮和关闭时清除并默认拒绝；审批后和真正执行前再检查取消状态。危险操作用明确、完整的确认语句或独立按钮，并展示最终动作和目标。

### A2 · P1：MCP 移除后工具可能继续可用，外部写操作也不会逐次确认

[MCP 注册](src/main/agent/index.ts#L92-L122)只增不减：没有启用的服务时直接返回；已存在工具不更新，旧闭包保留原服务配置。设置里的[移除操作](src/main/ipc.ts#L646-L657)只删除配置和断开连接，未撤销注册；[调用路径](src/main/agent/mcp.ts#L215-L242)允许按旧配置重新建立连接。并且注册时所有远端工具都是 `low`，但 [Runner](src/main/agent/runner.ts#L284-L299)只审批 `high`。服务的副作用不能由「连接成功」推断为安全。

**建议：**按服务和配置版本管理连接及工具，禁用/移除立即撤权，调用时核对实时配置；默认确认副作用未知的远端工具，用户可显式授予具体工具权限。

### A3 · P1：文件范围检查只校验路径字符串，不校验实际目的地

[路径策略](src/main/agent/tools/files.ts#L12-L30)只通过 `resolve` 和字符串前缀判断目录。若允许目录包含 Windows junction 或符号链接，[文件读](src/main/agent/tools/files.ts#L80-L88)、[文件写及备份](src/main/agent/tools/files.ts#L108-L119)可能落到真实允许范围外；低风险 `file.read` 的摘要还会[进入模型请求](src/main/agent/runner.ts#L218-L225)。这个限制不能作为实际文件系统隔离。

**建议：**规范化允许根与真实目标；新文件验证最近存在的祖先，备份也独立验证。优先拒绝 reparse point，并考虑检查到打开期间路径被替换的竞态，避免只加一次字符串检查。

### A4 · P2：自定义工具的声明权限不是沙箱，且入口约束不完整

[自定义工具说明与执行](src/main/agent/custom-tools.ts#L1-L12)明确工具具有 Node 能力，[子进程](src/main/agent/custom-tools.ts#L193-L240)及[宿主 API 白名单](src/main/agent/custom-tools.ts#L246-L300)不会约束工具自身使用文件系统、网络或启动进程。另，[入口解析和导入](src/main/agent/custom-tools.ts#L67-L102)只校验存在与后缀，未限制规范化后的路径仍属于工具目录。

**建议：**界面把信任明确标示为「以当前用户权限运行本机代码」，清楚区分声明权限和强制权限；校验入口的真实路径及普通文件类型。需要强制权限时使用操作系统级隔离，而非把 utility process 当作安全边界。

### A5 · P2：工具步数、已公开工具集合、超时并非执行层约束

[Runner](src/main/agent/runner.ts#L116-L130)按配置生成工具列表；[执行循环](src/main/agent/runner.ts#L158-L228)只在外层检查最大步数，同一模型响应内的多个调用可超出预算；模型回传的名字未命中公开映射时仍退回全局注册表查找。[工具超时](src/main/agent/runner.ts#L301-L308)只结束等待，不取消工具，也不清除已成功调用的定时器。

**建议：**每个调用前检查剩余步数，拒绝未发布名称；在执行入口做参数 schema 校验。结合操作级 AbortController、进程终止和 transport 取消；远端无法撤销时明确显示「结果未知，动作可能仍在进行」，不要自动重试副作用操作。

### A6 · P2：扩展 ZIP 导入缺少资源限制和完整失败清理

[导入过程](src/main/agent/import-archive.ts#L12-L49)把归档交给系统 `tar`，仅有时间限制，没有文件数、解压体积、链接类型和导入树约束；异常在返回 `cleanup` 之前抛出，部分解包后的目录可能留存。不同 `tar` 实现默认保护不同，**本次未验证实际存在解压路径穿越**。

**建议：**统一受控解包实现；用限制目录、容量与文件数的 staging，拒绝链接/非普通文件，退出路径都清理。将校验通过的扩展原子发布到目标目录。

### A7 · P2：完全信任模式把 Shell 关键字拦截当成硬限制

[Runner](src/main/agent/runner.ts#L287-L305)启用完全信任后取消所有高风险工具的逐次确认；所谓「硬红线」仅是[静态正则](src/main/agent/policy.ts#L3-L28)，对于完整 PowerShell 的语义并非强制限制。应避免向用户承诺某些动作必然无法执行。

**建议：**默认保留风险确认，将 Shell 与文件、键鼠等权限拆分；强制边界依赖低权限执行环境与受限命令集，关键字检查只作为补充。

### A8 · P2：文件“读取上限”实际上在整文件读完后生效

[文件操作](src/main/agent/tools/files.ts#L45-L53)同步完整枚举再截取；[文本读取](src/main/agent/tools/files.ts#L80-L84)同步读完整文件再截字符串。面对大文件、超大目录或慢盘，可阻塞 Electron 主进程，使停止按钮也无法及时响应。

**建议：**异步读取并在 I/O 层限制实际字节数，使用目录迭代器和分页；禁止非普通文件，按场景加超时和取消。

## 二、隐私、IPC 与主进程

### B1 · P1：默认对话会截图并将画面发送给配置的 LLM

[默认设置](src/shared/defaults.ts#L61-L63)开启视觉。配置模型后的普通对话在[准备请求时截图](src/main/services/pipeline.ts#L414-L456)，将图像连同历史/记忆上下文交给[模型客户端](src/main/services/llm.ts#L112-L129)；Agent 也有[同类截图路径](src/main/services/pipeline.ts#L607-L621)。这不是仅在用户明确问「看屏幕」时执行；另，[普通截图](src/main/services/vision.ts#L61-L70)和 [WGC 屏幕选择](src/main/index.ts#L66-L84)匹配不到目标屏时会选择第一块屏幕，可能上传非预期画面。

**建议：**默认关闭；先解释何时截图、发送到哪，再由用户显式启用或按轮次授权。始终精确匹配目标显示器，匹配失败就跳过；给用户可见的采集指示和屏幕选择权。

### B2 · P1：不同用途的渲染窗口共享高权限 IPC

[窗口配置](src/main/windows.ts#L34-L48)启用了隔离上下文、关闭了 Node 集成，但禁用了 renderer sandbox，且[共享 preload](src/preload/index.ts#L21-L149)向不同页面暴露同一套管理接口。[读取密钥与截图回包](src/main/ipc.ts#L246-L250)、[扩展管理](src/main/ipc.ts#L545-L571)等主进程入口不校验发送窗口和主 frame。[全局屏幕授权](src/main/index.ts#L66-L84)也忽略发起方。当前页面是应用本地界面；问题是任一渲染上下文一旦被污染，影响面会扩大到其他窗口的权限，并非证明远程页面已能直接访问 IPC。

**建议：**按窗口角色拆分桥接并在主进程逐频道验证 `sender`、`senderFrame` 和业务会话；阻止外部导航/窗口并启用沙箱。密钥回显只允许设置页的显式操作，测试 handler 不应打进正式发布。为 [PCM 入口](src/main/ipc.ts#L483-L490)等消息校验类型、长度、速率和轮次。

### B3 · P1：本地语音模型没有来源完整性校验，坏文件可能被标记就绪

[下载器](src/main/services/asr-model.ts#L8-L15)使用公开镜像；[下载和发布](src/main/services/asr-model.ts#L46-L82)取可变 `resolve/main`，ONNX 只验大小，tokens 不验内容或大小，并在校验前重命名到正式位置。下载中断或最终镜像返回错误大小时，可能遗留正式文件；[就绪检测](src/main/services/local-asr.ts#L13-L18)只检查存在且非空，文件之后将交给本地推理运行时。

**建议：**固定上游 revision，为每个文件提供可信摘要或签名；使用独立临时文件、下载体积上限和超时，校验成功后才发布，错误退出清理。就绪检测使用同一可信 manifest，不仅检查存在。

### B4 · P2：MCP 认证头、对话数据和审计内容缺少一致的敏感数据策略

[公开设置](src/main/store/settings.ts#L217-L224)仅屏蔽固定 `SECRET_PATHS`，MCP headers 不在其中，仍会被[保存](src/main/store/settings.ts#L274-L283)并[广播](src/main/windows.ts#L694-L699)给各窗口；系统加密不可用时，其他密钥也[静默回退至可逆 Base64](src/main/store/settings.ts#L289-L300)。[历史](src/main/store/history.ts#L73-L80)、[记忆](src/main/store/memory.ts#L49-L68)以及[Agent 审计](src/main/agent/audit.ts#L46-L55)明文落盘；审计入口还[保存参数和结果片段](src/main/agent/index.ts#L61-L72)，可能含文件内容或用户输入。

**建议：**把认证头拆到凭据库；为各窗口建立最小 DTO；加密不可用时拒绝持久化或明确提示。对历史/记忆提供可配置保存和清理规则，审计默认记录操作元数据而非原文。

### B5 · P2：WGC 抓屏请求共用一个回包槽，可能卡住或错配

[抓屏协调器](src/main/vision-grab.ts#L6-L30)只有一个 `pending`，并发请求可覆盖旧 resolver；旧超时发现槽位已被替换便不再结算旧 Promise，晚到的结果又可能落到新请求。[Ball](src/renderer/ball/Ball.tsx#L84-L120)回传没有请求 ID，[视觉服务](src/main/services/vision.ts#L101-L111)也不再验证对应显示器和图像格式/大小。

**建议：**发请求 ID 和目标显示器；按 ID 跟踪并校验来源，或显式拒绝并发；每个请求超时均须结算，丢弃迟到/错配帧，重新解码并检查尺寸上限。

## 三、构建、测试与发布

### D1 · P1：发布安装器未签名，脚本指导绕过 Windows 安全标记

仓库文档确认产物[没有 Authenticode 签名](README.md#L339-L362)，但[安装脚本](scripts/install-app.cmd#L8-L30)默认按文件名选最新安装器，并用 `-ExecutionPolicy Bypass` 调用 `Unblock-File` 去除下载标记后启动；路径直接拼入 PowerShell 命令字符串。文件名不能证明版本/来源，也没有在启动前验证签名或摘要。签名缺失会使用户难以识别发布方；去标记并不能提供信任保证。

**建议：**停止推荐解除下载标记。发布时签名并公布校验摘要，脚本要求显式选择安装器并验证签名/摘要；通过 `-LiteralPath` 参数传值而非拼接 PowerShell 代码。

### D2 · P2：版本信息和交接记录互相冲突

[README 快速开始](README.md#L30-L50)还指向 `1.0.2` 产物，[包版本](package.json#L1-L7)已为 `1.0.10`。[交接文档开头](HANDOFF.md#L8-L16)自称是 `1.0.10` 且仅有参考 `git log` 的 HEAD，同时写着旧的 `1.0.3` 提交和“干净”工作区；其[尾部](HANDOFF.md#L440-L446)还保留了 `1.0.2`。这使使用者可能下载或安装错误产物。

**建议：**CI 根据单一版本/tag 生成 release notes 和文件名；发布前检查 README、交接文件、产物清单、源码 commit 一致并删除过期状态。

### D3 · P2：依赖安装没有固定工具链及生命周期策略

[包声明](package.json#L8-L35)使用范围版本，未指定 `packageManager`；[安装脚本](scripts/install.cmd#L5-L21)在缺少内置 pnpm 时改用 `npm install`。这可能忽略 `pnpm-lock.yaml`，并且未固定 Node/pnpm。构建文件将 `npmRebuild: false`，[原生依赖](package.json#L16-L34)包含 `koffi`、`uiohook-napi` 和 ONNX 运行时。不同安装方式、Node/Electron ABI 或平台下可能得到不兼容原生模块。

**建议：**要求 lockfile frozen 的 pnpm 安装，明确固定 Node/pnpm/Electron；在目标 Electron ABI 和目标平台验证原生模块，并检查最终安装包。依赖更新在 CI 中做锁文件、来源和安装脚本审查。

### D4 · P2：构建/测试说明及截图脚本会给出误导性结果

[包脚本](scripts/package.cmd#L12-L32)和[安装脚本](scripts/install.cmd#L14-L21)使用外部可变镜像；前者还把构建临时目录指向仓库 `.cache/tmp`。README 和[交接文档的测试/发布状态](HANDOFF.md#L331-L359)没有绑定源码 commit/产物摘要，因而不能独立确认验证结果属于当前代码。截图辅助脚本 `agent-shot.mjs`、`v103-shot.mjs`、`v105-shot.mjs` 在 `finally` 中无条件退出码为 0，失败时可能伪报成功。本次**没有执行** Electron E2E、联网探针或打包安装器。另，[计划文档](docs/PLAN.md#L250-L299)与当前脚本清单和状态声明也不一致；规划项并非当前实现状态证据，应区分计划和完成项。

**建议：**验证步骤输出机器可读结果并传播失败退出码；自动化测试使用隔离的临时路径和动态端口、确保 finally 清理进程。发布记录应包含确切 commit、工具版本、测试结果和产物 SHA-256。外部镜像固定来源/版本并验证校验和。

## 四、渲染端与可用性

### C1 · P2：启动麦克风失败或快速停止时，可能遗留录音资源

[Recorder](src/renderer/ball/recorder.ts#L25-L54)先拿到媒体流，再初始化 AudioContext 和 worklet；中途失败，[Ball 的错误处理](src/renderer/ball/Ball.tsx#L46-L60)只更新 UI 并上报。启动未完成时若已收到停止事件，也需要防止迟到的启动继续接管资源。

**建议：**用启动代次标识，任一步失败或被停止都关闭部分取得的流、track 和 context；每个 `await` 后确认本代仍有效。以 worklet 加载失败、权限弹窗关闭和快速按下/松开建立测试。

### C2 · P2：一个输入操作没有使用其他操作的安全检查

[点击和拖动](src/main/input-worker.ts#L216-L223)会经过安全检查，[滚轮操作](src/main/input-worker.ts#L343-L345)则直接注入；锁屏与登录/支付标题检查都被绕过。由 Agent 发起的滚动可在这些场景改变当前窗口状态。

**建议：**所有输入命令统一经过相同的锁屏、危险窗口和授权策略，并验证滚动量和坐标。

### C3 · P1：迁移数据目录时漏迁用户数据

[迁移清单](src/main/data-dir.ts#L42-L43)仅复制设置、密钥、聊天历史、记忆、模型和日志；而[用量记录](src/main/store/usage.ts#L19-L20)、[用户自定义工具](src/main/agent/custom-tools.ts#L42)、[Skills](src/main/agent/skills.ts#L23)等位于其他路径。迁移后重启会改用新数据根目录，用户会看到这些数据/扩展消失，但源目录的未迁移内容也不会被搬过去。

**建议：**从当前 `userData` 根目录枚举由应用拥有的完整持久化清单，并迁移/验证所有模块目录，兼容旧数据和回滚；更新到最终目录前不要报告迁移完成。

### C4 · P2：数据目录迁移校验不证明副本内容正确

[迁移代码](src/main/data-dir.ts#L64-L100)对每项递归复制，然后只在目标体积小于源体积时失败；已有文件、损坏内容或目标夹带额外数据都可能通过校验。之后写指针并[清理源数据](src/main/data-dir.ts#L87-L97)，这不是事务迁移。

**建议：**迁移到 staging，以相对路径、文件类型、大小和哈希核对；成功后原子切换指针，失败保留原目录并清理或回滚暂存副本。

### C5 · P2：跨轮语音识别回调可修改新的录音会话

[云端 ASR 连接与回调](src/main/services/pipeline.ts#L272-L295)用全局 `listening` 判断旧异步请求是否仍有效；上一轮 `VolcAsr.create()` 若在新一轮开始后才成功，会把旧 ASR 会话装进新轮并重放新轮 PCM；旧会话失败也可能停止当前轮。快速松开时连接尚未完成，[PCM 队列被清空](src/main/services/pipeline.ts#L304-L330)，最终没有识别结果。单一布尔值不能识别录音代次。

**建议：**每次录音分配 generation/session ID，校验回调仍归属本代；结束或切轮时取消并结算正在建立的连接；快速起止与重叠轮次做受控测试。

### C6 · P2：图像不兼容降级和 Breeze 429 重试依赖与错误格式冲突

[视觉回退](src/main/services/pipeline.ts#L517-L527)依赖 `isVisionReject()` 找到英文错误文本；但[LLM 客户端](src/main/services/llm.ts#L60-L67)遇 HTTP 错误时抛出的只是本地化通用提示（响应正文仅进日志），所以常见的 HTTP 400 图像不支持不会触发纯文本重试。

另外，[Breeze TTS](src/main/services/tts.ts#L52-L66)会把 429 映射成不带状态码的中文通用提示，而[重试逻辑](src/main/services/pipeline.ts#L110-L127)只识别错误文字中的 `429`、`concurrent` 或“并发”。限额时该句因此不会进行标注的退避重试，而会被丢弃。

**建议：**用带结构化状态/错误类型的异常控制重试，不从用户提示文本反向猜错误码；模拟 HTTP 400 图像拒绝和 HTTP 429 测试请求次数与最终状态。

### C7 · P2：全局快捷键降级模式与按住说话不兼容

[降级监听器](src/main/input/hotkey.ts#L233-L245)把每次全局快捷键按下模拟成 60 毫秒的按住/释放，且只接受键盘组合；[语音处理](src/main/services/pipeline.ts#L196-L209)仍按用户配置判定按住模式，短于默认最小按住时间还会[丢弃录音](src/main/services/pipeline.ts#L304-L319)。因此驱动不可用/注册失败后的提示虽称已降级，按住说话仍基本不能正常使用；默认 Mouse4 也不会被此路径注册。

**建议：**降级时提示真实不支持的功能并提供可用模式（例如切换模式），不要报告等同的快捷键状态。移除旧回退快捷键前先校验当前按键，并为降级状态加测试。

### C8 · P2：三个事件流解析器都忽略末尾未换行数据

[LLM](src/main/services/llm.ts#L153-L182)和[火山 TTS](src/main/services/tts.ts#L186-L219)只迭代换行符分隔的完整行，读取结束后不处理残余缓冲区；[搜索客户端](src/main/services/web-search.ts#L40-L55)也在 `res.text()` 后解析完整响应。若服务端响应是合法或容许的 SSE 文本格式，这些路径会丢弃最后一个不带换行符的 `data:` 事件，可能造成回答/音频尾段丢失或 JSON parse 失败。此发现依赖服务端返回帧格式，尚未用真实端点复现。

**建议：**使用 SSE 解析器，或在流结束时解析最后残余事件；补充分块边界、CRLF 与无尾换行的模拟响应测试。

### C9 · P2：设置可能没有保存，界面却显示成功

[设置存储](src/main/store/settings.ts#L260-L286)先修改内存数据，`save()` 吞掉写入失败，调用仍返回成功；[设置页](src/renderer/settings/Settings.tsx#L74-L85)随即显示已保存。多个自动保存请求的响应和旧状态定时器未绑定版本，也会提前清掉新一轮的保存提示。

**建议：**存储失败明确返回并保留待提交 patch；设置与密钥文件失败应可检测、可恢复。序列化提交或用 revision，保存状态只对应最新已持久化的版本。

## 五、验证结果与范围

- `tsc --noEmit -p tsconfig.node.json`：通过。
- `tsc --noEmit -p tsconfig.web.json`：通过。
- `node --check`：已跟踪的 25 个 `.mjs`、`.cjs`、`.js` 文件通过；PowerShell AST：2 个 `.ps1` 文件通过；Python AST：3 个 `.py` 文件通过。
- Electron/Vite 生产构建：成功，输出至系统临时目录，没有覆盖仓库 `out`。这只验证 bundling，不是安装包/原生模块的端到端验收。
- `node tools/player-test.mjs`：6/6 通过。测试本身使用模拟 AudioContext 和固定延时，不代表真实音频设备上的行为。
- 未运行 Electron GUI/E2E、ASR/TTS/搜索联网探针、安装器/便携包构建，也未测试多显示器、ASR 并发及错误网络响应。部分测试会启动应用或清理固定临时目录，因此未未经检查地批量运行。
- Review-only：没有改动应用源码或运行时配置；本次只新增本报告。
- 限制：不含依赖源码、安装包二进制和真实设备审计；发现是静态审阅与所列本地验证的结果，条目中已注明未能复现或依赖外部行为处不作为已验证故障。

## 建议处理顺序

1. **先处理隐私与执行授权：**默认视觉关闭并明确传输边界；停止任务撤销审批；MCP 变更实时撤权并确认副作用；扩展执行按任意本机代码权限告知；密钥与 MCP 凭据最小化暴露。
2. **再修正数据与操作正确性：**完整且可回滚地迁移数据；用录音 session ID 消除 ASR 竞态；修正视觉回退、TTS 429 和快捷键降级；统一键鼠守卫和 IPC 输入限制。
3. **发布前补供应链保障：**固定/校验 ASR 模型来源；锁定依赖和构建运行时，签名并校验产物；更新版本文档和真实测试状态。
4. **后续加固生命周期：**原生路径边界、扩展包资源限制、真正可取消的工具执行、非阻塞文件 I/O、设置保存失败处理以及 SSE 边界测试。


