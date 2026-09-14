<#
.SYNOPSIS
    导出 wordwork 的根证书，学生的机器要装它一次才连得上。

.DESCRIPTION
    因为没有域名，Caddy 用的是自建 CA。它签出来的证书要能被学生机器信任，
    就得把这张根证书装进学生机器的「受信任的根证书颁发机构」。

    这张根证书有效期约 10 年，所以学生装一次就行，不用每年折腾。

.NOTES
    只导出不需要管理员权限；用 -InstallLocal 装进本机信任库才需要。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/windows/export-ca.ps1

.EXAMPLE
    # 顺便装进本机信任库，装完你自己就能用 https://127.0.0.1:8443 验证
    powershell -ExecutionPolicy Bypass -File scripts/windows/export-ca.ps1 -InstallLocal
#>
[CmdletBinding()]
param(
    [string]$DataDir = 'C:\ProgramData\wordwork',
    # 导出到哪里，默认 <数据目录>\wordwork-root-ca.crt。
    [string]$OutFile,
    # 装进本机「受信任的根证书颁发机构」（需要管理员权限）。
    [switch]$InstallLocal,
    # 已存在时覆盖。
    [switch]$Force
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

function Test-HttpsInsecure {
    param([string]$Url)
    # Caddy 要等第一次有客户端连接才把证书签出来，这里就是去戳它一下。
    $prev = [Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        $null = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return $true
    } catch {
        return $false
    } finally {
        [Net.ServicePointManager]::ServerCertificateValidationCallback = $prev
    }
}

# ---------------------------------------------------------------- 找根证书

$envPath = Join-Path $DataDir 'wordwork.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Host "找不到配置文件 $envPath —— 先运行 install.ps1。" -ForegroundColor Red
    exit 1
}
$conf = Read-EnvFile -Path $envPath

$dataRoot = Get-EnvValue -Map $conf -Key 'WORDWORK_DATA_DIR' -Default $DataDir
$dataRoot = $dataRoot -replace '/', '\'
$rootCrt = Join-Path $dataRoot 'caddy\pki\authorities\local\root.crt'
$publicPort = Get-EnvValue -Map $conf -Key 'WORDWORK_PUBLIC_PORT' -Default '8443'
$publicHost = Get-EnvValue -Map $conf -Key 'WORDWORK_PUBLIC_HOST'
$lanHost = Get-EnvValue -Map $conf -Key 'WORDWORK_LAN_HOST'

if (-not (Test-Path -LiteralPath $rootCrt)) {
    Write-Step '根证书还没生成，先去触发一次签发'
    $null = Test-HttpsInsecure -Url "https://127.0.0.1:$publicPort/healthz"
    $deadline = (Get-Date).AddSeconds(45)
    while (((Get-Date) -lt $deadline) -and (-not (Test-Path -LiteralPath $rootCrt))) {
        Start-Sleep -Milliseconds 500
    }
}
if (-not (Test-Path -LiteralPath $rootCrt)) {
    Write-Host "还是没找到根证书：$rootCrt" -ForegroundColor Red
    Write-Info '确认 wordwork-caddy 服务在跑（Get-Service wordwork-caddy），再看 C:\ProgramData\wordwork\logs。'
    exit 1
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($rootCrt)

# ---------------------------------------------------------------- 导出

if (-not $OutFile) { $OutFile = Join-Path $dataRoot 'wordwork-root-ca.crt' }
if ((Test-Path -LiteralPath $OutFile) -and (-not $Force)) {
    $existing = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($OutFile)
    if ($existing.Thumbprint -eq $cert.Thumbprint) {
        Write-Ok "已经导出过了：$OutFile"
    } else {
        Write-Warn "$OutFile 已存在且不是同一张证书，用 -Force 覆盖。"
        exit 1
    }
} else {
    Copy-Item -LiteralPath $rootCrt -Destination $OutFile -Force
    Write-Ok "已导出：$OutFile"
}

Write-Host ''
Write-Host '    根证书信息（请把指纹抄下来，当面或电话念给学生核对）：' -ForegroundColor White
Write-Host "        主题  ：$($cert.Subject)"
Write-Host "        指纹  ：$($cert.Thumbprint)" -ForegroundColor Yellow
Write-Host "        有效期：$($cert.NotBefore.ToString('yyyy-MM-dd')) → $($cert.NotAfter.ToString('yyyy-MM-dd'))"

# ---------------------------------------------------------------- 本机信任

if ($InstallLocal) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Warn '-InstallLocal 需要管理员权限，这次跳过。'
    } elseif (Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($cert.Thumbprint)") {
        Write-Ok '本机已经信任这张根证书了'
    } else {
        Import-Certificate -FilePath $rootCrt -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
        Write-Ok '已装进本机「受信任的根证书颁发机构」'
    }
}

# ---------------------------------------------------------------- 学生怎么装

Write-Host ''
Write-Host '    把 wordwork-root-ca.crt 发给学生（U 盘、群文件都行），然后照下面装：' -ForegroundColor White
Write-Host ''
Write-Host '    Windows：' -ForegroundColor Cyan
Write-Host '        双击这个 .crt → 安装证书 → 存储位置选「本地计算机」→'
Write-Host '        将所有证书放入下列存储 → 受信任的根证书颁发机构 → 完成'
Write-Host '        或者用管理员 PowerShell 一条命令：'
Write-Host '            certutil -addstore -f Root wordwork-root-ca.crt' -ForegroundColor Gray
Write-Host ''
Write-Host '    macOS：' -ForegroundColor Cyan
Write-Host '        双击导入「钥匙串访问」，找到这张证书，双击把「使用此证书时」设为「始终信任」'
Write-Host ''
Write-Host '    iPhone / iPad：' -ForegroundColor Cyan
Write-Host '        把 .crt 用微信/邮件发到手机 → 设置 → 通用 → VPN与设备管理 → 安装'
Write-Host '        再到 设置 → 通用 → 关于本机 → 证书信任设置 → 把这张证书的开关打开'
Write-Host ''
Write-Host '    Android：' -ForegroundColor Cyan
Write-Host '        设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书'
Write-Host '        （注意：Android 上只有浏览器会信用户装的 CA，App 不一定信，'
Write-Host '          所以 Android 学生建议用电脑客户端）'
Write-Host ''
Write-Host '    装完之后，客户端里填的地址：' -ForegroundColor White
Write-Host "        外网   ：https://${publicHost}:$publicPort" -ForegroundColor White
Write-Host "        局域网 ：https://${lanHost}:$publicPort" -ForegroundColor White
Write-Host ''
Write-Info '这张根证书等于你服务器的身份证：谁拿到它就能冒充你的服务器。'
Write-Info '所以别发到公开群里，学生装之前让他们核对一下上面的指纹。'
