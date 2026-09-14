<#
.SYNOPSIS
    体检 wordwork 的 Windows 部署：服务、端口、证书、防火墙、电源、数据。

.DESCRIPTION
    只读检查，不改任何东西（唯一副作用是会连一下自己的 HTTPS，用来触发/验证证书）。

    输出是一份清单，每条标 OK / WARN / FAIL，最后给结论。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/windows/diagnose.ps1
#>
[CmdletBinding()]
param(
    [string]$DataDir = 'C:\ProgramData\wordwork'
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$script:results = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param([string]$Level, [string]$Name, [string]$Detail = '')
    $script:results.Add([pscustomobject]@{ Level = $Level; Name = $Name; Detail = $Detail })
    $colour = 'Gray'
    if ($Level -eq 'OK')   { $colour = 'Green' }
    if ($Level -eq 'WARN') { $colour = 'Yellow' }
    if ($Level -eq 'FAIL') { $colour = 'Red' }
    $tag = $Level.PadRight(4)
    if ($Detail) {
        Write-Host ("  [$tag] $Name") -ForegroundColor $colour
        Write-Host ("         $Detail") -ForegroundColor DarkGray
    } else {
        Write-Host ("  [$tag] $Name") -ForegroundColor $colour
    }
}

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

function Get-PowerAcIndex {
    param([string]$Subgroup, [string]$Setting)
    $out = & powercfg.exe /q SCHEME_CURRENT $Subgroup $Setting 2>$null
    $line = $out | Where-Object { $_ -match '0x[0-9a-fA-F]{8}' } | Select-Object -First 1
    if ($line -and $line -match '0x([0-9a-fA-F]{8})') { return [Convert]::ToInt64($matches[1], 16) }
    return -1
}

Write-Host ''
Write-Host 'wordwork Windows 部署体检' -ForegroundColor White
Write-Host "数据目录：$DataDir"
Write-Host ''

# ---------------------------------------------------------------- 配置

$envPath = Join-Path $DataDir 'wordwork.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    Add-Check 'FAIL' "配置文件 $envPath 不存在" '先运行 install.ps1。'
    exit 1
}
$conf = Read-EnvFile -Path $envPath

$dataRoot   = (Get-EnvValue -Map $conf -Key 'WORDWORK_DATA_DIR' -Default $DataDir) -replace '/', '\'
$publicHost = Get-EnvValue -Map $conf -Key 'WORDWORK_PUBLIC_HOST'
$lanHost    = Get-EnvValue -Map $conf -Key 'WORDWORK_LAN_HOST'
$publicPort = [int](Get-EnvValue -Map $conf -Key 'WORDWORK_PUBLIC_PORT' -Default '8443')
$apiPort    = [int](Get-EnvValue -Map $conf -Key 'WORDWORK_API_PORT' -Default '8000')

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Add-Check 'INFO' '当前是管理员权限'
} else {
    Add-Check 'INFO' '当前不是管理员权限' '部分检查（防火墙、证书存储）可能读不全。'
}

# ---------------------------------------------------------------- 服务

foreach ($svcName in @('wordwork-api', 'wordwork-caddy')) {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if (-not $svc) {
        Add-Check 'FAIL' "服务 $svcName 不存在" '运行 scripts/windows/install.ps1 注册它。'
        continue
    }
    if ($svc.Status -eq 'Running') {
        $startMode = (Get-CimInstance Win32_Service -Filter "Name='$svcName'" -ErrorAction SilentlyContinue).StartMode
        if ($startMode -eq 'Auto') {
            Add-Check 'OK' "服务 $svcName 正在运行，开机自启"
        } else {
            Add-Check 'WARN' "服务 $svcName 在运行，但启动类型是 $startMode" '重启后不会自动起来，建议重跑 install.ps1。'
        }
    } else {
        Add-Check 'FAIL' "服务 $svcName 没有运行（状态 $($svc.Status)）" "用 Start-Service $svcName 启动，然后看 $dataRoot\logs 里的日志。"
    }
}

# ---------------------------------------------------------------- 端口

$apiListen = Get-NetTCPConnection -LocalPort $apiPort -State Listen -ErrorAction SilentlyContinue
if ($apiListen) {
    $addresses = ($apiListen | Select-Object -ExpandProperty LocalAddress -Unique) -join ', '
    if ($addresses -match '0\.0\.0\.0|::') {
        Add-Check 'FAIL' "API 端口 $apiPort 正在全网卡监听（$addresses）" 'API 应该只监听 127.0.0.1，否则别人可以绕过 HTTPS 直接访问。'
    } else {
        Add-Check 'OK' "API 端口 $apiPort 只监听回环（$addresses）"
    }
} else {
    Add-Check 'FAIL' "API 端口 $apiPort 上没有监听" 'wordwork-api 没起来？'
}

$publicListen = Get-NetTCPConnection -LocalPort $publicPort -State Listen -ErrorAction SilentlyContinue
if ($publicListen) {
    $addresses = ($publicListen | Select-Object -ExpandProperty LocalAddress -Unique) -join ', '
    Add-Check 'OK' "对外端口 $publicPort 正在监听（$addresses）"
} else {
    Add-Check 'FAIL' "对外端口 $publicPort 上没有监听" 'wordwork-caddy 没起来？'
}

# ---------------------------------------------------------------- API 健康

$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/healthz" -TimeoutSec 5 -ErrorAction Stop
} catch { }

if ($health) {
    $engineOk = $false
    if ($health.PSObject.Properties.Name -contains 'engine_available') { $engineOk = [bool]$health.engine_available }
    $version = ''
    if ($health.PSObject.Properties.Name -contains 'version') { $version = [string]$health.version }
    if ($engineOk) {
        Add-Check 'OK' "API 正常（版本 $version，DOCX 引擎可用）"
    } else {
        Add-Check 'FAIL' "API 起来了但 engine_available=false（版本 $version）" 'DOCX 引擎没装好，上传会失败。重跑 install.ps1（不要加 -SkipDeps）。'
    }
} else {
    Add-Check 'FAIL' "http://127.0.0.1:$apiPort/healthz 没有响应"
}

# ---------------------------------------------------------------- 证书

$rootCrt = Join-Path $dataRoot 'caddy\pki\authorities\local\root.crt'
$rootCert = $null
if (Test-Path -LiteralPath $rootCrt) {
    $rootCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($rootCrt)
    $daysLeft = [int]($rootCert.NotAfter - (Get-Date)).TotalDays
    if ($daysLeft -lt 30) {
        Add-Check 'WARN' "根证书还有 $daysLeft 天到期" '到期后所有学生都要重装根证书。重新签发会生成新的根证书。'
    } else {
        Add-Check 'OK' "根证书有效（到 $($rootCert.NotAfter.ToString('yyyy-MM-dd'))，还有 $daysLeft 天）" "指纹 $($rootCert.Thumbprint)"
    }

    $trustedLocal = Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($rootCert.Thumbprint)"
    $trustedUser  = Test-Path -LiteralPath "Cert:\CurrentUser\Root\$($rootCert.Thumbprint)"
    if ($trustedLocal -or $trustedUser) {
        Add-Check 'OK' '本机已信任这张根证书'
    } else {
        Add-Check 'WARN' '本机还没信任这张根证书' '本机客户端走 http://127.0.0.1 不受影响；但你要用 https://127.0.0.1 验证就会报证书错。运行 export-ca.ps1 -InstallLocal。'
    }

    # 证书 SAN 是否覆盖了配置里对外公布的两个地址
    $leaf = Join-Path $dataRoot "caddy\certificates\local\$lanHost\$lanHost.crt"
    if (Test-Path -LiteralPath $leaf) {
        $leafCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($leaf)
        $san = ($leafCert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join '; '
        if ($san -match [regex]::Escape($lanHost)) {
            Add-Check 'OK' "证书 SAN 覆盖局域网地址 $lanHost"
        } else {
            Add-Check 'FAIL' "证书 SAN 不含 $lanHost" "当前 SAN：$san"
        }
    } else {
        Add-Check 'WARN' "还没看到 $lanHost 对应的证书" '如果局域网学生连不上，先重跑 install.ps1。'
    }
} else {
    Add-Check 'WARN' "还没生成根证书：$rootCrt" 'Caddy 要等第一次客户端连接才会签发。运行 export-ca.ps1 会代为触发。'
}

# HTTPS 全链路（正常校验证书）
$httpsOk = $false
try {
    $r = Invoke-RestMethod -Uri "https://127.0.0.1:$publicPort/healthz" -TimeoutSec 5 -ErrorAction Stop
    $httpsOk = $true
} catch {
    $msg = $_.Exception.Message
    Add-Check 'FAIL' "https://127.0.0.1:$publicPort/healthz 失败" "$msg"
}
if ($httpsOk) {
    Add-Check 'OK' "HTTPS 全链路正常（https://127.0.0.1:$publicPort）—— 学生走的就是这条路"
}

# ---------------------------------------------------------------- 防火墙

$fw = Get-NetFirewallRule -DisplayName "wordwork HTTPS $publicPort" -ErrorAction SilentlyContinue
if ($fw) {
    $enabled = ($fw | Select-Object -First 1).Enabled
    if ($enabled -eq 'True') {
        Add-Check 'OK' "防火墙已放行 TCP $publicPort"
    } else {
        Add-Check 'WARN' "防火墙规则存在但被禁用了（TCP $publicPort）"
    }
} else {
    Add-Check 'WARN' "没有找到 TCP $publicPort 的防火墙规则" '外网学生可能连不上。重跑 install.ps1，或手动 New-NetFirewallRule。'
}

# ---------------------------------------------------------------- 电源

$standby = Get-PowerAcIndex -Subgroup 'SUB_SLEEP' -Setting 'STANDBYIDLE'
$hib     = Get-PowerAcIndex -Subgroup 'SUB_SLEEP' -Setting 'HIBERNATEIDLE'
if ($standby -eq 0 -and $hib -eq 0) {
    Add-Check 'OK' '接通电源时不会自动睡眠/休眠'
} elseif ($standby -lt 0) {
    Add-Check 'INFO' '电源设置读不出来，请自己到「电源和睡眠」里确认没开自动睡眠'
} else {
    $s = if ($standby -gt 0) { "$([int]($standby/60)) 分钟" } else { '从不' }
    $h = if ($hib -gt 0) { "$([int]($hib/60)) 分钟" } else { '从不' }
    Add-Check 'WARN' "接通电源时：睡眠 $s、休眠 $h" '机器睡着时学生连不上。运行 install.ps1（不加 -NoPowerTune）可以关掉。'
}
Add-Check 'INFO' 'Windows 更新自动重启' '服务是开机自启的，重启后会自己回来；但正在写文档的人会断开。建议在「活动时间」里避开工作时段。'

# ---------------------------------------------------------------- 数据

$dbUrl = Get-EnvValue -Map $conf -Key 'WORDWORK_DATABASE_URL'
$dbFile = $null
if ($dbUrl.StartsWith('sqlite:///')) {
    $dbFile = $dbUrl.Substring('sqlite:///'.Length)
    if ($dbFile -match '^/[A-Za-z]:') { $dbFile = $dbFile.Substring(1) }
    $dbFile = $dbFile -replace '/', '\'
}
if ($dbFile -and (Test-Path -LiteralPath $dbFile)) {
    $size = (Get-Item -LiteralPath $dbFile).Length
    Add-Check 'OK' ("数据库 {0:N0} 字节：$dbFile" -f $size)
} else {
    Add-Check 'FAIL' "数据库不存在：$dbFile" '服务端没成功启动过。'
}

$objectsDir = Join-Path $dataRoot 'objects'
if (Test-Path -LiteralPath $objectsDir) {
    $count = (Get-ChildItem -LiteralPath $objectsDir -Recurse -File -ErrorAction SilentlyContinue).Count
    Add-Check 'OK' "文档对象 $count 个文件"
} else {
    Add-Check 'INFO' '还没有 objects 目录' '应该还没上传过文档。'
}

$backupDir = Join-Path $dataRoot 'backups'
if (Test-Path -LiteralPath $backupDir) {
    $latest = Get-ChildItem -LiteralPath $backupDir -Directory -Filter 'wordwork-*' -ErrorAction SilentlyContinue |
        Sort-Object -Property Name -Descending | Select-Object -First 1
    if ($latest) {
        $age = [int]((Get-Date) - $latest.LastWriteTime).TotalDays
        if ($age -le 3) {
            Add-Check 'OK' "最近一次备份：$($latest.Name)（$age 天前）"
        } else {
            Add-Check 'WARN' "最近一次备份在 $age 天前（$($latest.Name)）" '跑一下 backup.ps1 -Register 让它每天自动备份。'
        }
    } else {
        Add-Check 'WARN' '还没有任何备份' '跑一下 scripts/windows/backup.ps1 -Register。'
    }
} else {
    Add-Check 'WARN' '还没有备份目录' '跑一下 scripts/windows/backup.ps1 -Register。'
}

$drive = (Get-Item -LiteralPath $dataRoot).PSDrive
if ($drive) {
    $free = (Get-PSDrive -Name $drive.Name).Free
    Add-Check 'INFO' ("数据盘剩余 {0:N1} GB" -f ($free / 1GB))
}

# ---------------------------------------------------------------- 地址与网络

if ($publicHost -eq '1.2.3.4' -or -not $publicHost) {
    Add-Check 'WARN' 'WORDWORK_PUBLIC_HOST 还是占位符' '学生在外网连不上。填上公网 IP 后重跑 install.ps1。'
}

$cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
if ($cfg) {
    $currentLan = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
    if ($currentLan -eq $lanHost) {
        Add-Check 'OK' "局域网地址与配置一致（$lanHost）"
    } else {
        Add-Check 'FAIL' "这台机器的局域网地址是 $currentLan，配置里写的是 $lanHost" '地址变了。局域网学生连不上；重跑 install.ps1 会更新，另外建议在路由器上做 DHCP 静态绑定。'
    }
} else {
    Add-Check 'WARN' '没找到有默认网关的网卡' '网络可能没连上。'
}

# 出口公网 IP 对比（best-effort，境内优先用 ipip）
$egress = $null
foreach ($endpoint in @('https://myip.ipip.net', 'https://api.ipify.org')) {
    try {
        $raw = (Invoke-WebRequest -Uri $endpoint -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop).Content
        if ($raw -match '(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})') { $egress = $matches[1]; break }
    } catch { }
}
if ($egress) {
    if ($egress -eq $publicHost) {
        Add-Check 'OK' "出口公网 IP 与配置一致（$egress）"
    } else {
        Add-Check 'WARN' "这台机器当前出口公网 IP 是 $egress，配置里写的是 $publicHost" '如果对不上，可能你拿到的是运营商的大内网地址（CGNAT），外网学生根本进不来。请登到路由器看 WAN 口地址确认；必要时找运营商要公网 IP，或改用内网穿透。'
    }
} else {
    Add-Check 'INFO' '读不到出口公网 IP' '不影响本机使用，但没法自动核对公网地址是否正确。'
}

Add-Check 'INFO' '外网可达性只能从外面测' "让一个学生用 4G/热点跑：Test-NetConnection $publicHost -Port $publicPort。通了才算真的对外开放。"

# ---------------------------------------------------------------- 结论

$fails = @($script:results | Where-Object { $_.Level -eq 'FAIL' }).Count
$warns = @($script:results | Where-Object { $_.Level -eq 'WARN' }).Count

Write-Host ''
Write-Host ('-' * 56)
if ($fails -gt 0) {
    Write-Host "结论：$fails 项失败、$warns 项警告 —— 先修失败项。" -ForegroundColor Red
} elseif ($warns -gt 0) {
    Write-Host "结论：没有失败项，有 $warns 项警告，多数情况下能正常用。" -ForegroundColor Yellow
} else {
    Write-Host '结论：全部通过。' -ForegroundColor Green
}
Write-Host ''
