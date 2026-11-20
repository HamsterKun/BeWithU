# BeWithU 1.0.13 发布清单

> 本文件是 1.0.13 产物的校验记录。产物本身不进版本库（`release/` 被 `.gitignore` 忽略），
> 安装前请用下面的 SHA-256 与产物核对，不要只看文件名。1.0.12 的校验值见 `docs/RELEASE-1.0.12.md`。

## 版本与来源

| 项 | 值 |
|---|---|
| 版本 | **1.0.13**（`package.json`、安装包 FileVersion/ProductVersion 均为 1.0.13） |
| 源码 commit | `0b7fea6`（`1.0.13: 快捷键降级切换模式 + 审计/历史落盘隐私`） |
| 构建时间 | 2026-11-20 01:56–01:58（Asia/Hong_Kong） |
| 构建机运行时 | Node.js **v24.21.0**、Electron **45.3.3**、electron-builder **26.18.0** |
| 构建命令 | `node node_modules/electron-builder/cli.js --win --x64 --config.electronDist=node_modules/electron/dist --config.directories.output=D:\coding\bwu-staging-1.0.13` |
| 说明 | 先构建到独立 staging 校验，通过后才放进 `release/`；1.0.12 产物当时移入 `release/archive-1.0.12/`（归档目录已于 2026-11-20 清理时删除，需要旧包时按 tag `v1.0.12` 重新打包） |

## 产物与 SHA-256

| 文件 | 大小（bytes） | SHA-256 |
|---|---|---|
| `BeWithU-1.0.13-x64.exe`（NSIS 安装器） | 129,023,638 | `a3f277132ad5c3e90a5185f1d1bf5d1333eeac2aa708a97fb0222add29c40063` |
| `BeWithU-1.0.13-portable.exe`（便携版） | 116,745,124 | `1a0af2c78a93d3b7ba22fdbd76a9daa9bdcb2cd530696ccab99ca94f945ba1bb` |

`release/SHA256SUMS-1.0.13.txt` 是同内容的 `sha256sum` 格式清单。校验示例：

```powershell
.\scripts\check-installer.ps1 -Path '.\release\BeWithU-1.0.13-x64.exe' `
  -ExpectedSha256 a3f277132ad5c3e90a5185f1d1bf5d1333eeac2aa708a97fb0222add29c40063
```

`check-installer.ps1` 在摘要不符、以及没有提供可信摘要/发布者证书指纹时会直接拒绝（三种情况均已实测）。

## 产物内容抽查（`release/win-unpacked`）

| 检查 | 结果 |
|---|---|
| `resources/app.asar` | 10,126,107 bytes，时间戳 2026-11-20 01:56:13 |
| `app.asar` 内 `package.json` | `version: 1.0.13`，`main: ./out/main/index.js` |
| `app.asar` 内 `out/main/index.js` | 存在；包含 ASR 归档 SHA-256 常量与 `--bwu-role=` 角色参数 |
| `app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` | 1,060,352 bytes |
| `app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node` | 173,056 bytes |
| `app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node` | 697,344 bytes |
| `BeWithU.exe` | 250,144,256 bytes，时间戳 2026-11-20 01:56:14 |

## 本轮改动（相对 1.0.12）

| 项 | 说明 |
|---|---|
| **快捷键降级 = 切换模式**（C7） | 降级监听（globalShortcut）拿不到按下/抬起时序，新增 `effectiveVoiceMode()` 在降级时强制 `toggle`；状态文案区分「鼠标键监听不了 / 注册失败 / 已降级」；设置页提示，并在降级时隐藏「最短按住时长」 |
| **审计默认元数据**（B4） | 默认只写工具 id、成败、耗时、参数名与字节数；新增 `agent.auditDetail`（默认关），开启后才写摘要与参数片段，并对 `key/token/secret/password/authorization/cookie` 与 `Bearer …` 打码 |
| **历史/记忆加密**（B4） | `history.json` / `memory.json` 改为 `BWU1:` + 系统加密（DPAPI/safeStorage）密文；旧明文自动读取并在下次保存时升级；加密不可用时退回明文并记录，设置 → 关于显示「本机加密」状态 |

## 本轮验证记录

| 项目 | 结果 |
|---|---|
| `tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` | 通过 |
| `electron-vite build`（输出 `out/`） | 通过 |
| 单元/安全测试（`node --test`，16 个文件） | **49/49**（新增 `voice-mode` 1、`audit` 4、`secure-json` 7） |
| E2E（17 个套件，共 115 条断言） | **全绿**：agent-run 10、ext 10、mcp-zip 6、agent-llm 3、agent-settings 8、agent-ui 19、prompts 4、thinking 6、sse-tail 3、search 4、shell-encoding 3、menu 6、app 16、recorder-cancel 8、hotkey-fallback 4、privacy-at-rest 5；local-asr 用本机真实模型完成识别 |
| 隔离冒烟（`tools/smoke-test.mjs`，全新 userData） | `out/` **11/11**；`release/win-unpacked/BeWithU.exe` **11/11** |
| `check-installer.ps1` 正例/反例/缺摘要 | 分别通过 / 拒绝 / 拒绝 |
| 安装包内 `latest.yml` | `version: 1.0.13`，size 与安装器一致 |

本轮两个新增 E2E 直接验收改动：

- `hotkey-fallback-test.mjs`：用 `BWU_HOTKEY_FALLBACK=1`（仅 `BWU_AGENT_TEST=1` 时生效）强制走降级路径，
  配置仍是「按住说话」，断言第一次按开始录音、第二次按结束录音（旧实现第二次会被忽略）。
- `privacy-at-rest-test.mjs`：真实 Electron 里聊一句后检查 `history.json` 是 `BWU1:` 密文且搜不到原文；
  审计默认没有 `summary/argsPreview`，打开详细审计后才有。

## 未完成 / 不在本轮范围

- **没有代码签名**：首次运行会有 SmartScreen 提示；要消除只能买证书或接入 Trusted Signing。
- 真实多屏/WGC、真实 ASR 设备矩阵、外部发布未做。
- 真鼠标类 E2E（menu/app）在桌面被全屏窗口霸占时会退回应用内等价入口并打印提示；要在干净桌面上复跑才算完整覆盖。
- 官方 ASR 归档整包已在 1.0.12 发布后完成校验（见 `docs/RELEASE-1.0.12.md` 的补充验证），1.0.13 未再改动这条链路。
