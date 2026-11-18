param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Dx = 0,
  [int]$Dy = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BwuWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public static void Down() { mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero); }
  public static void Up() { mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero); }
  public static void RDown() { mouse_event(RIGHTDOWN, 0, 0, 0, IntPtr.Zero); }
  public static void RUp() { mouse_event(RIGHTUP, 0, 0, 0, IntPtr.Zero); }
}
"@

function Move-To([int]$px, [int]$py) { [BwuWin32]::SetCursorPos($px, $py) | Out-Null }

switch ($Action) {
  'move' {
    Move-To $X $Y
    Start-Sleep -Milliseconds 300
  }
  'click' {
    Move-To $X $Y
    Start-Sleep -Milliseconds 300
    [BwuWin32]::Down()
    Start-Sleep -Milliseconds 70
    [BwuWin32]::Up()
  }
  'drag' {
    Move-To $X $Y
    Start-Sleep -Milliseconds 250
    [BwuWin32]::Down()
    Start-Sleep -Milliseconds 120
    for ($i = 1; $i -le 12; $i++) {
      Move-To ($X + [int]($Dx * $i / 12)) ($Y + [int]($Dy * $i / 12))
      Start-Sleep -Milliseconds 25
    }
    Start-Sleep -Milliseconds 80
    [BwuWin32]::Up()
  }
  'rclick' {
    Move-To $X $Y
    Start-Sleep -Milliseconds 300
    [BwuWin32]::RDown()
    Start-Sleep -Milliseconds 70
    [BwuWin32]::RUp()
  }
  default { throw "unknown action: $Action" }
}
Write-Output "ok $Action"
