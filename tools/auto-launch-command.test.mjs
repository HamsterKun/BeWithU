import assert from 'node:assert/strict'
import { test } from 'node:test'
import { elevatedStartupArguments } from '../src/main/services/auto-launch-command.ts'

test('登录启动参数能完整存入 Windows 快捷方式，并通过 UAC 启动程序', () => {
  assert.ok(elevatedStartupArguments.length < 260)
  assert.match(elevatedStartupArguments, /\$d=\[Environment\]::CurrentDirectory/)
  assert.match(elevatedStartupArguments, /if\(\[IO\.File\]::Exists\(\$e\)\)/)
  assert.match(elevatedStartupArguments, /Start-Process \$e -WorkingDirectory \$d -Verb RunAs/)
})
