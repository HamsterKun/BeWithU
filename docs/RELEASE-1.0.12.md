# BeWithU 1.0.12 发布清单

> 本文件是 1.0.12 产物的校验记录。产物本身不进版本库（`release/` 被 `.gitignore` 忽略），
> 安装前请用下面的 SHA-256 与产物核对，不要只看文件名。1.0.11 的清单在 `release/archive-1.0.11/`。

## 版本与来源

| 项 | 值 |
|---|---|
| 版本 | **1.0.12**（`package.json`、安装包 FileVersion/ProductVersion 均为 1.0.12） |
| 源码 commit | `b343897`（`1.0.12: SSE 尾帧、录音启动取消清理、文件 I/O 限流`） |
| 构建时间 | 2026-11-19 23:30–23:32（Asia/Hong_Kong） |
| 构建机运行时 | Node.js **v24.21.0**、Electron **45.3.3**、electron-builder **26.18.0** |
| 构建命令 | `node node_modules/electron-builder/cli.js --win --x64 --config.electronDist=node_modules/electron/dist --config.directories.output=D:\coding\bwu-staging-1.0.12` |
| 说明 | 先构建到独立 staging 校验，通过后才放进 `release/`；1.0.11 产物移入 `release/archive-1.0.11/` |

## 产物与 SHA-256

| 文件 | 大小（bytes） | SHA-256 |
|---|---|---|
| `BeWithU-1.0.12-x64.exe`（NSIS 安装器） | 129,021,885 | `00a0241a8499495b9772ff5ef95cc6d1584e5d9f901d2e1bc1fb2562b84fec5a` |
| `BeWithU-1.0.12-portable.exe`（便携版） | 116,745,110 | `c883a5e5a3223941230b20df3fd1ccaeca1b7e125c1ad40f9b74fa64cf16ce6f` |

`release/SHA256SUMS-1.0.12.txt` 是同内容的 `sha256sum` 格式清单。校验示例：

```powershell
.\scripts\check-installer.ps1 -Path '.\release\BeWithU-1.0.12-x64.exe' `
  -ExpectedSha256 00a0241a8499495b9772ff5ef95cc6d1584e5d9f901d2e1bc1fb2562b84fec5a
```

`check-installer.ps1` 在摘要不符、以及没有提供可信摘要/发布者证书指纹时会直接拒绝（三种情况均已实测）。

## 产物内容抽查（`release/win-unpacked`）

| 检查 | 结果 |
|---|---|
| `resources/app.asar` | 10,118,743 bytes，时间戳 2026-11-19 23:30:04 |
| `app.asar` 内 `package.json` | `version: 1.0.12`，`main: ./out/main/index.js` |
| `app.asar` 内 `out/main/index.js` | 存在；包含 ASR 归档 SHA-256 常量与 `--bwu-role=` 角色参数 |
| `app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` | 1,060,352 bytes |
| `app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node` | 173,056 bytes |
| `app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node` | 697,344 bytes |
| `BeWithU.exe` | 250,144,256 bytes，时间戳 2026-11-19 23:30:05 |

koffi 3.3.8 的原生二进制来自可选依赖 `@koromix/koffi-win32-x64`，builder 的 smart unpack 已把它放进
`app.asar.unpacked`；koffi 在 Electron 45.3.3（Node 24.22.3 / ABI 150）下可加载，启动日志出现
`input: 工作进程已启动`。

## 本轮改动（相对 1.0.11）

| 项 | 说明 |
|---|---|
| SSE 尾帧 | 新增 `src/main/services/sse.ts`：LF/CRLF/单独 CR、跨块切分、流结束吐残余；`llm.ts` 与火山 TTS 改用它。最后一条不带换行的事件不再丢 |
| 录音启动取消 | `Recorder` 加 generation：启动途中被停止/新一次启动取代时，释放已拿到的流与 `AudioContext`，抛 `RecorderCancelled` 且不上报"麦克风打不开"；失败的启动不再把 `active` 卡成 true |
| 文件 I/O 限流 | `file.read` 只读前缀（字节上限 + 8s 预算）；`file.list` 改目录迭代器分页（`offset`/`limit`，默认 200、上限 500）并提示"还有更多"；拒绝非普通文件 |

## 本轮验证记录

| 项目 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` | 通过 |
| `electron-vite build`（输出 `out/`） | 通过 |
| 单元/安全测试（`node --test`，12 个文件） | **34/34**（新增 `sse-parse` 5、`file-io` 6） |
| E2E（15 个套件，共 106 条断言） | **全绿**：agent-run 10、ext 10、mcp-zip 6、agent-llm 3、agent-settings 8、agent-ui 19、prompts 4、thinking 6、sse-tail 3、search 4、shell-encoding 3、menu 6、app 16、recorder-cancel 8；local-asr 用本机真实模型完成识别（RTF≈0.035） |
| 隔离冒烟（`tools/smoke-test.mjs`，全新 userData） | `out/` **11/11**；`release/win-unpacked/BeWithU.exe` **11/11** |
| 冒烟里的窗口角色断言 | 球窗没有 `settings.update` / `agentTools` / `mcp`；设置窗有管理接口；打包版没有测试 IPC |
| `check-installer.ps1` 正例/反例/缺摘要 | 分别通过 / 拒绝 / 拒绝 |
| 安装包内 `latest.yml` | `version: 1.0.12`，size 与安装器一致 |

新增的两个 E2E 是这次改动的直接验收：`sse-tail-test.mjs` 让假服务在最后一条事件后**不写换行**（LF 与 CRLF
各一次），断言气泡里能看到尾段；`recorder-cancel-test.mjs` 注入假的 `getUserMedia`/`AudioContext`，
分别验"启动途中松开""getUserMedia 失败""worklet 加载失败""失败后还能正常录"四种情况下的资源释放。

## 未完成 / 不在本轮范围

- **没有代码签名**：首次运行会有 SmartScreen 提示；要消除只能买证书或接入 Trusted Signing。
- **官方 ASR 归档整包下载校验**：本机到 GitHub release 带宽约 5–15 KB/s，163 MB 归档仍在续传（不到 1/4），
  未跑完；归档内两个文件的 hash/size 已用本机已装模型逐一核对一致。**不要把半成品归档当模型使用。**
- 真实多屏/WGC、真实 ASR 设备矩阵、外部发布未做。
- 真鼠标类 E2E（menu/app）在桌面被全屏窗口霸占时会退回应用内等价入口并打印提示；要在干净桌面上复跑才算完整覆盖。
