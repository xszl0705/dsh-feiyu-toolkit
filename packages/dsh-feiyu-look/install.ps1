# 安装 / 回滚 dsh-feiyu-look（一次只动一个插件）
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1            # 安装
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Rollback  # 回滚到最近一次安装前
#
# 改过的地方（2026-10-31）：
#   1. 备份路径写进 backup-path.txt，回滚读它，不再靠目录名猜（原来那个 *-feiyu-look 过滤永远匹配不到）
#   2. 装完立刻自检：JSON 合法 / junction 在 / bundles 含插件名
#   3. 删链接前先判 LinkType，避免误删真目录内容
#   4. node 路径多候选，最后一个才用 Get-Command
#   5. 提示里加「重启后先看 bundles 数量」
param([switch]$Rollback)

$ErrorActionPreference = 'Stop'
$ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$PkgDir = $PSScriptRoot
$PkgName = 'dsh-feiyu-look'
$BackupRoot = Join-Path $env:USERPROFILE '.dsh\backups'
$PointerFile = Join-Path $BackupRoot 'feiyu-look-latest-backup.txt'

if (-not (Test-Path $ProfileDir)) { throw "profile 不存在：$ProfileDir" }

function Remove-JunctionOnly([string]$path) {
    if (-not (Test-Path $path)) { return }
    $item = Get-Item $path -Force
    if ($item.LinkType -eq 'Junction') { $item.Delete() }
    elseif ($item.LinkType) { $item.Delete() }
    else { throw "拒绝删除：$path 不是 junction，可能是真目录" }
}

if ($Rollback) {
    if (-not (Test-Path $PointerFile)) { throw "没有安装记录：$PointerFile" }
    $bak = (Get-Content $PointerFile -Raw).Trim()
    if (-not (Test-Path $bak)) { throw "记录的备份目录不存在：$bak" }
    foreach ($f in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
        $src = Join-Path $bak $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $ProfileDir $f) -Force }
    }
    $link = Join-Path $ProfileDir "node_modules\$PkgName"
    Remove-JunctionOnly $link
    Remove-Item $PointerFile -Force -ErrorAction SilentlyContinue
    Write-Host "已回滚到 $bak。重启 DSH 生效。" -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path (Join-Path $PkgDir 'package.json'))) { throw "插件目录不完整：$PkgDir" }
foreach ($f in 'index.js', 'lib\client.js', 'cordis.patch.yml') {
    if (-not (Test-Path (Join-Path $PkgDir $f))) { throw "插件缺文件：$f" }
}

# 1) 备份
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = Join-Path $BackupRoot "$stamp-before-feiyu-look"
New-Item -ItemType Directory -Force -Path $bak | Out-Null
foreach ($f in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
    $src = Join-Path $ProfileDir $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $bak $f) -Force }
}
Set-Content -Path $PointerFile -Value $bak -Encoding UTF8
Write-Host "备份：$bak" -ForegroundColor Green

# 2) node：多候选，最后一个才查 PATH
$nodeCandidates = @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
$node = $nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) { throw '找不到 node，改不了 package.json' }

# 3) 依赖 + bundles
$edit = @'
import fs from 'node:fs'
const [file, name, link] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies[name] = link
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + '\n', 'utf8')
console.log('bundles =', pkg.dsh.profile.bundles.length, '个')
'@
$editFile = Join-Path $env:TEMP 'feiyu-look-edit.mjs'
Set-Content -Path $editFile -Value $edit -Encoding utf8
& $node $editFile (Join-Path $ProfileDir 'package.json') $PkgName ('link:' + ($PkgDir -replace '\\', '/'))
if ($LASTEXITCODE -ne 0) { throw '改 package.json 失败' }

# 4) node_modules junction
$linkPath = Join-Path $ProfileDir "node_modules\$PkgName"
Remove-JunctionOnly $linkPath
New-Item -ItemType Junction -Path $linkPath -Target $PkgDir | Out-Null

# 5) 装后自检
$fail = @()
try { $null = Get-Content (Join-Path $ProfileDir 'package.json') -Raw | ConvertFrom-Json } catch { $fail += 'package.json 不是合法 JSON' }
if (-not (Test-Path (Join-Path $linkPath 'index.js'))) { $fail += 'junction 指向不对（读不到 index.js）' }
$check = @'
import fs from 'node:fs'
const [file, name] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const inDeps = Boolean(pkg.dependencies?.[name])
const inBundles = (pkg.dsh?.profile?.bundles || []).includes(name)
console.log(JSON.stringify({ inDeps, inBundles, count: (pkg.dsh?.profile?.bundles || []).length }))
'@
$checkFile = Join-Path $env:TEMP 'feiyu-look-check.mjs'
Set-Content -Path $checkFile -Value $check -Encoding utf8
$json = & $node $checkFile (Join-Path $ProfileDir 'package.json') $PkgName
$parsed = $json | ConvertFrom-Json
if (-not $parsed.inDeps) { $fail += 'dependencies 里没有这个包' }
if (-not $parsed.inBundles) { $fail += 'bundles 里没有这个包' }

if ($fail.Count -gt 0) {
    Write-Host "自检失败：" -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host "跑 install.ps1 -Rollback 回滚" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "装好了，自检通过（bundles 现在 $($parsed.count) 个）" -ForegroundColor Cyan
Write-Host "重启 DSH 后：" -ForegroundColor Cyan
Write-Host "  1. 刷新页面，右上角应出现「心情 / 记忆 / 知识 / 技能 / 桌宠」浮条"
Write-Host "  2. 立刻确认 bundles 还是 $($parsed.count) 个——如果变少，说明被宿主重置了"
Write-Host "  3. 工具数量不变（这个插件不注册任何工具）"
Write-Host "  4. 打不开或工具变少 → install.ps1 -Rollback"
Write-Host "  5. 端点自测：Invoke-WebRequest http://127.0.0.1:<当前端口>/dsh-feiyu-look/state"
