# 在 Windows 台式机上部署 wordwork（无域名、IP 直连）

这篇文档面向**负责这台服务器的人**（通常就是老师本人）。它描述的是这一种部署形态：

- 服务器就是**你自己那台常开的 Windows 台式机**，写基金期间全天开机；
- **没有申请域名**，学生直接用 IP 地址访问；
- 这台机器上**同时跑服务端和你的教师端客户端**；
- 学生**既可能在同一间办公室（局域网），也可能在外面（外网）**接入。

如果你其实有一台 Linux 服务器和域名，那条路更省事，照 `README.md` 第二节的
Docker 方案走，不用看这篇。

---

## 部署完是什么样子

```
学生（局域网 / 外网）
      │  https://203.0.113.10:8443   （外网示例；部署时替换）
      │  https://192.168.1.10:8443   （局域网示例；部署时替换）
      ▼
  Caddy ── 负责 HTTPS，证书由本机自建 CA 签发
      │  反向代理到
      ▼
  API ── 只监听 127.0.0.1:8000，外界碰不到
      │
      ▼
  C:\ProgramData\wordwork\
      ├─ db\         SQLite 数据库
      ├─ objects\    文档（按内容哈希存放，只增不删）
      ├─ backups\    备份
      ├─ caddy\      自建 CA 和证书
      ├─ logs\       日志
      ├─ venv\       服务端运行时
      ├─ bin\        两个服务程序 + 服务定义
      └─ wordwork.env  配置
```

两个关键设计，先说清楚免得困惑：

1. **API 只监听回环地址 8000。** 外界只能通过 Caddy 的 8443 访问，所以 8000
   不需要防火墙放行，也不可能被用来绕过 HTTPS。
2. **你自己的教师端不需要证书。** 客户端允许回环地址走明文，你的客户端填
   `http://127.0.0.1:8000` 即可，省掉在自己机器上装证书这一步。

### 为什么必须有 HTTPS

客户端的地址校验会**拒绝公网明文 `http://`**（回环地址除外）。学生要从外网接入，
所以必须有 HTTPS。而没有域名就申请不了 Let's Encrypt 证书，因此这里用
**Caddy 自建 CA**：它照样会签发真证书、照样自动续期，代价是**每台学生机要一次性
安装这张根证书**。这是没有域名的必然结果，绕不开。

选 Caddy 而不是手工生成一张自签证书，唯一但很重要的原因是：**Caddy 会自动续期**。
手工签的证书一年后悄悄过期、所有学生突然连不上，是最难排查的故障。

---

## 一、开始之前

### 硬性前提

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（本机是 Windows 11） |
| 权限 | 安装时需要**管理员**（注册服务、加防火墙规则） |
| 工具 | 安装脚本会用 winget 自动装 Python 3.12、Caddy、WinSW，无需手动准备 |
| 网络 | 一个**固定的内网 IP**（在路由器上做 DHCP 静态绑定） |
| 端口 | 对外用一个端口，默认 **8443**（避开大陆家宽常封的 80/443） |

> 内网 IP 一定要在路由器上固定下来。否则地址一变，所有局域网里的客户端就连不上了。

### 关于外网访问，有一个你无法在这台机器上验证的风险

大陆家庭宽带很常见两种情况：

- **CGNAT（运营商大内网）**：你以为自己有公网 IP，其实那是运营商出口的地址，
  外面根本进不来；
- **封入站端口**：有公网 IP，但 80/443 之类的端口被运营商封了。

`diagnose.ps1` 会给出判断线索，但**唯一可靠的验证方式是从外面连一次**：
让一个学生关掉 Wi-Fi、用手机流量执行 `Test-NetConnection 203.0.113.10 -Port 8443`（替换为真实公网地址）。
如果不通，就得改用内网穿透，或者打客服电话要求放行端口——这一步不是脚本能解决的。

---

## 二、安装

### 1. 打开管理员 PowerShell

开始菜单搜 `PowerShell` → 右键 → **以管理员身份运行**。

### 2. 跑安装脚本

```powershell
cd D:\tools\wordwork
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

脚本会依次做这些事：

1. 检查工具链（Python ≥ 3.12、winget），缺什么装什么；
2. 在 `C:\ProgramData\wordwork\venv` 建一个独立的运行环境，装服务端依赖；
3. 用 winget 装 Caddy 和 WinSW，并复制到 `C:\ProgramData\wordwork\bin`；
4. 生成配置文件 `C:\ProgramData\wordwork\wordwork.env`（**管理员密码随机生成并打印出来，请记下**）；
5. 生成 Caddyfile，建库，创建第一个老师账号；
6. 把 API 和 Caddy 注册成**开机自启的 Windows 服务**并启动；
7. 放行对外端口的防火墙规则；
8. 把「接通电源时休眠」关掉（否则机器睡着时学生连不上）；
9. 打印根证书的位置和后续步骤。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-PublicPort 8443` | 换对外端口（如果运营商没封 443，可以填 443） |
| `-PublicHost 203.0.113.10` | 公网 IP 示例；不填会从配置里读或自动探测 |
| `-LanHost 192.168.1.10` | 局域网 IP 示例；不填会自动探测 |
| `-DataDir D:\wordwork-data` | 换数据目录（默认 `C:\ProgramData\wordwork`） |
| `-NoServices` | 只装依赖和配置，不注册服务（调试用） |
| `-Force` | 覆盖已注册的服务和已有配置 |

**脚本可以重复运行。** 想改配置就编辑 `C:\ProgramData\wordwork\wordwork.env`，
再重新跑一遍 `install.ps1` 让它生效。已经存在的账号和数据不受影响。

### 3. 确认装好了

```powershell
Get-Service wordwork-api, wordwork-caddy      # 两个都应该是 Running
Invoke-RestMethod http://127.0.0.1:8000/healthz
```

`healthz` 应该返回 `status = ok` 且 **`engine_available = true`**。
如果 `engine_available` 是 `false`，说明 DOCX 引擎没装好，上传文档会失败。

---

## 三、把根证书发给学生（每台学生机一次）

### 导出

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\export-ca.ps1
```

产物是 `C:\ProgramData\wordwork\wordwork-root-ca.crt`，有效期到 2036 年，
所以**学生装一次就行，不用每年折腾**。脚本同时会打印证书指纹和手机端的安装步骤。

### 学生怎么装

**Windows**：双击 `.crt` → 安装证书 → 存储位置选「**本地计算机**」→
将所有证书放入下列存储 → 「受信任的根证书颁发机构」→ 完成。
或者用管理员 PowerShell 一条命令：

```powershell
certutil -addstore -f Root wordwork-root-ca.crt
```

**macOS**：双击导入「钥匙串访问」，找到这张证书，双击把「使用此证书时」设为「始终信任」。

**iPhone / iPad**：把 `.crt` 发到手机 → 设置 → 通用 → VPN与设备管理 → 安装；
再到 设置 → 通用 → 关于本机 → 证书信任设置 → 把这张证书的开关打开。

**Android**：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书。
注意 Android 上只有**浏览器**会信用户装的 CA，App 不一定信，
所以 Android 学生建议改用电脑客户端。

### 让学生当面核对指纹

这张根证书**等同于你服务器的身份证**——谁拿到它、并且能冒充你的 IP，
就能在学生毫无察觉的情况下中间人。所以：

- 别发到公开群里，用 U 盘或点对点发送；
- 让学生装之前核对一遍 `export-ca.ps1` 打印的**指纹**。

---

## 四、各角色填什么地址

| 谁 | 在哪 | 客户端里填 |
| --- | --- | --- |
| 你（老师） | 就是这台服务器 | `http://127.0.0.1:8000`（不需要证书） |
| 学生 | 同一个 Wi-Fi / 办公室 | `https://192.168.1.10:8443` |
| 学生 | 在外面（4G、家里） | `https://203.0.113.10:8443`（替换为真实地址） |

地址和端口都是从 `wordwork.env` 里的 `WORDWORK_LAN_HOST` / `WORDWORK_PUBLIC_HOST` /
`WORDWORK_PUBLIC_PORT` 读出来的，改了配置要重新跑 `install.ps1`。

---

## 五、日常使用

### 开机自启

两个服务都注册成了「自动（延迟启动）」，开机后会自己起来，不需要你登录。
想立刻确认：

```powershell
Restart-Computer
# 起来之后
Get-Service wordwork-api, wordwork-caddy
```

另外建议在「设置 → Windows 更新 → 活动时间」里把工作时间避开，
防止 Windows 在你写基金的时候自动重启。

### 备份

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1
```

数据库用 SQLite 自己的 backup API 复制（**服务正在跑也安全**），文档对象直接复制。
产物是 `C:\ProgramData\wordwork\backups\wordwork-<时间戳>\`，里面有数据库、
`objects\` 和一份 `manifest.txt`（记录了 sha256，恢复时会拿去比对）。

注册成每天自动备份：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\backup.ps1 -Register
```

会在**每天 03:20** 以 SYSTEM 身份跑一次，保留最近 14 份。取消：

```powershell
Unregister-ScheduledTask -TaskName 'wordwork backup' -Confirm:$false
```

> 注意：这个脚本复制的是**真实配置里的数据库路径**。仓库里那对 Linux 用的
> `scripts/backup.sh` / `restore.sh` 硬编码的是 `wordwork.db`，和实际库名对不上，
> 在原生安装下会备份出一个空文件——所以 Windows 上用这一对。

### 恢复

```powershell
# 先演练：恢复前脚本会校验完整性 + 比对 sha256
powershell -ExecutionPolicy Bypass -File scripts\windows\restore.ps1 `
    -BackupDir C:\ProgramData\wordwork\backups\wordwork-20260913-142724

# 目标位置已有数据时必须显式加 -Force
powershell -ExecutionPolicy Bypass -File scripts\windows\restore.ps1 `
    -BackupDir C:\ProgramData\wordwork\backups\wordwork-20260913-142724 -Force
```

恢复前会先把现有数据**挪到** `.pre-restore-<时间戳>`（不是删掉），万一恢复错了还能退回来。
确认没问题后再自己删掉这些 `.pre-restore-*`。

服务已注册时需要管理员权限（要停/启服务）；`-NoServices` 装的部署直接跑就行。

⚠️ **恢复会把登录状态一起回退**——会话记录存在数据库里，恢复旧备份之后，
在恢复点之后登录的学生需要重新登录。

> 请至少完整演练一次恢复，再拿正式材料写文档。

### 诊断

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\diagnose.ps1
```

只读体检，逐项检查服务状态、端口监听、`healthz`、证书有效期与信任、
防火墙规则、电源设置、数据库和文档数量、备份新鲜度、磁盘空间、内外网 IP 是否吻合。
最后给一行结论。

### 改配置

编辑 `C:\ProgramData\wordwork\wordwork.env`，然后重新跑一次 `install.ps1`。
`WORDWORK_BOOTSTRAP_*` 只在数据库为空时生效，改它们不会影响已有账号。

---

## 六、搬家（换一台 Windows 台式机）

关键是**连 `caddy` 目录一起搬**：

1. 在旧机器上跑一次 `backup.ps1`，并把 `C:\ProgramData\wordwork\caddy\` 整个目录也复制走
   （这个目录不在备份产物里）。想省事也可以直接整体复制 `C:\ProgramData\wordwork\`。
2. 在新机器上装好 wordwork（跑 `install.ps1`），让它把服务建起来。
3. 用 `restore.ps1` 恢复数据库和文档对象，并把 `caddy\` 目录放回原位。
4. 在新机器上重跑 `install.ps1 -Force`，并更新 `wordwork.env` 里新的局域网 IP / 公网 IP。

**为什么要把 `caddy` 一起搬**：自建 CA 的根证书和私钥就在那个目录里。
搬过去之后，Caddy 还是用同一张根证书签发新证书，**学生之前装过的根证书继续有效**，
只需要改客户端里填的地址。如果没搬，新机器会生成一张全新的根证书，
那**每台学生机都得重装一次证书**。

---

## 七、卸载

```powershell
# 只拆服务、防火墙规则和证书信任，数据原样留着
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1

# 连数据一起删（会再确认一次，也可以加 -Force 跳过确认）
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1 -PurgeData
```

需要管理员权限。默认**不删数据**——想重装回来直接跑 `install.ps1`，
账号、轮次、文档都还在。

---

## 八、常见故障

**学生连不上，提示连接失败**

按顺序排查：

1. 地址填对了吗？要带 `https://` 和端口，例如 `https://192.168.1.10:8443`。
2. 学生装根证书了吗？没装会**证书不受信任**，很多客户端会直接报连接失败。
3. 在服务器上跑 `diagnose.ps1`，看服务是不是 Running、8443 有没有在监听。
4. 局域网内不通 → 检查防火墙规则在不在（`diagnose.ps1` 会 WARN）。
5. 外网不通 → 见下面一条。

**外网进不来**

先在服务器上跑 `diagnose.ps1`，看「公网出口 IP」和配置是否一致。
如果一致但仍连不上，多半是 CGNAT 或运营商封端口——让处在**另一个网络**的人执行：

```powershell
Test-NetConnection 203.0.113.10 -Port 8443
```

不通就说明是运营商侧的问题，需要内网穿透或让运营商放行。

**提示证书不受信任 / 证书错误**

八成是没装根证书，或者装到了「个人」而不是「受信任的根证书颁发机构」。
重新跑一遍第三节的安装步骤，装完重启一下客户端。

**服务起不来**

```powershell
Get-Service wordwork-api | Select-Object Status
Get-Content C:\ProgramData\wordwork\logs\wordwork-api.out.log -Tail 40
```

最常见的原因是 `WORDWORK_BOOTSTRAP_PASSWORD` 少于 12 位（服务端会拒绝启动），
或者 8000 / 8443 端口被别的程序占用。

**上传文档说「不是安全有效的 .docx」**

先确认文件确实是 `.docx` 而不是 `.docm`（宏文档会被直接拒绝）。
如果是正常的 Word 文档，检查 `healthz` 里的 `engine_available` 是不是 `true`。

---

## 附：本机当前的部署参数

以下是这台机器**实际验证过**的配置，换机器时按新的 IP 替换。

| 项目 | 值 |
| --- | --- |
| 数据目录 | `C:\ProgramData\wordwork` |
| 公网 IP | `203.0.113.10`（TEST-NET 示例；部署时替换） |
| 局域网 IP | `192.168.1.10`（示例；部署时替换） |
| 对外端口 | `8443` |
| API 端口 | `8000`（仅回环） |
| 老师本机地址 | `http://127.0.0.1:8000` |
| 学生外网地址 | `https://203.0.113.10:8443`（替换为真实地址） |
| 学生局域网地址 | `https://192.168.1.10:8443`（替换为真实地址） |
| 根证书 | `C:\ProgramData\wordwork\wordwork-root-ca.crt` |
| 根证书指纹 | `459F91C32DC0BE7928AFFC5E5DAF6BC58E0FB53B` |
| 根证书有效期 | 2026-09-13 → 2036-07-22 |
