param(
  [string]$OutDir = (Join-Path $env:TEMP 'dsh-screens'),
  [string]$Window = '',
  [int]$MaxWidth = 1600,
  [switch]$NoScale,
  [switch]$List,
  [switch]$HidePet
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# 必须在任何 UI/DPI 相关调用之前声明 DPI 感知。
# 不声明时：系统缩放 135%（2560x1440）下 VirtualScreen 只返回 1890x1063，
# 而 CopyFromScreen 实际按物理像素抓，结果只截到左上角一块，右下角丢失。
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@
$dpiReady = $false
try {
  # Win10 1703+：per-monitor aware v2（-4）；失败再退回 Vista 的 system aware
  $dpiReady = [DshDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
} catch {
  $dpiReady = $false
}
if (-not $dpiReady) {
  try { [void][DshDpi]::SetProcessDPIAware() } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinPet {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@

New-Item -ItemType Directory -Force $OutDir | Out-Null

if ($List) {
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
    Sort-Object ProcessName |
    ForEach-Object { "{0}`t{1}`t{2}" -f $_.Id, $_.ProcessName, $_.MainWindowTitle }
  exit 0
}

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$path = Join-Path $OutDir "shot-$stamp.png"

$rect = $null
if ($Window) {
  $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $Window } |
    Select-Object -First 1
  if (-not $proc) { throw "no window matching '$Window'" }
  $h = $proc.MainWindowHandle
  if ([WinShot]::IsIconic($h)) { [void][WinShot]::ShowWindow($h, 9) }
  [void][WinShot]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 350
  $r = New-Object WinShot+RECT
  [void][WinShot]::GetWindowRect($h, [ref]$r)
  $rect = @{ X = $r.Left; Y = $r.Top; W = ($r.Right - $r.Left); H = ($r.Bottom - $r.Top) }
  $title = $proc.MainWindowTitle
} else {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $rect = @{ X = $vs.X; Y = $vs.Y; W = $vs.Width; H = $vs.Height }
  $title = 'fullscreen'
}

if ($rect.W -le 0 -or $rect.H -le 0) { throw "bad window size: $($rect.W)x$($rect.H)" }

# 截图时先把桌宠藏起来（它常驻桌面，会挡住要看的区域），拍完再放回去
$hidden = New-Object System.Collections.ArrayList
$cb = [WinPet+EnumProc]{
  param($h, $l)
  $len = [WinPet]::GetWindowTextLength($h)
  if ($len -gt 0) {
    $s = New-Object System.Text.StringBuilder ($len + 2)
    [void][WinPet]::GetWindowText($h, $s, $s.Capacity)
    if ($s.ToString() -match '大肥鱼|桌宠') {
      [void][WinPet]::ShowWindow($h, 0)
      [void]$hidden.Add($h)
    }
  }
  return $true
}
try {
  # 默认把桌宠留在画面里（截图就是屏幕原样）；
  # 需要一张"没有桌宠"的干净截图时，才用 -HidePet 让桌宠自己躲开。
  $pause = Join-Path $env:TEMP 'dsh-screenshot-pause'
  if ($HidePet) {
    Set-Content -Path $pause -Value (Get-Date).ToString('o') -Encoding UTF8
    Start-Sleep -Milliseconds 450
  }

  $bmp = New-Object System.Drawing.Bitmap($rect.W, $rect.H)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($rect.X, $rect.Y, 0, 0, $bmp.Size)
  $gfx.Dispose()

  if (-not $NoScale -and $MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
    $ratio = $MaxWidth / $bmp.Width
    $nw = [int]$MaxWidth
    $nh = [int]($bmp.Height * $ratio)
    $small = New-Object System.Drawing.Bitmap($nw, $nh)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $nw, $nh)
    $sg.Dispose()
    $bmp.Dispose()
    $bmp = $small
  }

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $w = $bmp.Width
  $h = $bmp.Height
  $bmp.Dispose()
} finally {
  Remove-Item $pause -Force -ErrorAction SilentlyContinue
}

# 附带一份 UTF-8 元数据，供 Node 侧稳定读取（避免控制台编码问题）
$meta = @{ path = $path; width = $w; height = $h; title = $title } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText("$path.json", $meta, (New-Object System.Text.UTF8Encoding($false)))

"OK $path"
