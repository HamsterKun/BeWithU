# Test input target: a WinForms window with a textbox and a button.
# Purpose: give keyboard/mouse injection tests a readable target.
#   - textbox content is dumped to text.txt every 200ms
#   - clicking the button appends a line to mark.txt
#   - control screen coordinates are written to geom.json
# NOTE: keep this file ASCII-only, Windows PowerShell 5.1 misreads UTF-8 without BOM.
param(
  [string]$OutDir = "$env:TEMP\bwu-input-harness",
  [int]$X = 2100,
  [int]$Y = 300
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$textFile = Join-Path $OutDir 'text.txt'
$markFile = Join-Path $OutDir 'mark.txt'
$geomFile = Join-Path $OutDir 'geom.json'
Remove-Item $textFile, $markFile, $geomFile -ErrorAction SilentlyContinue

$form = New-Object System.Windows.Forms.Form
$form.Text = 'BWU Input Harness'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.ClientSize = New-Object System.Drawing.Size(560, 320)
$form.TopMost = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Location = New-Object System.Drawing.Point(20, 20)
$box.Size = New-Object System.Drawing.Size(520, 200)
$box.Font = New-Object System.Drawing.Font('Consolas', 12)
$form.Controls.Add($box)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'MARK'
$btn.Location = New-Object System.Drawing.Point(20, 240)
$btn.Size = New-Object System.Drawing.Size(160, 44)
$form.Controls.Add($btn)

$btn.Add_Click({
    Add-Content -Path $markFile -Value ("clicked " + (Get-Date -Format 'HH:mm:ss.fff'))
  })

$form.Add_Shown({
    $form.Activate()
    $box.Focus()
    $p = $box.PointToScreen((New-Object System.Drawing.Point(0, 0)))
    $bp = $btn.PointToScreen((New-Object System.Drawing.Point(0, 0)))
    $geom = [ordered]@{
      box   = @{ x = $p.X; y = $p.Y; w = $box.Width; h = $box.Height }
      btn   = @{ x = $bp.X; y = $bp.Y; w = $btn.Width; h = $btn.Height }
      scale = 1
    }
    ($geom | ConvertTo-Json -Depth 4) | Set-Content -Path $geomFile -Encoding UTF8
  })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    try { Set-Content -Path $textFile -Value $box.Text -Encoding UTF8 } catch {}
  })
$timer.Start()

$life = New-Object System.Windows.Forms.Timer
$life.Interval = 100000
$life.Add_Tick({ $form.Close() })
$life.Start()

Write-Output "READY $OutDir"
[System.Windows.Forms.Application]::Run($form)
