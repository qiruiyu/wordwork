<#
.SYNOPSIS
    卸载 wordwork：停掉并注销两个 Windows 服务。

.DESCRIPTION
    默认只拆「服务注册」「放行端口的防火墙规则」「本机对根证书的信任」这三样，
    数据目录（数据库、文档对象、备份、配置）原样留着 —— 想重装一遍直接跑
    install.ps1 就行，学生那边的账号和轮次都还在。

    要连数据一起删，必须显式加 -PurgeData。

    注销顺序是先 Caddy 后 API：Caddy 是对外的门面，先关掉它就不会有学生连着
    一半被切断。

.NOTES
    需要管理员权限（要停/注销服务、删防火墙规则、改本机信任库）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall.ps1

.EXAMPLE
    # 连数据目录一起删掉（会再确认一次）
    powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall.ps1 -PurgeData
#>
[CmdletBinding()]
param(
    [string]$DataDir = 'C:\ProgramData\wordwork',
    # 连同数据目录一起删除（数据库、文档对象、备份、配置）。默认不删。
    [switch]$PurgeData,
    # 删数据时不再问一次。
    [switch]$Force,
    # 保留放行对外端口的防火墙规则。
    [switch]$NoFirewall,
    # 保留已导入本机的根证书信任。
    [switch]$SkipLocalTrust
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

function Remove-WordworkService {
    param([string]$ServiceId, [string]$ExePath)

    $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Info "$ServiceId 本来就没注册，跳过。"
        return
    }

    if ($svc.Status -ne 'Stopped') {
        Write-Info "停止 $ServiceId ..."
        Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue
        try {
            (Get-Service -Name $ServiceId).WaitForStatus('Stopped', (New-TimeSpan -Seconds 30))
        } catch {
            Write-Warn "$ServiceId 没能在 30 秒内停下来，继续尝试注销。"
        }
    }

    # WinSW 自带的 uninstall：exe 和同名的 xml 都还在的时候最干净。
    $done = $false
    if ($ExePath -and (Test-Path -LiteralPath $ExePath)) {
        & $ExePath uninstall | Out-Null
        if ($LASTEXITCODE -eq 0) { $done = $true }
    }
    if (-not $done) {
        # 兜底：exe 已经不在数据目录里了（比如手工删过），直接用 SCM 注销。
        $null = & sc.exe delete $ServiceId
        if ($LASTEXITCODE -eq 0) { $done = $true }
    }

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }

    if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
        Write-Warn "$ServiceId 还挂在服务列表里，可能需要重启一次才会彻底消失。"
    } else {
        Write-Ok "$ServiceId 已注销"
    }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '本脚本需要管理员权限（要停/注销服务、删防火墙规则、改本机信任库）。' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 解析配置

$envPath = Join-Path $DataDir 'wordwork.env'
$conf = @{}
if (Test-Path -LiteralPath $envPath) {
    $conf = Read-EnvFile -Path $envPath
} else {
    Write-Warn "没找到 $envPath，只能用默认参数来拆。"
}

$dataRoot = Get-EnvValue -Map $conf -Key 'WORDWORK_DATA_DIR' -Default $DataDir
$dataRoot = $dataRoot -replace '/', '\'

$publicPort = Get-EnvValue -Map $conf -Key 'WORDWORK_PUBLIC_PORT' -Default '8443'
$caddyStore = Get-EnvValue -Map $conf -Key 'WORDWORK_CADDY_STORAGE' -Default (Join-Path $dataRoot 'caddy')
$caddyStore = $caddyStore -replace '/', '\'

$binDir = Join-Path $dataRoot 'bin'

Write-Step "卸载 wordwork（数据目录：$dataRoot）"

# ---------------------------------------------------------------- 1. 注销服务

Write-Step '停掉并注销服务'

# 先 Caddy 后 API：Caddy 是对外那扇门，先关掉就不会有学生被切在半路。
Remove-WordworkService -ServiceId 'wordwork-caddy' -ExePath (Join-Path $binDir 'wordwork-caddy.exe')
Remove-WordworkService -ServiceId 'wordwork-api'   -ExePath (Join-Path $binDir 'wordwork-api.exe')

$leftover = @(Get-Service -Name 'wordwork-api', 'wordwork-caddy' -ErrorAction SilentlyContinue)
if ($leftover.Count -gt 0) {
    Write-Host '还有服务没注销干净，先别删数据。' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 2. 防火墙

if (-not $NoFirewall) {
    Write-Step "收回对外端口 $publicPort 的放行规则"
    $ruleName = "wordwork HTTPS $publicPort"
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
        Remove-NetFirewallRule -DisplayName $ruleName
        Write-Ok "已删除防火墙规则「$ruleName」"
    } else {
        Write-Info '没有这条规则，跳过。'
    }
}

# ---------------------------------------------------------------- 3. 本机信任

if (-not $SkipLocalTrust) {
    $rootCrt = Join-Path $caddyStore 'pki\authorities\local\root.crt'
    if (Test-Path -LiteralPath $rootCrt) {
        Write-Step '撤掉本机对根证书的信任'
        $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($rootCrt)
        $caThumbprint = $cert.Thumbprint
        $removed = 0
        # install.ps1 装的是 LocalMachine；早先手工试证书时可能落在 CurrentUser，两个都查一遍。
        foreach ($loc in @('LocalMachine', 'CurrentUser')) {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', $loc)
            $store.Open('ReadWrite')
            foreach ($c in @($store.Certificates | Where-Object { $_.Thumbprint -eq $caThumbprint })) {
                $store.Remove($c)
                $removed++
                Write-Info "已从 $loc\Root 移除 $caThumbprint"
            }
            $store.Close()
        }
        if ($removed -eq 0) {
            Write-Info '本机信任库里没有这张根证书，跳过。'
        } else {
            Write-Ok "已撤掉 $removed 处信任"
        }
    } else {
        Write-Info '还没有根证书文件，跳过信任撤销。'
    }
}

# ---------------------------------------------------------------- 4. 数据

if ($PurgeData) {
    if (-not (Test-Path -LiteralPath $dataRoot)) {
        Write-Info "数据目录本来就不存在：$dataRoot"
    } else {
        Write-Step "删除数据目录 $dataRoot"
        Write-Warn '这里面的数据库、文档对象和备份会全部消失，删了没法撤。'
        $go = [bool]$Force
        if (-not $go) {
            $ans = Read-Host '确实要删吗？输入 yes 继续'
            $go = ($ans -eq 'yes')
        }
        if (-not $go) {
            Write-Info '没有删。'
        } else {
            Remove-Item -LiteralPath $dataRoot -Recurse -Force
            Write-Ok '数据目录已删除'
        }
    }
} else {
    Write-Step '数据目录保持原样'
    Write-Info $dataRoot
    Write-Info '数据库、文档对象、备份、配置都还在。要连数据一起删，加 -PurgeData。'
}

# ---------------------------------------------------------------- 收尾

Write-Host ''
Write-Ok '卸载完成'
if (-not $PurgeData) {
    Write-Info '想重新装回来：'
    Write-Info "  powershell -ExecutionPolicy Bypass -File scripts/windows/install.ps1"
}
