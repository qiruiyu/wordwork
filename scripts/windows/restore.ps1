<#
.SYNOPSIS
    从备份恢复 wordwork 的数据（数据库 + 文档对象）。

.DESCRIPTION
    恢复前会先校验备份的完整性，并把现有数据整体挪到 <名字>.pre-restore-<时间戳>
    而不是删掉 —— 万一恢复错了还能退回来。

    恢复的过程会短暂停掉 API 服务（Caddy 不用停，它不碰数据文件）。

.NOTES
    需要管理员权限（要停/启服务）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/windows/restore.ps1 -BackupDir C:\ProgramData\wordwork\backups\wordwork-20260913-032000
#>
[CmdletBinding()]
param(
    # backup.ps1 生成的那个时间戳目录。
    [Parameter(Mandatory = $true)][string]$BackupDir,
    [string]$DataDir = 'C:\ProgramData\wordwork',
    # 目标位置已有数据时，必须显式加 -Force 才覆盖（原数据会先挪走，不会丢）。
    [switch]$Force,
    # 跳过 SQLite 完整性校验。不建议用。
    [switch]$SkipVerify
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

function Wait-HttpOk {
    param([string]$Url, [int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri $Url -TimeoutSec 3 -ErrorAction Stop
            if ($r -and ($r.PSObject.Properties.Name -contains 'status') -and ($r.status -eq 'ok')) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ---------------------------------------------------------------- 解析配置与备份

$envPath = Join-Path $DataDir 'wordwork.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Host "找不到配置文件 $envPath。" -ForegroundColor Red
    exit 1
}
$conf = Read-EnvFile -Path $envPath

$dataRoot = Get-EnvValue -Map $conf -Key 'WORDWORK_DATA_DIR' -Default $DataDir
$dataRoot = $dataRoot -replace '/', '\'

$dbUrl = Get-EnvValue -Map $conf -Key 'WORDWORK_DATABASE_URL'
if (-not $dbUrl.StartsWith('sqlite:///')) {
    Write-Host "这个脚本只支持 SQLite（当前是 $dbUrl）。" -ForegroundColor Red
    exit 1
}
$dbFile = $dbUrl.Substring('sqlite:///'.Length)
if ($dbFile -match '^/[A-Za-z]:') { $dbFile = $dbFile.Substring(1) }
$dbFile = $dbFile -replace '/', '\'

$venvPython = Join-Path $dataRoot 'venv\Scripts\python.exe'
$helper = Join-Path $PSScriptRoot 'backup_db.py'
foreach ($p in @($venvPython, $helper)) {
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Host "找不到 $p。" -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $BackupDir)) {
    Write-Host "备份目录不存在：$BackupDir" -ForegroundColor Red
    exit 1
}
$srcDb = Join-Path $BackupDir 'wordwork.sqlite3'
if (-not (Test-Path -LiteralPath $srcDb)) {
    Write-Host "这个目录里没有 wordwork.sqlite3，不像是 backup.ps1 的产物：$BackupDir" -ForegroundColor Red
    exit 1
}
$srcObjects = Join-Path $BackupDir 'objects'

Write-Step "备份来源：$BackupDir"

# ---------------------------------------------------------------- 校验

if (-not $SkipVerify) {
    $verifyOut = & $venvPython $helper verify $srcDb
    $verifyExit = $LASTEXITCODE
    $verdict = ''
    if ($verifyOut) { $verdict = ([string]($verifyOut | Select-Object -Last 1)).Trim() }
    if ($verifyExit -ne 0 -or $verdict -ne 'ok') {
        Write-Host "备份里的数据库没通过完整性校验（integrity_check = $verdict）。" -ForegroundColor Red
        Write-Info '换一份备份，或者确认没问题后加 -SkipVerify 强行恢复。'
        exit 1
    }
    Write-Ok '完整性校验通过'

    $manifestPath = Join-Path $BackupDir 'manifest.txt'
    if (Test-Path -LiteralPath $manifestPath) {
        $expectedLine = Get-Content -LiteralPath $manifestPath | Where-Object { $_ -like '数据库 sha256:*' } | Select-Object -First 1
        if ($expectedLine) {
            $expected = $expectedLine.Substring($expectedLine.IndexOf(':') + 1).Trim()
            $hashOut = & $venvPython $helper hash $srcDb
            $actual = ''
            if ($hashOut) { $actual = ([string]($hashOut | Select-Object -Last 1)).Trim() }
            if ($expected -ne $actual) {
                Write-Host '备份的文件内容和 manifest.txt 里记的 sha256 对不上 —— 备份可能损坏或被改过。' -ForegroundColor Red
                exit 1
            }
            Write-Ok 'sha256 与 manifest 一致'
        }
    } else {
        Write-Warn '没有 manifest.txt，跳过 sha256 比对。'
    }
} else {
    Write-Warn '按 -SkipVerify 跳过了校验。'
}

# ---------------------------------------------------------------- 停服务

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$svc = Get-Service -Name 'wordwork-api' -ErrorAction SilentlyContinue
# 只有确实要停/启服务时才需要管理员；install.ps1 -NoServices 装的部署可以直接恢复。
if ($svc -and -not $isAdmin) {
    Write-Host '本脚本需要管理员权限（要停/启 wordwork-api 服务）。' -ForegroundColor Red
    exit 1
}
if ($svc -and $svc.Status -ne 'Stopped') {
    Write-Step '停止 wordwork-api'
    Stop-Service -Name 'wordwork-api' -Force
    (Get-Service -Name 'wordwork-api').WaitForStatus('Stopped', (New-TimeSpan -Seconds 30))
    Write-Ok '已停止'
}

# ---------------------------------------------------------------- 挪开现有数据

$dbExists = Test-Path -LiteralPath $dbFile
$objectsDir = Join-Path $dataRoot 'objects'
$objectsExist = Test-Path -LiteralPath $objectsDir

if (($dbExists -or $objectsExist) -and (-not $Force)) {
    Write-Host '目标位置已经有数据了。确实要覆盖请加 -Force。' -ForegroundColor Yellow
    Write-Info "现有数据库：$dbFile"
    Write-Info "现有对象目录：$objectsDir"
    Write-Info '加了 -Force 之后，现有数据会被挪到 .pre-restore-<时间戳>，不会直接删掉。'
    if ($svc) { Write-Info '（服务已停，记得手动 Start-Service wordwork-api）' }
    exit 1
}

if ($Force) {
    Write-Step '把现有数据挪到 .pre-restore 旁边'
    if ($dbExists) {
        foreach ($suffix in @('', '-wal', '-shm')) {
            $f = "$dbFile$suffix"
            if (Test-Path -LiteralPath $f) {
                $moved = "$f.pre-restore-$stamp"
                Move-Item -LiteralPath $f -Destination $moved -Force
                Write-Info "-> $(Split-Path -Leaf $moved)"
            }
        }
    }
    if ($objectsExist) {
        $moved = "$objectsDir.pre-restore-$stamp"
        Move-Item -LiteralPath $objectsDir -Destination $moved -Force
        Write-Info "-> $(Split-Path -Leaf $moved)"
    }
}

# ---------------------------------------------------------------- 恢复

Write-Step '恢复数据库'
$dbDir = Split-Path -Parent $dbFile
New-Item -ItemType Directory -Force -Path $dbDir | Out-Null
Copy-Item -LiteralPath $srcDb -Destination $dbFile -Force
Write-Ok "已写入 $dbFile"

if (Test-Path -LiteralPath $srcObjects) {
    Write-Step '恢复文档对象'
    New-Item -ItemType Directory -Force -Path $objectsDir | Out-Null
    $null = robocopy.exe $srcObjects $objectsDir /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1
    if ($LASTEXITCODE -gt 7) {
        Write-Host "复制文档对象失败（robocopy 退出码 $LASTEXITCODE）。" -ForegroundColor Red
        exit 1
    }
    $count = (Get-ChildItem -LiteralPath $objectsDir -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Ok "文档对象 $count 个文件"
} else {
    Write-Warn '这份备份里没有 objects 目录，只恢复数据库。'
}

# ---------------------------------------------------------------- 起服务并验证

if ($svc) {
    Write-Step '启动 wordwork-api'
    Start-Service -Name 'wordwork-api'
    $apiPort = Get-EnvValue -Map $conf -Key 'WORDWORK_API_PORT' -Default '8000'
    if (Wait-HttpOk -Url "http://127.0.0.1:$apiPort/healthz" -Seconds 60) {
        Write-Ok "服务已恢复：http://127.0.0.1:$apiPort/healthz"
    } else {
        Write-Host '服务起来了但 /healthz 没响应，去看日志：' -ForegroundColor Yellow
        Write-Info (Join-Path $dataRoot 'logs')
        exit 1
    }
}

Write-Host ''
Write-Ok '恢复完成'
if ($Force) {
    Write-Info "恢复前的数据还留着：$dbFile.pre-restore-$stamp"
    Write-Info '确认没问题后再自己删掉它们。'
}
Write-Info '提醒：会话记录存在数据库里，恢复旧备份会把恢复点之后的登录状态一起回退，学生需要重新登录。'
