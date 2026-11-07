# say.ps1 — Windows SAPI 合成 wav（离线，无外部依赖）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File say.ps1 <text> <outPath> [voiceName] [rate]
$ErrorActionPreference = 'Stop'

$Text = $args[0]
$OutPath = $args[1]
$VoiceName = $args[2]
$Rate = $args[3]
if (-not $Text) { Write-Error 'missing text'; exit 2 }
if (-not $OutPath) { Write-Error 'missing outPath'; exit 2 }
if (-not $VoiceName) { $VoiceName = 'Microsoft Huihui Desktop' }
if (-not $Rate) { $Rate = 0 }

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoice($VoiceName) } catch { }
$synth.Rate = [int]$Rate

$dir = Split-Path -Parent $OutPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$synth.SetOutputToWaveFile($OutPath)
try {
    $synth.Speak($Text)
} finally {
    $synth.Dispose()
}
if (-not (Test-Path $OutPath)) { Write-Error ('tts output missing: ' + $OutPath); exit 3 }
Write-Output ('ok ' + $OutPath + ' ' + (Get-Item $OutPath).Length)
