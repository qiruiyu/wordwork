<#
.SYNOPSIS
    一条命令启动 wordwork 本地开发环境。

.DESCRIPTION
    依次完成：检查 Python/Node 工具链 -> 安装 Python 依赖 -> 安装前端依赖
    -> 启动 FastAPI（127.0.0.1:8000）-> 启动 Tauri 桌面客户端。

    服务端和桌面端的日志会分别打印到当前窗口。按 Ctrl+C 结束时会一并关闭
    服务端进程。

.PARAMETER SkipInstall
    跳过依赖安装，只启动进程（依赖已经装好时更快）。

.PARAMETER ServerOnly
    只启动 FastAPI，不开桌面客户端（用于纯接口调试）。

.PARAMETER WebOnly
    只启动浏览器开发模式（Vite），不启动 Tauri 原生窗口。

.PARAMETER ServerPort
    FastAPI 监听端口，默认 8000。

.PARAMETER ResetData
    启动前清空本地开发数据目录（.dev-data）。会删除本地测试数据，请谨慎使用。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1 -SkipInstall -ServerOnly
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$ServerOnly,
    [switch]$WebOnly,
    [int]$ServerPort = 8000,
    [switch]$ResetData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$apiDir = Join-Path $root 'services/api'
$desktopDir = Join-Path $root 'apps/desktop'
$dataDir = Join-Path $root '.dev-data'
$venvPython = Join-Path $root '.venv/Scripts/python.exe'
$serverUrl = "http://127.0.0.1:$ServerPort"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Warn($message) { Write-Host "!!  $message" -ForegroundColor Yellow }

function Resolve-CommandPath {
    param([string]$Name, [string[]]$Candidates)

    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

# ---------------------------------------------------------------- 工具链检查

Write-Step '检查工具链'

if (-not (Test-Path $venvPython)) {
    Write-Warn "未找到虚拟环境 $venvPython"
    Write-Host '    请先执行：python -m venv .venv' -ForegroundColor Gray
    exit 1
}

$node = Resolve-CommandPath -Name 'node' -Candidates @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
)
if (-not $node) {
    Write-Warn '未找到 node，请先安装 Node.js 20 或更高版本：https://nodejs.org/'
    exit 1
}
Write-Host "    python : $venvPython"
Write-Host "    node   : $node ($(& $node --version))"

$pnpm = Resolve-CommandPath -Name 'pnpm' -Candidates @(
    (Join-Path $root '.tools/pnpm/package/bin/pnpm.cjs')
)
if (-not $pnpm) {
    Write-Warn '未找到 pnpm，请先执行：corepack enable 或 npm i -g pnpm'
    exit 1
}

$cargo = Resolve-CommandPath -Name 'cargo' -Candidates @("$env:USERPROFILE\.cargo\bin\cargo.exe")
if (-not $WebOnly -and -not $ServerOnly -and -not $cargo) {
    Write-Warn '未找到 Rust（cargo）。Tauri 桌面窗口无法构建。'
    Write-Host '    安装方式：winget install Rustlang.Rustup' -ForegroundColor Gray
    Write-Host '    也可以改用 -WebOnly 在浏览器里开发界面。' -ForegroundColor Gray
    exit 1
}

# ---------------------------------------------------------------- 安装依赖

if (-not $SkipInstall) {
    Write-Step '安装 Python 依赖'
    Push-Location $root
    try {
        & $venvPython -m pip install --quiet -e 'packages/doc_engine' -e 'services/api[dev]'
        if ($LASTEXITCODE -ne 0) { throw 'pip install 失败' }
    } finally { Pop-Location }

    Write-Step '安装前端依赖'
    Push-Location $root
    try {
        if ($pnpm -like '*.cjs') { & $node $pnpm install --reporter=append-only }
        else { & $pnpm install --reporter=append-only }
        if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- 数据目录

if ($ResetData -and (Test-Path $dataDir)) {
    Write-Warn "清空本地开发数据目录 $dataDir"
    Remove-Item -Recurse -Force $dataDir
}
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# ---------------------------------------------------------------- 启动服务端

Write-Step "启动 FastAPI：$serverUrl（数据目录 $dataDir）"

$serverEnv = @{
    WORDWORK_DATA_DIR          = $dataDir
    WORDWORK_DATABASE_URL      = "sqlite:///$($dataDir -replace '\\','/')/wordwork.sqlite3"
    WORDWORK_DEV_ORIGINS       = 'http://localhost:5173,http://127.0.0.1:5173'
    PYTHONUNBUFFERED           = '1'
}
foreach ($key in $serverEnv.Keys) { Set-Item -Path "Env:$key" -Value $serverEnv[$key] }

$server = Start-Process -FilePath $venvPython `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--app-dir', $apiDir,
                    '--host', '127.0.0.1', '--port', $ServerPort, '--reload') `
    -WorkingDirectory $apiDir -NoNewWindow -PassThru

# 等服务端真正就绪，避免桌面端首屏连不上。
$ready = $false
foreach ($attempt in 1..30) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "$serverUrl/healthz" -TimeoutSec 2
        if ($health.status -eq 'ok') { $ready = $true; break }
    } catch { }
}
if (-not $ready) {
    Write-Warn "服务端在 $serverUrl 上没有响应，请查看上方 uvicorn 日志。"
} else {
    Write-Host "    服务端就绪，DOCX 引擎：$($health.engine_available)" -ForegroundColor Green
    Write-Host "    首次启动的演示账号：teacher / student1 / student2" -ForegroundColor Gray
    Write-Host "    演示密码：wordwork-demo-change-me（首次登录会要求改密码）" -ForegroundColor Gray
}

if ($ServerOnly) {
    Write-Step '仅服务端模式：Ctrl+C 结束'
    try { Wait-Process -Id $server.Id } finally { if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force } }
    exit 0
}

# ---------------------------------------------------------------- 启动桌面端

try {
    if ($WebOnly) {
        Write-Step '启动浏览器开发模式（http://localhost:5173）'
        Push-Location $desktopDir
        try {
            if ($pnpm -like '*.cjs') { & $node $pnpm dev } else { & $pnpm dev }
        } finally { Pop-Location }
    } else {
        Write-Step '启动 Tauri 桌面客户端'
        Push-Location $desktopDir
        try {
            if ($pnpm -like '*.cjs') { & $node $pnpm tauri dev } else { & $pnpm tauri dev }
        } finally { Pop-Location }
    }
} finally {
    if (-not $server.HasExited) {
        Write-Step '关闭 FastAPI'
        Stop-Process -Id $server.Id -Force
    }
}
