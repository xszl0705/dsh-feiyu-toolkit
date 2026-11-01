<#
.SYNOPSIS
  升级 dsh-feiyu-toolkit：保留你填好的 config.json，只更新代码。

.DESCRIPTION
  两种用法：
    1) 目录本身是 git 仓库            → 自动 fetch + reset 到 origin/main
    2) 你是下载 zip 解压的（不是 git） → 用 -SourceDir 指向新版本解压目录

  无论哪种，都会：
    - 先把 21 个 config.json 备份到临时目录
    - 更新代码
    - 把 config.json 原样放回去
    - 打印每个插件的版本变化
    - 提示你手动重启（脚本不重启）

.PARAMETER RepoDir
  当前插件仓库目录。默认是本脚本所在目录的上一级。

.PARAMETER SourceDir
  新版本解压目录（非 git 模式必填）。里面应该也有 packages\。

.PARAMETER SkipPull
  只用本地已有代码，不联网更新（配合 -SourceDir 用）。

.EXAMPLE
  pwsh -File scripts\upgrade.ps1

.EXAMPLE
  pwsh -File scripts\upgrade.ps1 -SourceDir D:\downloads\dsh-feiyu-toolkit-main
#>
param(
  [string]$RepoDir = '',
  [string]$SourceDir = '',
  [switch]$SkipPull
)

$ErrorActionPreference = 'Stop'

if (-not $RepoDir) {
  $RepoDir = Split-Path -Parent $PSScriptRoot
}
$RepoDir = (Resolve-Path $RepoDir).Path
$packages = Join-Path $RepoDir 'packages'
if (-not (Test-Path $packages)) { throw "不是插件仓库目录（找不到 packages\）：$RepoDir" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $env:TEMP "dsh-toolkit-upgrade-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null

Write-Host "== 1/4 备份 config.json ==" -ForegroundColor Cyan
$configs = Get-ChildItem -Path $packages -Recurse -Filter 'config.json' -File
foreach ($c in $configs) {
  $rel = $c.FullName.Substring($packages.Length + 1)
  $dest = Join-Path $backup $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
  Copy-Item $c.FullName $dest -Force
}
Write-Host "  备份 $($configs.Count) 个配置 -> $backup"

Write-Host "== 2/4 记录当前版本 ==" -ForegroundColor Cyan
$before = @{}
foreach ($p in Get-ChildItem $packages -Directory) {
  $pj = Join-Path $p.FullName 'package.json'
  if (Test-Path $pj) {
    try { $before[$p.Name] = (Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
  }
}

Write-Host "== 3/4 更新代码 ==" -ForegroundColor Cyan
$isGit = Test-Path (Join-Path $RepoDir '.git')
if ($SourceDir) {
  $src = (Resolve-Path $SourceDir).Path
  $srcPkgs = Join-Path $src 'packages'
  if (-not (Test-Path $srcPkgs)) { throw "新版本目录里没有 packages\：$src" }
  if (-not $SkipPull) {
    $dirty = Get-ChildItem $packages -Recurse -File | Where-Object { $_.Name -ne 'config.json' }
    Write-Host "  从 $srcPkgs 覆盖代码（config.json 不覆盖）"
  }
  # 只覆盖代码：逐文件复制，跳过 config.json
  Get-ChildItem $srcPkgs -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($srcPkgs.Length + 1)
    if ($_.Name -eq 'config.json' -and (Test-Path (Join-Path $packages $rel))) { return }
    $dest = Join-Path $packages $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    Copy-Item $_.FullName $dest -Force
  }
  Write-Host "  已从解压目录覆盖"
}
elseif ($isGit) {
  if (-not $SkipPull) {
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if (-not $git) { throw "找不到 git。请改成下载 zip 后用 -SourceDir 升级，或安装 git。" }
    Push-Location $RepoDir
    try {
      $dirty = & $git status --porcelain 2>$null | Where-Object { $_ -notmatch 'config\.json$' }
      if ($dirty) {
        Write-Host "  警告：仓库有未提交改动，reset 会丢弃它们：" -ForegroundColor Yellow
        $dirty | ForEach-Object { Write-Host "    $_" }
        $ans = Read-Host "  继续？(y/N)"
        if ($ans -ne 'y') { throw '已取消' }
      }
      & $git fetch origin 2>&1 | Out-Null
      # 上游历史被重写过，只能用 reset 对齐，不能 pull
      & $git reset --hard origin/main 2>&1 | Out-Null
      $head = (& $git rev-parse --short HEAD)
      Write-Host "  已对齐到 origin/main（$head）"
    }
    finally { Pop-Location }
  }
}
else {
  throw "既不是 git 仓库，也没给 -SourceDir。请下载新版本解压后加 -SourceDir 参数。"
}

Write-Host "== 4/4 恢复 config.json ==" -ForegroundColor Cyan
$restored = 0
foreach ($c in Get-ChildItem -Path $backup -Recurse -Filter 'config.json' -File) {
  $rel = $c.FullName.Substring($backup.Length + 1)
  $dest = Join-Path $packages $rel
  if (Test-Path $dest) { Copy-Item $c.FullName $dest -Force; $restored++ }
  else { Write-Host "  跳过（新版已无此包）：$rel" -ForegroundColor Yellow }
}
Write-Host "  恢复 $restored 个配置"

Write-Host ''
Write-Host '== 版本变化 ==' -ForegroundColor Cyan
foreach ($p in Get-ChildItem $packages -Directory) {
  $pj = Join-Path $p.FullName 'package.json'
  if (-not (Test-Path $pj)) { continue }
  $after = ''
  try { $after = (Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
  $was = $before[$p.Name]
  if (-not $was) { Write-Host ("  {0}: 新增 v{1}" -f $p.Name, $after) }
  elseif ($was -ne $after) { Write-Host ("  {0}: {1} -> {2}" -f $p.Name, $was, $after) -ForegroundColor Green }
}

Write-Host ''
Write-Host '注意：本版把 11 个插件的多个工具合并成了单入口，旧工具名不再注册：' -ForegroundColor Yellow
Write-Host '  budget_* -> budget      comfy_* -> comfy       self_* -> self'
Write-Host '  memory_* -> memory      naga_* -> naga         qq_* -> qq'
Write-Host '  chatlog_*/diary_* -> chatlog + diary           pet_* -> pet'
Write-Host '  playground_* -> playground                     screenshot_* -> screenshot'
Write-Host ''
Write-Host '配置备份保留在：' -ForegroundColor Cyan
Write-Host "  $backup"
Write-Host '重启 DSH 后新版本才会生效（重启这一步请你自己操作）。' -ForegroundColor Yellow
