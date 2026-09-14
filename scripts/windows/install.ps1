<#
.SYNOPSIS
    把 wordwork 装成两个 Windows 开机自启服务：API（只监听回环）+ Caddy（对外 HTTPS）。

.DESCRIPTION
    依次完成：
      1. 生成 / 读取 C:\ProgramData\wordwork\wordwork.env
      2. 准备 caddy.exe 与 WinSW（优先用本机已装的，其次 winget 装）
      3. 建部署用的虚拟环境并安装 Python 依赖
      4. 生成 Caddyfile 与两个服务定义，注册并启动服务
      5. 放行对外端口的防火墙规则、关掉休眠、把根证书装进本机信任库

    对外只有 Caddy 的端口是开着的；API 走 127.0.0.1，外面碰不到。

.NOTES
    需要管理员权限。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/windows/install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/windows/install.ps1 -PublicHost 203.0.113.10
#>
[CmdletBinding()]
param(
    # 数据目录：数据库、文档、日志、证书都在它下面。
    [string]$DataDir = 'C:\ProgramData\wordwork',
    # 仓库根目录。默认从脚本位置往上推两层。
    [string]$RepoRoot,
    # 公网 IP（或域名）。不给就沿用配置文件里的值；配置里还是占位符就会问你。
    [string]$PublicHost,
    # 局域网 IP。不给就自动探测当前有默认网关的那张网卡。
    [string]$LanHost,
    # 对外端口。大陆家宽普遍封 80/443，所以默认 8443。
    [int]$PublicPort = 8443,
    # API 监听的回环端口，不对外。
    [int]$ApiPort = 8000,
    # 离线安装用：把 caddy.exe、winsw.exe 放进这个目录就能跳过 winget。
    [string]$BinDir,
    # pip 源，例如 https://pypi.tuna.tsinghua.edu.cn/simple
    [string]$PipIndexUrl,
    # 用来创建部署虚拟环境的 Python 3.12+。不填就自动找一个。
    [string]$BasePython,
    # 跳过依赖安装（依赖已经装好时更快）。
    [switch]$SkipDeps,
    # 只准备好文件和环境，不注册 Windows 服务，因此不需要管理员权限。
    # 适合先试跑一遍，或者你想用别的方式托管进程。
    [switch]$NoServices,
    # 不把根证书装进本机信任库。
    [switch]$SkipLocalTrust,
    # 不加防火墙规则。
    [switch]$NoFirewall,
    # 不改电源设置（不关休眠）。
    [switch]$NoPowerTune,
    # 服务已存在时覆盖它。会先停掉旧服务再重新注册。
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message)   { Write-Host "    $message" -ForegroundColor Green }
function Write-Warn($message) { Write-Host "!!  $message" -ForegroundColor Yellow }
function Write-Info($message) { Write-Host "    $message" -ForegroundColor Gray }

function Write-Fail($message) { Write-Host "`n$message" -ForegroundColor Red }

# ---------------------------------------------------------------- 通用小工具

function Get-RepoRoot {
    param([string]$Override)
    if ($Override) { return (Resolve-Path -LiteralPath $Override).Path }
    # $PSScriptRoot = <repo>\scripts\windows
    return (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}

function Read-EnvFile {
    param([string]$Path)

    $map = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $t = $line.Trim()
        $t = $t.TrimStart([char]0xFEFF)          # 去掉可能的 UTF-8 BOM
        if (-not $t) { continue }
        if ($t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
    }
    return $map
}

function Set-EnvValue {
    param([string]$Path, [string]$Key, [string]$Value)

    $lines = [System.IO.File]::ReadAllLines($Path)
    $out = New-Object System.Collections.Generic.List[string]
    $done = $false
    foreach ($line in $lines) {
        $t = $line.Trim()
        if ((-not $done) -and $t -and (-not $t.StartsWith('#')) -and $t.StartsWith("$Key=")) {
            $out.Add("$Key=$Value")
            $done = $true
        } else {
            $out.Add($line)
        }
    }
    if (-not $done) { $out.Add("$Key=$Value") }
    [System.IO.File]::WriteAllLines($Path, $out, (New-Object System.Text.UTF8Encoding($true)))
}

function Get-EnvValue {
    param([hashtable]$Map, [string]$Key, [string]$Default = '')
    if ($Map.ContainsKey($Key) -and $Map[$Key]) { return $Map[$Key] }
    return $Default
}

function XmlEsc {
    param([string]$s)
    if ($null -eq $s) { return '' }
    return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

function Get-LanIp {
    # 取有默认网关、且已启用的网卡，这样能避开 VMware / 虚拟网卡。
    $cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPv4DefaultGateway -ne $null -and
            $_.NetAdapter -ne $null -and
            $_.NetAdapter.Status -eq 'Up' -and
            $_.IPv4Address -ne $null
        } | Select-Object -First 1
    if ($cfg) { return ($cfg.IPv4Address | Select-Object -First 1).IPAddress }
    return ''
}

function Get-PythonVersion {
    # 返回 "3.12" 这样的主次版本号；拿不到就返回空串。
    param([string]$Exe, [string[]]$PrefixArgs = @())
    $out = $null
    try {
        $out = & $Exe @PrefixArgs -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    } catch {
        return ''
    }
    if ($LASTEXITCODE -ne 0 -or -not $out) { return '' }
    return ([string]($out | Select-Object -Last 1)).Trim()
}

function Test-PythonSupported {
    param([string]$Version)
    if (-not $Version) { return $false }
    $parts = $Version.Split('.')
    if ($parts.Count -lt 2) { return $false }
    return (([int]$parts[0] -eq 3) -and ([int]$parts[1] -ge 12))
}

function Find-BasePython {
    # 找一个 Python 3.12+（DOCX 引擎要求）。返回 @{Exe;Args;Version}，找不到返回 $null。
    param([string]$Override, [string]$RepoRoot)

    $candidates = New-Object System.Collections.Generic.List[object]

    if ($Override) { $candidates.Add(@{ Exe = $Override; Args = @(); Note = '-BasePython' }) }

    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        $candidates.Add(@{ Exe = $py.Source; Args = @('-3.12'); Note = 'py -3.12' })
        $candidates.Add(@{ Exe = $py.Source; Args = @('-3'); Note = 'py -3' })
    }

    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates.Add(@{ Exe = $cmd.Source; Args = @(); Note = 'PATH 里的 python.exe' }) }

    foreach ($dir in @('Python312', 'Python313', 'Python314')) {
        foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Programs\Python'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if (-not $root) { continue }
            $guess = Join-Path (Join-Path $root $dir) 'python.exe'
            if (Test-Path -LiteralPath $guess) { $candidates.Add(@{ Exe = $guess; Args = @(); Note = $guess }) }
        }
    }

    # 最后兜底：仓库里现成的开发虚拟环境（可能正好是 3.12）。
    if ($RepoRoot) {
        $repoVenv = Join-Path $RepoRoot '.venv\Scripts\python.exe'
        if (Test-Path -LiteralPath $repoVenv) { $candidates.Add(@{ Exe = $repoVenv; Args = @(); Note = $repoVenv }) }
    }

    foreach ($c in $candidates) {
        $ver = Get-PythonVersion -Exe $c.Exe -PrefixArgs $c.Args
        if (Test-PythonSupported -Version $ver) {
            $c['Version'] = $ver
            return $c
        }
    }
    return $null
}

function New-RandomPassword {
    # 服务端要求至少 12 位。这里生成 24 位，去掉容易看错的字符。
    $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $chars = New-Object char[] 24
    for ($i = 0; $i -lt 24; $i++) { $chars[$i] = $alphabet[$bytes[$i] % $alphabet.Length] }
    return (-join $chars)
}

function Find-Tool {
    param([string]$Name, [string]$BinDir, [string]$WingetId, [string]$FallbackDir)

    if ($BinDir) {
        foreach ($candidate in @($Name, "$Name.exe")) {
            $p = Join-Path $BinDir $candidate
            if (Test-Path -LiteralPath $p) { return (Resolve-Path -LiteralPath $p).Path }
        }
    }

    if ($FallbackDir) {
        $p = Join-Path $FallbackDir "$Name.exe"
        if (Test-Path -LiteralPath $p) { return (Resolve-Path -LiteralPath $p).Path }
    }

    $found = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "$Name.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    if ($found) { return $found }

    $cmd = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        Write-Fail "找不到 $Name.exe，本机也没有 winget。"
        Write-Info "请手动下载 $Name.exe，放进 $BinDir 或 <仓库>\deploy\windows\bin\，再重新运行本脚本。"
        exit 1
    }

    Write-Info "用 winget 安装 $WingetId ..."
    & winget.exe install --id $WingetId --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "winget 安装 $WingetId 失败（退出码 $LASTEXITCODE）。"
        exit 1
    }

    $found = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "$Name.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    if ($found) { return $found }

    Write-Fail "winget 装完了但还是找不到 $Name.exe，请手动把它放进 $BinDir 再重试。"
    exit 1
}

function Test-PortBusy {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
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

function Wait-File {
    param([string]$Path, [int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $Path) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-HttpOkInsecure {
    param([string]$Url)
    # Caddy 用的是自建 CA，这时候本机可能还没信任它，所以临时跳过校验只为了探活。
    $prev = [Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        $r = Invoke-RestMethod -Uri $Url -TimeoutSec 5 -ErrorAction Stop
        return $r
    } catch {
        return $null
    } finally {
        [Net.ServicePointManager]::ServerCertificateValidationCallback = $prev
    }
}

function Show-LogTail {
    param([string]$LogDir, [int]$Lines = 25)
    if (-not (Test-Path -LiteralPath $LogDir)) { return }
    Get-ChildItem -Path $LogDir -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "`n--- $($_.Name)（最后 $Lines 行）---" -ForegroundColor DarkGray
        Get-Content -LiteralPath $_.FullName -Tail $Lines -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
}

# ---------------------------------------------------------------- 0. 前置检查

Write-Step '检查运行环境'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ((-not $isAdmin) -and (-not $NoServices)) {
    Write-Fail '本脚本需要管理员权限（要注册服务、加防火墙规则）。'
    Write-Info '请右键「Windows PowerShell」→「以管理员身份运行」，然后重新执行。'
    Write-Info '只想先把文件和依赖准备好、暂不注册服务，可以加 -NoServices。'
    exit 1
}
if ($NoServices) {
    Write-Warn '按 -NoServices：只准备环境，不注册服务、不加防火墙、不改电源、不装本机证书。'
}

$repoRoot  = Get-RepoRoot -Override $RepoRoot
$apiDir    = Join-Path $repoRoot 'services\api'
$engineDir = Join-Path $repoRoot 'packages\doc_engine'
$exampleEnv = Join-Path $repoRoot 'deploy\windows\wordwork.env.example'
$caddyTemplate = Join-Path $repoRoot 'deploy\windows\Caddyfile'

foreach ($required in @($apiDir, $engineDir, $exampleEnv, $caddyTemplate)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Fail "找不到 $required —— 请确认是在 wordwork 仓库里运行本脚本。"
        exit 1
    }
}

Write-Ok "仓库根目录：$repoRoot"
Write-Ok "数据目录  ：$DataDir"

if (Test-PortBusy -Port $ApiPort) {
    $owner = (Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    $pname = ''
    if ($owner) { $pname = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName }
    Write-Fail "端口 $ApiPort 已经被占用（PID $owner $pname）。"
    Write-Info '多半是你之前用 scripts/start-dev.ps1 起的开发服务端。先把它停掉再运行本脚本：'
    Write-Info "    Stop-Process -Id $owner -Force"
    exit 1
}

# ---------------------------------------------------------------- 1. 配置文件

Write-Step '准备配置文件'

$envPath = Join-Path $DataDir 'wordwork.env'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$generatedPassword = $null
if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath $exampleEnv -Destination $envPath -Force
    $generatedPassword = New-RandomPassword
    Set-EnvValue -Path $envPath -Key 'WORDWORK_BOOTSTRAP_PASSWORD' -Value $generatedPassword
    Set-EnvValue -Path $envPath -Key 'WORDWORK_DATA_DIR' -Value ($DataDir -replace '\\', '/')
    Set-EnvValue -Path $envPath -Key 'WORDWORK_DATABASE_URL' -Value ("sqlite:///{0}/db/wordwork.sqlite3" -f ($DataDir -replace '\\', '/'))
    Set-EnvValue -Path $envPath -Key 'WORDWORK_CADDY_STORAGE' -Value ("{0}/caddy" -f ($DataDir -replace '\\', '/'))
    Write-Ok "已生成 $envPath"
} else {
    Write-Ok "沿用已有配置 $envPath"
}

# 原则：命令行参数只在「显式传了」的时候才覆盖配置文件，
# 否则一律以 wordwork.env 为准 —— 这样「改 env → 重跑」就是唯一的心智模型。

if ($PSBoundParameters.ContainsKey('PublicHost')) {
    Set-EnvValue -Path $envPath -Key 'WORDWORK_PUBLIC_HOST' -Value $PublicHost
}
if ($PSBoundParameters.ContainsKey('PublicPort')) {
    Set-EnvValue -Path $envPath -Key 'WORDWORK_PUBLIC_PORT' -Value $PublicPort
}
if ($PSBoundParameters.ContainsKey('ApiPort')) {
    Set-EnvValue -Path $envPath -Key 'WORDWORK_API_PORT' -Value $ApiPort
}

$conf = Read-EnvFile -Path $envPath

# 局域网 IP：显式传了就用传的；没传且配置里还是占位符/空，就自动探测。
$currentLan = Get-EnvValue -Map $conf -Key 'WORDWORK_LAN_HOST'
if ($PSBoundParameters.ContainsKey('LanHost')) {
    Set-EnvValue -Path $envPath -Key 'WORDWORK_LAN_HOST' -Value $LanHost
} elseif ((-not $currentLan) -or ($currentLan -eq '192.168.1.10')) {
    $detected = Get-LanIp
    if ($detected) {
        Set-EnvValue -Path $envPath -Key 'WORDWORK_LAN_HOST' -Value $detected
        Write-Ok "自动探测到局域网 IP：$detected"
    } else {
        Write-Warn '探测不到局域网 IP，请手动填写 wordwork.env 里的 WORDWORK_LAN_HOST。'
    }
}

# 上面几次写入之后重新读一遍，后面的逻辑只看这一份。
$conf = Read-EnvFile -Path $envPath
$publicPort = [int](Get-EnvValue -Map $conf -Key 'WORDWORK_PUBLIC_PORT' -Default "$PublicPort")
$apiPort    = [int](Get-EnvValue -Map $conf -Key 'WORDWORK_API_PORT' -Default "$ApiPort")
$publicHost = Get-EnvValue -Map $conf -Key 'WORDWORK_PUBLIC_HOST'
$lanHost    = Get-EnvValue -Map $conf -Key 'WORDWORK_LAN_HOST'
$caddyStore = Get-EnvValue -Map $conf -Key 'WORDWORK_CADDY_STORAGE'

if (($publicHost -eq '1.2.3.4') -or (-not $publicHost)) {
    Write-Warn "配置里的 WORDWORK_PUBLIC_HOST 还是占位符（1.2.3.4），学生在外网连不上。"
    Write-Info "如果你是在本机试装，可以先不管；正式对外请填公网 IP 并重跑本脚本。"
}
if (($lanHost -eq '192.168.1.10') -or (-not $lanHost)) {
    Write-Fail '局域网 IP 没填对（还是占位符 192.168.1.10）。'
    Write-Info "请编辑 $envPath 里的 WORDWORK_LAN_HOST，然后重新运行。"
    exit 1
}
if ($conf.ContainsKey('WORDWORK_BOOTSTRAP_PASSWORD') -and $conf['WORDWORK_BOOTSTRAP_PASSWORD']) {
    if ($conf['WORDWORK_BOOTSTRAP_PASSWORD'].Length -lt 12) {
        Write-Fail 'WORDWORK_BOOTSTRAP_PASSWORD 少于 12 位，服务端会拒绝启动。请改长后重跑。'
        exit 1
    }
}

Write-Ok "公网地址：https://${publicHost}:$publicPort"
Write-Ok "局域网  ：https://${lanHost}:$publicPort"
Write-Ok "API 回环：http://127.0.0.1:$apiPort"

# ---------------------------------------------------------------- 2. 目录与二进制

Write-Step '准备目录与可执行文件'

$binPath  = Join-Path $DataDir 'bin'
$logPath  = Join-Path $DataDir 'logs'
$dbPath   = Join-Path $DataDir 'db'
foreach ($d in @($binPath, $logPath, $dbPath)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$repoBinDir = Join-Path $repoRoot 'deploy\windows\bin'
$caddySrc = Find-Tool -Name 'caddy' -BinDir $BinDir -WingetId 'CaddyServer.Caddy' -FallbackDir $repoBinDir
$winswSrc = Find-Tool -Name 'winsw' -BinDir $BinDir -WingetId 'CloudBees.WindowsServiceWrapper' -FallbackDir $repoBinDir
Write-Ok "caddy ：$caddySrc"
Write-Ok "winsw ：$winswSrc"

$caddyExe        = Join-Path $binPath 'caddy.exe'
$apiServiceExe   = Join-Path $binPath 'wordwork-api.exe'
$caddyServiceExe = Join-Path $binPath 'wordwork-caddy.exe'
foreach ($pair in @(@($caddySrc, $caddyExe), @($winswSrc, $apiServiceExe), @($winswSrc, $caddyServiceExe))) {
    if ($pair[0] -ne $pair[1]) { Copy-Item -LiteralPath $pair[0] -Destination $pair[1] -Force }
}
Write-Ok "已把可执行文件放到 $binPath"

# ---------------------------------------------------------------- 3. Python 环境

Write-Step '准备 Python 环境'

$venvDir    = Join-Path $DataDir 'venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'

# 已存在的虚拟环境版本太低就删掉重建（例如第一次误用了 PATH 里更老的 Python）。
if (Test-Path -LiteralPath $venvPython) {
    $existingVer = Get-PythonVersion -Exe $venvPython
    if (-not (Test-PythonSupported -Version $existingVer)) {
        Write-Warn "已有的虚拟环境是 Python $existingVer，低于 3.12，删掉重建。"
        Remove-Item -LiteralPath $venvDir -Recurse -Force
    }
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    $base = Find-BasePython -Override $BasePython -RepoRoot $repoRoot
    if (-not $base) {
        Write-Fail '找不到 Python 3.12 或更高版本（DOCX 引擎要求 3.12+）。'
        Write-Info '装一个最省事：winget install Python.Python.3.12'
        Write-Info '装完关掉再重开 PowerShell（让 PATH 生效），然后重跑本脚本。'
        Write-Info '要是 3.12 装在别处，可以指过来：-BasePython "C:\路径\python.exe"'
        exit 1
    }
    Write-Info "用 $($base.Exe) $($base.Args -join ' ')（Python $($base.Version)）创建虚拟环境 ..."
    $baseArgs = @($base.Args)
    & $base.Exe @baseArgs -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { Write-Fail '创建虚拟环境失败。'; exit 1 }
}
Write-Ok "虚拟环境：$venvDir"

if (-not $SkipDeps) {
    Write-Info '安装 Python 依赖（第一次会比较慢）...'
    $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '--quiet')
    if ($PipIndexUrl) { $pipArgs += @('-i', $PipIndexUrl) }
    & $venvPython @pipArgs '--upgrade' 'pip'
    if ($LASTEXITCODE -ne 0) { Write-Fail '升级 pip 失败。'; exit 1 }

    # setuptools 的 build_py 只在源文件比 build\lib 里的副本更新时才重新复制。
    # 上一次构建留下的 build\lib 可能比源码还新（或被手工改过），那样打出来的包里
    # 装的是旧代码，而版本号看起来没变 —— 正是「引擎老是被加载成旧版」的成因之一。
    foreach ($stale in @((Join-Path $engineDir 'build'), (Join-Path $apiDir 'build'))) {
        if (Test-Path -LiteralPath $stale) {
            Remove-Item -LiteralPath $stale -Recurse -Force
            Write-Info "清掉陈旧构建产物：$stale"
        }
    }

    # --force-reinstall 而不是普通 install：pip 对同版本的本地目录会直接说
    # 「Requirement already satisfied」并跳过，于是源码改了、venv 里还是旧的。
    # 引擎没有必须一起装的依赖（dependencies = []），所以 --no-deps 安全。
    & $venvPython @pipArgs '--upgrade' '--force-reinstall' '--no-deps' $engineDir
    if ($LASTEXITCODE -ne 0) { Write-Fail "安装 $engineDir 失败。"; exit 1 }

    # API 本体是用 --app-dir 直接跑的，装它主要是为了把依赖拉齐。
    & $venvPython @pipArgs $apiDir
    if ($LASTEXITCODE -ne 0) {
        Write-Warn '按包安装 services/api 失败，退回到直接安装它声明的依赖。'
        & $venvPython @pipArgs 'fastapi>=0.115' 'uvicorn[standard]>=0.30' 'sqlalchemy>=2.0' 'python-multipart>=0.0.9'
        if ($LASTEXITCODE -ne 0) { Write-Fail '安装 API 依赖失败。'; exit 1 }
    }
    Write-Ok '依赖安装完成'
} else {
    Write-Info '按 -SkipDeps 跳过依赖安装'
}

# ---------------------------------------------------------------- 3b. 引擎契约自检

# 用服务实际会用的那个 Python，确认它 import 到的引擎版本和契约都对。
# 不匹配就让安装失败 —— 否则错误会在老师点「完成审阅」时才以 500 的形式爆出来。
# 只在装了依赖之后跑：-SkipDeps 的用途就是「不碰 pip」，那时 venv 里是什么样就是什么样。
if (-not $SkipDeps) {
    $selfCheck = Join-Path $PSScriptRoot 'engine_selfcheck.py'
    if (Test-Path -LiteralPath $selfCheck) {
        Write-Step '校验 DOCX 引擎版本与契约'
        $sitePackages = Join-Path $venvDir 'Lib\site-packages'
        & $venvPython $selfCheck '--expect-prefix' $sitePackages
        if ($LASTEXITCODE -ne 0) {
            Write-Fail '部署的 DOCX 引擎与服务端代码不匹配（详见上面的输出）。'
            Write-Info '多半是 venv 里还留着旧版本。删掉后重跑本脚本：'
            Write-Info "  Remove-Item -Recurse -Force `"$venvDir`""
            exit 1
        }
        Write-Ok '引擎契约自检通过'
    } else {
        Write-Warn "找不到自检脚本 $selfCheck，跳过引擎契约校验。"
    }
}

# ---------------------------------------------------------------- 4. 生成服务定义

Write-Step '生成服务定义'

$caddyfilePath = Join-Path $DataDir 'Caddyfile'
Copy-Item -LiteralPath $caddyTemplate -Destination $caddyfilePath -Force
Write-Ok "Caddyfile -> $caddyfilePath"

$apiExeArgs = '-m uvicorn app.main:app --app-dir "{0}" --host 127.0.0.1 --port {1} --proxy-headers --forwarded-allow-ips=127.0.0.1' -f $apiDir, $apiPort
$caddyArgs  = 'run --config "{0}" --adapter caddyfile' -f $caddyfilePath

# 给 API 的环境变量：不含脚本专用的那几个，也不含根证书目录。
$apiEnvKeys = @(
    'WORDWORK_DATA_DIR', 'WORDWORK_DATABASE_URL', 'WORDWORK_MAX_UPLOAD_BYTES',
    'WORDWORK_BOOTSTRAP_TEACHER', 'WORDWORK_BOOTSTRAP_PASSWORD', 'WORDWORK_BOOTSTRAP_FORCE_CHANGE',
    'WORDWORK_SESSION_DAYS', 'WORDWORK_DEV_ORIGINS', 'WORDWORK_ALLOWED_ORIGINS'
)
# 给 Caddy 的：注意不要把管理员密码交出去。
$caddyEnvKeys = @(
    'WORDWORK_CADDY_STORAGE', 'WORDWORK_PUBLIC_HOST', 'WORDWORK_LAN_HOST',
    'WORDWORK_PUBLIC_PORT', 'WORDWORK_API_PORT'
)

function New-EnvXml {
    param([hashtable]$Map, [string[]]$Keys)
    $sb = New-Object System.Text.StringBuilder
    foreach ($k in $Keys) {
        $v = ''
        if ($Map.ContainsKey($k)) { $v = [string]$Map[$k] }
        [void]$sb.AppendLine("  <env name=`"$(XmlEsc $k)`" value=`"$(XmlEsc $v)`"/>")
    }
    return $sb.ToString()
}

function New-ServiceXml {
    # 注意：参数不能叫 $Args —— 那是 PowerShell 的自动变量，会被它盖掉。
    param([string]$Id, [string]$Name, [string]$Description, [string]$Executable, [string]$Arguments, [string]$WorkingDir, [string]$EnvXml)
    return @"
<?xml version="1.0" encoding="utf-8"?>
<service>
  <id>$(XmlEsc $Id)</id>
  <name>$(XmlEsc $Name)</name>
  <description>$(XmlEsc $Description)</description>
  <executable>$(XmlEsc $Executable)</executable>
  <arguments>$(XmlEsc $Arguments)</arguments>
  <workingdirectory>$(XmlEsc $WorkingDir)</workingdirectory>
$($EnvXml)  <logpath>$(XmlEsc $logPath)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <onfailure action="restart" delay="15 sec"/>
  <stoptimeout>20 sec</stoptimeout>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
</service>
"@
}

$apiXmlPath   = Join-Path $binPath 'wordwork-api.xml'
$caddyXmlPath = Join-Path $binPath 'wordwork-caddy.xml'

$apiXmlText = New-ServiceXml -Id 'wordwork-api' -Name 'wordwork API' `
    -Description 'wordwork 协同审稿服务端（仅监听 127.0.0.1）' `
    -Executable $venvPython -Arguments $apiExeArgs -WorkingDir $apiDir `
    -EnvXml (New-EnvXml -Map $conf -Keys $apiEnvKeys)

$caddyXmlText = New-ServiceXml -Id 'wordwork-caddy' -Name 'wordwork HTTPS 入口' `
    -Description 'wordwork 对外 HTTPS 入口（Caddy，自建内部 CA）' `
    -Executable $caddyExe -Arguments $caddyArgs -WorkingDir $DataDir `
    -EnvXml (New-EnvXml -Map $conf -Keys $caddyEnvKeys)

[System.IO.File]::WriteAllText($apiXmlPath, $apiXmlText, (New-Object System.Text.UTF8Encoding($true)))
[System.IO.File]::WriteAllText($caddyXmlPath, $caddyXmlText, (New-Object System.Text.UTF8Encoding($true)))
Write-Ok "服务定义 -> $apiXmlPath"
Write-Ok "服务定义 -> $caddyXmlPath"

# ---------------------------------------------------------------- 5. 注册并启动服务

if ($NoServices) {
    Write-Step '准备完成（按 -NoServices 没有注册服务）'
    Write-Host ''
    Write-Info '要手动跑起来看看：先按 wordwork.env 把 WORDWORK_ 环境变量设好，然后'
    Write-Info "    `"$venvPython`" -m uvicorn app.main:app --app-dir `"$apiDir`" --host 127.0.0.1 --port $apiPort"
    Write-Info "    `"$caddyExe`" run --config `"$caddyfilePath`" --adapter caddyfile"
    Write-Host ''
    Write-Info '确认没问题后，用管理员权限重新运行本脚本（不加 -NoServices），它会注册成开机自启的服务。'
    Write-Host ''
    exit 0
}

function Install-WordworkService {
    param([string]$ServiceId, [string]$ServiceExe, [string]$DisplayName)

    $existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    if ($existing) {
        if (-not $Force) {
            Write-Fail "服务 $ServiceId 已经存在。要覆盖它请加 -Force（会先停掉再重新注册，数据不受影响）。"
            exit 1
        }
        Write-Info "覆盖已有服务 $ServiceId ..."
        if ($existing.Status -ne 'Stopped') {
            Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        & $ServiceExe uninstall | Out-Null
        Start-Sleep -Seconds 2
    }

    & $ServiceExe install | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "注册服务 $ServiceId 失败。"; Show-LogTail -LogDir $logPath; exit 1 }
    Start-Service -Name $ServiceId
    Write-Ok "$DisplayName 已启动"
}

Write-Step '注册并启动服务'

Install-WordworkService -ServiceId 'wordwork-api'   -ServiceExe $apiServiceExe   -DisplayName 'wordwork API'
Install-WordworkService -ServiceId 'wordwork-caddy' -ServiceExe $caddyServiceExe -DisplayName 'wordwork Caddy'

# ---------------------------------------------------------------- 6. 防火墙 / 电源

if (-not $NoFirewall) {
    Write-Step "放行对外端口 $publicPort"
    $ruleName = "wordwork HTTPS $publicPort"
    $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existingRule) {
        Write-Ok '防火墙规则已存在'
    } else {
        New-NetFirewallRule -DisplayName $ruleName -Group 'wordwork' -Direction Inbound `
            -Action Allow -Protocol TCP -LocalPort $publicPort -Profile Any | Out-Null
        Write-Ok "已放行 TCP $publicPort（API 的 $apiPort 只走回环，不需要放行）"
    }
}

if (-not $NoPowerTune) {
    Write-Step '关闭休眠（否则机器睡着时学生连不上）'
    & powercfg.exe /change standby-timeout-ac 0
    & powercfg.exe /change hibernate-timeout-ac 0
    Write-Ok '已把「接通电源时的睡眠/休眠」设为「从不」'
    Write-Info '屏幕关闭时间没动。另外建议在「设置 → Windows 更新 → 活动时间」里避开你的工作时间，防止自动重启。'
}

# ---------------------------------------------------------------- 7. 验证

Write-Step '验证服务'

$apiOk = Wait-HttpOk -Url "http://127.0.0.1:$apiPort/healthz" -Seconds 60
if (-not $apiOk) {
    Write-Fail "API 在 http://127.0.0.1:$apiPort 上没有响应。下面是日志结尾："
    Show-LogTail -LogDir $logPath
    Write-Info "常见原因：WORDWORK_BOOTSTRAP_PASSWORD 少于 12 位、依赖没装全、$apiPort 被别的程序占用。"
    exit 1
}
Write-Ok "API 就绪：http://127.0.0.1:$apiPort/healthz"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:$apiPort/healthz" -TimeoutSec 5
$engineOk = $false
if ($health.PSObject.Properties.Name -contains 'engine_available') { $engineOk = [bool]$health.engine_available }
# `engine_compatible` 才是「能不能用」：引擎装上了但契约对不上，审阅一样会 503。
$engineCompatible = $false
if ($health.PSObject.Properties.Name -contains 'engine_compatible') { $engineCompatible = [bool]$health.engine_compatible }
if (-not $engineOk) {
    Write-Warn 'engine_available 是 false —— DOCX 引擎没装好，上传文档会失败。'
    Write-Info "请重新运行本脚本（不要加 -SkipDeps），或手动执行：$venvPython -m pip install `"$engineDir`""
} elseif (-not $engineCompatible) {
    Write-Fail "DOCX 引擎装上了，但契约和 API 对不上：$($health.engine_problem)"
    Write-Info "实际引擎：$($health.engine_file)（版本 $($health.engine_version)，契约 $($health.engine_contract)；API 需要 $($health.engine_contract_required)）"
    Write-Info "删掉 venv 后重跑本脚本：Remove-Item -Recurse -Force `"$venvDir`""
    exit 1
} else {
    Write-Ok "DOCX 引擎可用（版本 $($health.engine_version)，契约 $($health.engine_contract)）"
}

# 探一下 HTTPS：第一次连接会让 Caddy 把证书签出来。
$null = Get-HttpOkInsecure -Url "https://127.0.0.1:$publicPort/healthz"
$rootCrt = Join-Path $caddyStore 'pki\authorities\local\root.crt'
$rootCrt = $rootCrt -replace '/', '\'

if (Wait-File -Path $rootCrt -Seconds 45) {
    Write-Ok "根证书：$rootCrt"
} else {
    Write-Warn "还没看到根证书 $rootCrt。"
    Write-Info 'Caddy 要等第一次有客户端连接时才会签发。可以先点一下 export-ca.ps1，它会代为触发。'
}

# ---------------------------------------------------------------- 8. 本机信任

$caThumbprint = ''
if ((-not $SkipLocalTrust) -and (Test-Path -LiteralPath $rootCrt)) {
    Write-Step '把根证书装进本机信任库'
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($rootCrt)
    $caThumbprint = $cert.Thumbprint
    $already = Test-Path -LiteralPath "Cert:\LocalMachine\Root\$caThumbprint"
    if ($already) {
        Write-Ok '本机已经信任这张根证书了'
    } else {
        Import-Certificate -FilePath $rootCrt -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
        Write-Ok "已导入本机「受信任的根证书颁发机构」（指纹 $caThumbprint）"
    }
}

# ---------------------------------------------------------------- 9. 收尾

Write-Step '完成'

$svcApi   = Get-Service -Name 'wordwork-api'
$svcCaddy = Get-Service -Name 'wordwork-caddy'
Write-Ok "wordwork-api    : $($svcApi.Status)（开机自启）"
Write-Ok "wordwork-caddy  : $($svcCaddy.Status)（开机自启）"

Write-Host ''
Write-Host '    你自己这台机器上，客户端填：' -NoNewline
Write-Host "http://127.0.0.1:$apiPort" -ForegroundColor White
Write-Host '    学生填（外网）：' -NoNewline
Write-Host "https://${publicHost}:$publicPort" -ForegroundColor White
Write-Host '    学生填（同一局域网）：' -NoNewline
Write-Host "https://${lanHost}:$publicPort" -ForegroundColor White

if ($generatedPassword) {
    Write-Host ''
    Write-Host '    第一个老师账号（首次登录会要求改密码）：' -ForegroundColor Yellow
    Write-Host "        用户名：$(Get-EnvValue -Map $conf -Key 'WORDWORK_BOOTSTRAP_TEACHER' -Default 'teacher')" -ForegroundColor Yellow
    Write-Host "        密码  ：$generatedPassword" -ForegroundColor Yellow
    Write-Host "    这个密码只在这里显示一次，同时也写在 $envPath 里。" -ForegroundColor Yellow
}

Write-Host ''
Write-Info "学生机器需要装一次根证书，执行：powershell -File scripts/windows/export-ca.ps1"
Write-Info "以后改配置：改 $envPath，然后重跑本脚本（加 -Force）。"
Write-Host ''
