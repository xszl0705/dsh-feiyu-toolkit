# 给 dsh-draw 准备 Python 依赖（不用 pip）
#
# 为什么不用 pip：DSH 沙箱里 pip 写盘会被拒（Errno 13），连纯 Python 包都装不上。
# 所以改用「从镜像取 wheel 直链 → zipfile 解压 → 运行时 PYTHONPATH 注入」。
#
# 用法：
#   pwsh -File scripts\setup-pylibs.ps1
#   pwsh -File scripts\setup-pylibs.ps1 -PythonPath "C:\Python312\python.exe"

param(
    [string]$PythonPath = ""
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repo 'packages\dsh-draw\pylibs'
$fetcher = Join-Path $PSScriptRoot 'fetch-pylibs.py'

# 找 Python：显式参数 > 环境变量 > DSH 自带运行时
if (-not $PythonPath) {
    if ($env:DSH_PYTHON -and (Test-Path $env:DSH_PYTHON)) {
        $PythonPath = $env:DSH_PYTHON
    } else {
        $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
        $cand = Get-ChildItem (Join-Path $dshHome 'dsh-runtimes') -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'dependencies\python\python.exe' } |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($cand) { $PythonPath = $cand }
    }
}
if (-not $PythonPath) {
    Write-Error "找不到 Python。请加 -PythonPath <你的 python.exe>，或设置环境变量 DSH_PYTHON。"
}

Write-Host "Python : $PythonPath"
Write-Host "目标   : $target"
New-Item -ItemType Directory -Force -Path $target | Out-Null

# 顺序有讲究：先装依赖，再装 matplotlib 本体
$pkgs = @('six', 'packaging', 'pyparsing', 'python-dateutil', 'cycler',
          'fonttools', 'kiwisolver', 'contourpy', 'pillow', 'matplotlib')

& $PythonPath $fetcher $target @pkgs
if ($LASTEXITCODE -ne 0) { Write-Error "依赖下载失败（exit $LASTEXITCODE）" }

# 自检：能不能真的 import
$env:PYTHONPATH = $target
& $PythonPath -c "import matplotlib, PIL; print('OK matplotlib', matplotlib.__version__, '| Pillow', PIL.__version__)"
if ($LASTEXITCODE -ne 0) { Write-Error "装完了但 import 失败，检查 $target" }

Write-Host "`n完成。dsh-draw 现在可以出图了。" -ForegroundColor Green
