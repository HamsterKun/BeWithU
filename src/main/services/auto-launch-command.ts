// 安装目录由快捷方式的工作目录传递，避免参数被 Shell 截断或把目录名当成脚本解析。
const command = "$d=[Environment]::CurrentDirectory;$e=[IO.Path]::Combine($d,'BeWithU.exe');if([IO.File]::Exists($e)){" +
  'Remove-Item Env:ELECTRON_RUN_AS_NODE -ea Ignore;Start-Process $e -WorkingDirectory $d -Verb RunAs}'

export const elevatedStartupArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -Command "${command}"`
