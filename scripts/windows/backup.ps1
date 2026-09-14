<#
.SYNOPSIS
    备份 wordwork 的数据目录：数据库 + 文档对象。

.DESCRIPTION
    数据库用 SQLite 自己的 backup API 复制，所以服务端正在跑也没关系；
    文档对象是按内容哈希存放且只增不删的，直接复制同样安全。

    产物长这样（一个时间戳一个目录，可以整体搬走）：
        <OutDir>\wordwork-20260913-032000\wordwork.sqlite3
        <OutDir>\wordwork-20260913-032000\objects\...
        <OutDir>\wordwork-20260913-032000\manifest.txt

.NOTES
    注册每日计划任务需要管理员权限；只做一次备份则不需要。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/windows/backup.ps1

.EXAMPLE
    # 注册成每天 03:20 自动备份，保留最近 14 份
    powershell -ExecutionPolicy Bypass -File scripts/windows/backup.ps1 -Register
#>
[CmdletBinding()]
param(
    [string]$DataDir = 'C:\ProgramData\wordwork',
    # 备份存放位置，默认 <数据目录>\backups。
    [string]$OutDir,
    # 保留最近多少份，超出的按时间从旧到新删掉。0 表示不清理。
    [int]$Keep = 14,
    # 注册成每天定时执行的计划任务。
    [switch]$Register
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Write-Info($m) { Write-Host "    $m" -ForegroundColor Gray }

function Read-EnvFile {
    param([string]$Path)
    $map = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $t = $line.Trim().TrimStart([char]0xFEFF)
        if (-not $t) { continue }
        if ($t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
    }
    return $map
}

function Get-EnvValue {
    param([hashtable]$Map, [string]$Key, [string]$Default = '')
    if ($Map.ContainsKey($Key) -and $Map[$Key]) { return $Map[$Key] }
    return $Default
}

# ---------------------------------------------------------------- 解析配置

$envPath = Join-Path $DataDir 'wordwork.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Host "找不到配置文件 $envPath —— 先运行 install.ps1。" -ForegroundColor Red
    exit 1
}
$conf = Read-EnvFile -Path $envPath

$dataRoot = Get-EnvValue -Map $conf -Key 'WORDWORK_DATA_DIR' -Default $DataDir
$dataRoot = $dataRoot -replace '/', '\'

$dbUrl = Get-EnvValue -Map $conf -Key 'WORDWORK_DATABASE_URL'
if (-not $dbUrl.StartsWith('sqlite:///')) {
    Write-Host "这个脚本只会备份 SQLite（当前是 $dbUrl）。" -ForegroundColor Red
    exit 1
}
# sqlite:///C:/... -> C:\...（顺带兼容误写成四个斜杠的情况）
$dbFile = $dbUrl.Substring('sqlite:///'.Length)
if ($dbFile -match '^/[A-Za-z]:') { $dbFile = $dbFile.Substring(1) }
$dbFile = $dbFile -replace '/', '\'

$venvPython = Join-Path $dataRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "找不到 $venvPython —— 先运行 install.ps1。" -ForegroundColor Red
    exit 1
}
$helper = Join-Path $PSScriptRoot 'backup_db.py'
if (-not (Test-Path -LiteralPath $helper)) {
    Write-Host "找不到 $helper。" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $dbFile)) {
    Write-Host "数据库还不存在：$dbFile" -ForegroundColor Red
    Write-Info '服务端还没启动过？先运行 install.ps1 把服务起起来。'
    exit 1
}

if (-not $OutDir) { $OutDir = Join-Path $dataRoot 'backups' }

# ---------------------------------------------------------------- 备份

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $OutDir "wordwork-$stamp"
New-Item -ItemType Directory -Force -Path $target | Out-Null

Write-Step "备份到 $target"

$dbTarget = Join-Path $target 'wordwork.sqlite3'
$dbOut = & $venvPython $helper backup $dbFile $dbTarget
$dbExit = $LASTEXITCODE
$dbHash = ''
if ($dbOut) { $dbHash = ([string]($dbOut | Select-Object -Last 1)).Trim() }
if ($dbExit -ne 0 -or -not $dbHash) {
    Write-Host '数据库备份失败。' -ForegroundColor Red
    Write-Info "可以直接试：$venvPython $helper backup `"$dbFile`" `"$dbTarget`""
    exit 1
}
$dbSize = (Get-Item -LiteralPath $dbTarget).Length
Write-Ok ("数据库 {0:N0} 字节  sha256={1}" -f $dbSize, $dbHash.Substring(0, 16))

$objectsSrc = Join-Path $dataRoot 'objects'
$objectCount = 0
if (Test-Path -LiteralPath $objectsSrc) {
    $objectsDst = Join-Path $target 'objects'
    $null = robocopy.exe $objectsSrc $objectsDst /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1
    if ($LASTEXITCODE -gt 7) {
        Write-Host "复制文档对象失败（robocopy 退出码 $LASTEXITCODE）。" -ForegroundColor Red
        exit 1
    }
    $objectCount = (Get-ChildItem -LiteralPath $objectsDst -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Ok "文档对象 $objectCount 个文件"
} else {
    Write-Warn "还没有 objects 目录，跳过（项目里应该还没上传过文档）。"
}

$engineHost = $env:COMPUTERNAME
$manifest = @(
    "备份时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "主机: $engineHost",
    "数据目录: $dataRoot",
    "数据库: $dbFile",
    "数据库 sha256: $dbHash",
    "数据库字节: $dbSize",
    "文档对象文件数: $objectCount"
)
[System.IO.File]::WriteAllLines((Join-Path $target 'manifest.txt'), $manifest, (New-Object System.Text.UTF8Encoding($true)))
Write-Ok 'manifest.txt 已写入'

# ---------------------------------------------------------------- 清理旧备份

if ($Keep -gt 0) {
    $all = Get-ChildItem -LiteralPath $OutDir -Directory -Filter 'wordwork-*' -ErrorAction SilentlyContinue |
        Sort-Object -Property Name -Descending
    $stale = @($all | Select-Object -Skip $Keep)
    if ($stale.Count -gt 0) {
        Write-Step "清理 $($stale.Count) 份旧备份（保留最近 $Keep 份）"
        foreach ($d in $stale) {
            Remove-Item -LiteralPath $d.FullName -Recurse -Force
            Write-Info "已删除 $($d.Name)"
        }
    }
}

# ---------------------------------------------------------------- 定时任务

if ($Register) {
    Write-Step '注册每日计划任务'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -DataDir `"$DataDir`" -Keep $Keep"
    $trigger = New-ScheduledTaskTrigger -Daily -At '03:20'
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName 'wordwork backup' -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-Ok '已注册计划任务「wordwork backup」，每天 03:20 执行'
    Write-Info "取消：Unregister-ScheduledTask -TaskName 'wordwork backup' -Confirm:`$false"
}

$totalBytes = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ''
Write-Ok ("完成：$target（共 {0:N1} MB）" -f ($totalBytes / 1MB))
Write-Info "恢复演练：powershell -File scripts/windows/restore.ps1 -BackupDir `"$target`""
