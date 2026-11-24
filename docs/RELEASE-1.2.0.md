# BeWithU 1.2.0 发布说明（开发版）

> 对应 `package.json` 版本 `1.2.0`。本文记录改动，不包含安装包哈希。

## 新功能

### DSH 模式

- 设置新增「DSH 模式」：安装连接组件、重启 DeepSeek Harness 后，可选择已有 DSH 对话，或使用 BeWithU 专用对话。
- 开启后对话统一转发给 DSH，内置 Agent 和上下文管理停用；关闭后恢复本地流程。
- DSH 对话运行中会拒绝新消息，避免同一会话并发。

### GPT-SoVITS 语音合成

- 语音合成新增 GPT-SoVITS（`api_v2`）服务商。
- 支持配置 API 地址、参考音频路径、参考音频原文和语种。
- 保留服务端返回的实际采样率，兼容单声道/双声道 16 位 PCM WAV。

## 修复与兼容

- GPT-SoVITS 现在接受 `WAVE_FORMAT_EXTENSIBLE` 的 16 位 PCM WAV，不再只认普通 PCM format 1。
- 补充 DSH 专用对话的集成测试，覆盖首次创建会话和后续复用。

## 验证

```bash
corepack pnpm typecheck
node tools/run.mjs unit
corepack pnpm build
```

## 已知限制

- DeepSeek Harness 需要重启后才会加载连接组件。
- GPT-SoVITS 的参考音频路径以服务端所在电脑为准。
- DSH 模式和内置 Agent/上下文管理互斥。
