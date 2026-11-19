# BeWithU 1.0.11 发布清单

> 本文件是 1.0.11 产物的校验记录。产物本身不进版本库（`release/` 被 `.gitignore` 忽略），
> 安装前请用下面的 SHA-256 与产物核对，不要只看文件名。

## 版本与来源

| 项 | 值 |
|---|---|
| 版本 | **1.0.11**（`package.json`、安装包 FileVersion/ProductVersion 均为 1.0.11） |
| 源码 commit | `23f55b610f32c42b15af952228f6a913a558ba2b`（`1.0.11: 安全与可靠性修复 + 全量 E2E 回归`） |
| 构建时间 | 2026-11-19 22:49–22:52（Asia/Hong_Kong） |
| 构建机运行时 | Node.js **v24.21.0**、Electron **45.3.3**、electron-builder **26.18.0** |
| 构建命令 | `node node_modules/electron-builder/cli.js --win --x64 --config.electronDist=node_modules/electron/dist --config.directories.output=D:\coding\bwu-staging-1.0.11` |
| 说明 | 先构建到独立 staging 校验，通过后才放进 `release/`；旧 1.0.10 产物已移入 `release/archive-1.0.10/` |

## 产物与 SHA-256

| 文件 | 大小（bytes） | SHA-256 |
|---|---|---|
| `BeWithU-1.0.11-x64.exe`（NSIS 安装器） | 129,020,533 | `095a55f1f932c7ca406d434f1f4528471dc9681620b63981935add37d85a8c98` |
| `BeWithU-1.0.11-portable.exe`（便携版） | 116,742,371 | `7ee4d3094a014f1bf1cb00edf15dcc1a5e7da4572242a857fec920ef5f463109` |

`release/SHA256SUMS-1.0.11.txt` 里有同样内容的 `sha256sum` 格式清单。校验示例：

```powershell
.\scripts\check-installer.ps1 -Path '.\release\BeWithU-1.0.11-x64.exe' `
  -ExpectedSha256 095a55f1f932c7ca406d434f1f4528471dc9681620b63981935add37d85a8c98
```

`check-installer.ps1` 在摘要不符、以及没有提供可信摘要/发布者证书指纹时会直接拒绝（三种情况均已实测）。

## 产物内容抽查（`release/win-unpacked`）

| 检查 | 结果 |
|---|---|
| `resources/app.asar` | 10,112,952 bytes，时间戳 2026-11-19 22:49:08 |
| `app.asar` 内 `package.json` | `version: 1.0.11`，`main: ./out/main/index.js` |
| `app.asar` 内 `out/main/index.js` | 存在；包含 ASR 归档 SHA-256 常量与 `--bwu-role=` 角色参数 |
| `app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` | 1,060,352 bytes |
| `app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node` | 173,056 bytes |
| `app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node` | 697,344 bytes |
| `sherpa-onnx-win-x64/onnxruntime.dll` | 17,799,168 bytes |
| `BeWithU.exe` | 250,144,256 bytes，时间戳 2026-11-19 22:49:09 |

koffi 3.3.8 的原生二进制来自可选依赖 `@koromix/koffi-win32-x64`，builder 的 smart unpack 已把它放进
`app.asar.unpacked`；`node_modules/koffi/**` 与 `sherpa-onnx-*` 也在 unpacked 里。koffi 在 Electron 45.3.3
（Node 24.22.3 / ABI 150）下可加载，应用启动日志出现 `input: 工作进程已启动`（koffi 只在 utilityProcess 里跑）。

## 本轮验证记录

| 项目 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` | 通过 |
| `electron-vite build`（输出 `out/`） | 通过 |
| 单元/安全测试（`node --test`，10 个文件） | **23/23** |
| E2E（13 个套件，共 95 条断言） | **全绿**：agent-run 10/10、ext 10/10、mcp-zip 6/6、agent-llm 3/3、agent-settings 8/8、agent-ui 19/19、prompts 4/4、thinking 6/6、search 4/4、shell-encoding 3/3、menu 6/6、app 16/16；local-asr 用本机真实模型完成识别（RTF≈0.04） |
| 隔离冒烟（`tools/smoke-test.mjs`，全新 userData） | `out/` **11/11**；`release/win-unpacked/BeWithU.exe` **11/11** |
| 冒烟里的窗口角色断言 | 球窗没有 `settings.update` / `agentTools` / `mcp`；设置窗有管理接口；打包版没有测试 IPC |
| `check-installer.ps1` 正例/反例/缺摘要 | 分别通过 / 拒绝 / 拒绝 |
| 安装包内 `latest.yml` | `version: 1.0.11`，size 与安装器一致 |

`local-asr-test.mjs` 用的模型文件与 `src/main/services/asr-model-manifest.ts` 的固定值逐个比对过：
`model.int8.onnx` 239,233,841 bytes / `c71f0ce0…cd51`、`tokens.txt` 315,894 bytes / `f449eb28…a1dc`，均一致。

## 未完成 / 不在本轮范围

- **没有代码签名**：首次运行会有 SmartScreen 提示；要消除只能买证书或接入 Trusted Signing。
- **官方 ASR 归档的整包下载校验**：本机到 GitHub release 的实际带宽约 5–10 KB/s，163 MB 归档只下到约 16%，
  未跑完；归档的 SHA-256 来自官方 `checksum.txt`（对应 release API 的 asset digest），
  归档内两个文件的 hash/size 已用本机已装模型逐一核对。**不要把半成品归档当模型使用。**
- 真实多屏/WGC、真实 ASR 设备矩阵、外部发布（安装器上传/分发）未做。
- 真鼠标类 E2E（menu/app）在桌面被全屏游戏窗口霸占时会退回应用内等价入口并打印提示；
  需要在没有前台全屏窗口的桌面上复跑，才能算完整覆盖系统级投递。
