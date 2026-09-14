# wordwork 交付说明

本次工作把原来的「能跑的演示」推进成「老师和学生装上就能用的 Windows 桌面软件」。
下面是实际完成的内容、改动的文件、接口变化、真实跑过的测试、产物位置、试用账号，
以及尚未完成的部分和后续开发应该先看什么。

---

## 一、完成了什么

### 1. 桌面端接上真实后台，去掉了默认假数据

- 删除了 `src/lib/mock.ts`、`src/lib/local.ts` 及相关测试。客户端代码里已经没有任何
  写死的项目、文档或提交，全部来自后台接口。
- `src/lib/api.ts` 重写为完整的 `ApiClient`，方法名、字段名、请求路径与 FastAPI 端
  点逐一对齐；上传/提交走 `FormData`，其余走 JSON。
- 新增 `src/lib/store.tsx`（`AppProvider` / `useApp`）统一管理登录态、服务器地址、
  工作副本和离线提交队列；启动时会用 `GET /me` 复验本地会话，401 清会话、断网置
  `online=false`。
- 首次启动进入「服务器地址设置」页（`ServerSetup.tsx`），地址做协议校验：公网必须
  `https://`，只有 `localhost` / `127.0.0.1` 允许明文 `http://`。
- 真实登录 / 退出（`Login.tsx`、`App.tsx`）；`must_change_password` 为真时自动弹出
  改密码窗口，改完之前不放行。
- 所有状态都有中文界面：加载中、空列表、错误、断网、会话过期，分别对应
  `Spinner` / `EmptyState` / `ErrorState` / `Banner` 和中文 toast。

### 2. 老师流程

- 建项目、加学生账号（`MembersPanel.tsx`）。
- 上传初始 DOCX，创建并发布协作轮次（`ProjectPage.tsx` 的 `startRound()`）。
- 查看每份提交的真实差异，逐条接受 / 拒绝、批量接受 / 批量拒绝、撤销，然后定稿
  （`ReviewWorkbench.tsx`）。
- 多人在同一段冲突时，发布被后台以 409 拦下，界面弹出冲突处理面板，可以按冲突选
  择保留哪一方，也可以上传自己人工合并好的文档（`RoundPage.tsx` 的 `ConflictResolver`
  与 `ManualMergeModal`）。
- 发布最终主版本，同时生成带修订痕迹的汇总对照稿。
- 查看 / 下载历史版本，并可把任意历史版本恢复为当前版本（`VersionsPanel.tsx`，
  仅老师可见恢复按钮）。

### 3. 学生流程

- 查看已发布的轮次。
- 下载工作副本到自选位置。
- 用系统默认 Word / WPS 打开（`open_with_system`）。
- 选好改完的 DOCX 提交，附版本说明；提交时带上冻结的 `base_version_id` 和真实
  SHA-256，服务端会比对内容哈希，不一致直接拒绝。
- 提交后可以只读查看自己和别人的差异与批注，但**没有**接受 / 拒绝 / 恢复 / 发布的
  入口，服务端也会用 403 拦住。

### 4. Tauri 原生层

`apps/desktop/src-tauri` 是一个完整可编译的 Tauri 2 工程：

- 原生文件选择 / 保存对话框、读写文件、用系统默认程序打开 DOCX、系统通知。
- 工作副本元数据和离线提交队列持久化在本地；断网提交进队列，网络恢复自动补交。
- 覆盖文件前先用 `is_file_released` / `wait_for_file_released` 确认 Word / WPS 已经
  关闭该文件，绝不覆盖正在打开的文档。
- 登录态落盘时在 Windows 上用 DPAPI（`CryptProtectData`）加密，不依赖第三方 crate；
  非 Windows 平台退化为原样存储（预研阶段不接 Keychain）。

### 5. 服务端加固

- 会话不再放在 Python 内存字典里：新增 `sessions` 表存 sha256 后的不透明令牌，
  可过期（默认 7 天）、可单独作废。
- 新增 `POST /auth/logout`、`POST /auth/change-password`；改密码后除当前会话外的
  其它会话全部作废。首次登录若 `must_change_password` 为真，客户端强制改密。
- 项目权限收紧：任何老师也只能访问自己加入过的项目，未加入一律 403。
- CORS 白名单化，只允许 Tauri 客户端来源和显式列出的开发地址，不再接受任意来源。
- 补齐桌面端需要的列表 / 详情端点（见下面第三节）。
- 保留内容寻址存储、DOCX 安全校验、宏文档拒绝、不拉取外部关系。
- 登录失败限流（15 分钟内 10 次）。

### 6. 测试

- 新增 7 个后端集成测试（`services/api/tests/test_integration.py`），覆盖三人全流程、
  同段落冲突、人工合并、越权与跨项目隔离、会话可撤销、首登改密、上传安全校验。
- 新增 4 个客户端单元测试和 1 组真实服务器联调测试
  （`apps/desktop/src/tests/live.test.ts`，用**出货用的同一份 ApiClient** 去打真实后台）。
- 新增 `scripts/start-dev.ps1` 一键开发脚本。
- 重写根 `README.md`，按开发者 / 管理员 / 老师 / 学生四类读者分开写，普通用户章节
  不出现接口、Swagger、终端或浏览器登录字样。

### 7. 顺手修掉的真实缺陷

`POST /rounds/{id}/publish-result` 原来每次尝试都会先删掉本项目所有冲突记录，导致
老师在成功解决冲突后，冲突记录和「保留了哪一方」的结论一起消失，`conflict.resolution`
的写入实际上是一段死代码。现在改为按 `anchor` upsert：重试只更新未解决的冲突，已解决
的记录连同 `resolution` 一起保留，可回看。

还有一处更严重的：`src/lib/native.ts` 的 `pickDocx()` 拿到原生对话框返回的文件内容后
**忘了做 base64 解码**——Tauri 的 IPC 边界上二进制是 base64 过的，代码里那个
`Uint8Array` 标注只是编译期断言，不是运行时转换。结果就是**任何** `.docx` 传上去都是
一堆 base64 文本，服务端的 ZIP 校验必然失败，界面一律报「不是安全有效的 .docx
（可能已损坏或包含宏）」。修好之后随手新建一个只含几个字的 Word 文档也能正常上传。
如果你手上是更早构建的 `wordwork.exe`，重新打开一份新的即可。

### 8. Windows 单机部署（无域名、IP 直连）

课题组真实的「服务器」不是 Linux VPS，而是**一台常开的 Windows 台式机**，
而且**没有申请域名**。为此新增了一整条 Windows 部署路径，**不动原有 Docker 路径**：

- **HTTPS 怎么解决**：没有域名 ⇒ 申请不了 Let's Encrypt 证书；而客户端（`api.ts`
  的 `validateServerUrl`）硬性拒绝公网明文 `http://`。所以改用 **Caddy 的
  `tls internal`**：用自建 CA 签发真证书，SAN 里同时带上公网 IP、局域网 IP 和
  `127.0.0.1`。选 Caddy 而不是手工自签，是因为**它会自动续期**——手工证书一年后
  悄悄过期是最难排查的故障。
- **代价**：每台学生机要**一次性**安装这张根证书（有效期约 10 年）。这是没有域名的
  必然结果，没有更省事的合规替代方案。
- **老师自己的机器不用装证书**：API 只监听 `127.0.0.1:8000`，而回环地址在客户端的
  白名单里，所以教师端直连 `http://127.0.0.1:8000` 就行。8000 不对外，因此不需要
  防火墙放行，也不可能被用来绕过 TLS。
- **对外端口默认 8443**：大陆家宽普遍封入站 80/443。
- **开机自启**：API 和 Caddy 都用 **WinSW** 注册成 Windows 服务。`sc.exe` 撑不起
  uvicorn（SCM 不感知，会报 Error 1053），WinSW 是必须的。
- **工具全部走 winget**（微软 CDN，境内可达）：`Python.Python.3.12`、
  `CaddyServer.Caddy`、`CloudBees.WindowsServiceWrapper`。之前装 NSIS 时绕道
  ghproxy 下载 GitHub 的做法，在这条路径上不再需要。

---

## 二、重要文件改动

### 后端

| 文件 | 说明 |
| --- | --- |
| `services/api/app/main.py` | 重写。新增 `SessionToken` / `LoginAttempt` 表和 `must_change_password` 列；会话改数据库存储；CORS 白名单；新增鉴权、成员、文档、轮次、版本端点；`publish_result` 冲突 upsert 修复 |
| `.env.example` | 对齐新的服务端变量，删掉已废弃的 `WORDWORK_SECRET_KEY`，补上 `WORDWORK_DEV_ORIGINS` 等 |
| `services/api/tests/test_integration.py` | 新增，7 个端到端场景 |

### 桌面端

| 文件 | 说明 |
| --- | --- |
| `src/lib/api.ts` | 重写，完整 API 客户端 + SHA-256 + 中文错误分类 |
| `src/lib/store.tsx` | 新增，登录态 / 工作副本 / 离线队列 |
| `src/lib/native.ts` | Tauri 桥接，带浏览器降级 |
| `src/lib/format.ts` | 新增，时间 / 大小 / 片段位置 / 操作类型的中文格式化 |
| `src/types.ts` | 换成真实领域模型 |
| `src/App.tsx` | 新增，按状态在初始化 / 服务器设置 / 登录 / 工作区之间切换 |
| `src/components/*.tsx` | `ServerSetup` / `Login` / `Workspace` / `ProjectPage` / `RoundPage` / `ReviewWorkbench` / `MembersPanel` / `VersionsPanel` / `ui` |
| `src/tests/api.test.ts` | 新增 18 个测试（含错地址、非 JSON 响应、422 明细） |
| `src/tests/format.test.ts` | 新增 7 个测试 |
| `src/tests/live.test.ts` | 新增，默认跳过的真实服务器联调 |
| `src/tests/docx.ts` | 新增，测试用零依赖 DOCX 生成器 |
| 已删除 | `src/lib/mock.ts`、`src/lib/local.ts`、`src/tests/local.test.ts`、`vite.config.js`、`vite.config.d.ts`、若干 `.tsbuildinfo` |

### 原生层

| 文件 | 说明 |
| --- | --- |
| `src-tauri/src/main.rs` | 11 个 `#[tauri::command]`、DPAPI 封装、文件占用检测 |
| `src-tauri/Cargo.toml` | 依赖与 release 优化配置；`[[bin]]` 改名成 `wordwork`，与 `productName` 和 README 里给用户看的 `wordwork.exe` 对齐 |
| `src-tauri/tauri.conf.json` | 窗口、CSP、NSIS/MSI 打包、中文安装界面 |
| `src-tauri/capabilities/default.json` | 最小权限集 |
| `src-tauri/icons/*` | 由 `scripts/make-icon.py` 生成源图，再由 `tauri icon` 派生全套 |

### 脚本与文档

| 文件 | 说明 |
| --- | --- |
| `scripts/start-dev.ps1` | 新增，一键启动开发环境（带 UTF-8 BOM，否则 PowerShell 5.1 会按 GBK 解析中文而报语法错） |
| `scripts/make-icon.py` | 新增，零依赖 PNG 生成器 |
| `README.md` | 重写，四类读者分开；第二节增加 Windows 单机分支 |

### Windows 部署（新增）

| 文件 | 说明 |
| --- | --- |
| `deploy/windows/Caddyfile` | 站点地址来自 `{$WORDWORK_*}` 环境变量，一个文件适配所有环境；`tls internal` + `auto_https disable_redirects`（后者避免 Caddy 去抢 80 端口）+ 反代到回环 + 安全响应头 |
| `deploy/windows/wordwork.env.example` | Windows 版配置样例，注明数据库 URL 必须写成**三个斜杠**的 `sqlite:///C:/...`（四个斜杠是 POSIX 形式，会解析失败） |
| `scripts/windows/install.ps1` | 主脚本：检查工具链 → 建部署专用 venv → winget 装 Caddy/WinSW → 生成 env 与 Caddyfile → 建库并 bootstrap 管理员 → 注册两个服务 → 放行端口 → 关闭休眠 → 装根证书到本机信任库 |
| `scripts/windows/uninstall.ps1` | 停服务、注销服务、收回防火墙规则、撤掉证书信任；**默认不删数据**，要删得显式加 `-PurgeData` |
| `scripts/windows/export-ca.ps1` | 导出根证书并打印各平台安装步骤和指纹，供学生当面核对 |
| `scripts/windows/backup.ps1` + `backup_db.py` | 数据库用 SQLite 自己的 backup API（WAL 下也安全），文档对象用 robocopy；写 `manifest.txt` 记 sha256；可 `-Register` 注册每天 03:20 的计划任务 |
| `scripts/windows/restore.ps1` | 先校验完整性、比对 manifest 的 sha256，再把现有数据**挪到** `.pre-restore-<时间戳>`（不是删掉）后恢复 |
| `scripts/windows/diagnose.ps1` | 只读体检：服务、端口、`healthz`、证书有效期与信任、防火墙、电源、数据量、备份新鲜度、磁盘、内外网 IP 是否吻合 |
| `docs/DEPLOY-WINDOWS.md` | 面向管理员/老师的完整手册（含各平台装证书、搬家、故障排查） |

---

## 三、数据库与接口变化

### 数据库

新增表：

- `sessions`：`token_hash`（唯一索引）、`member_id`、`created_at`、`expires_at`、`revoked`
- `login_attempts`：`username`、`attempted_at`、`succeeded`

新增列（带增量迁移，老库自动补列）：

- `members.must_change_password`（`BOOLEAN DEFAULT 0`）

迁移策略是 `create_all` + 按 `PRAGMA table_info` 判断后 `ALTER TABLE ADD COLUMN`，
不会删改既有数据。

### 新增接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/auth/logout` | 作废当前会话 |
| `POST` | `/auth/change-password` | 改密码，作废该成员其它会话 |
| `GET` | `/projects/{id}/members` | 项目成员列表 |
| `GET` | `/projects/{id}/documents` | 项目文档列表 |
| `GET` | `/documents/{id}` | 文档详情（含项目名） |
| `GET` | `/rounds/{id}` | 轮次详情（含文档名、项目名、基准版本名） |
| `GET` | `/versions/{id}` | 版本详情 |

### 行为变化

- `GET /healthz` 增加 `engine_available` 字段，客户端可判断服务端是否装了 DOCX 引擎。
- 所有受保护接口未登录 / 会话失效统一返回 401 且带中文提示，客户端据此清会话。
- `POST /rounds/{id}/publish-result` 冲突时返回 409，`detail` 里带 `message` 和
  `conflicts` 数组；成功时保留冲突记录并把 `resolution` 写为所选作者名或 `auto`。

### 配置项

新增 `WORDWORK_DEV_ORIGINS`、`WORDWORK_ALLOWED_ORIGINS`、`WORDWORK_SESSION_DAYS`、
`WORDWORK_BOOTSTRAP_FORCE_CHANGE`。废弃 `WORDWORK_SECRET_KEY`（会话改为不透明令牌后
不再需要签名密钥）。

---

## 四、实际跑过的测试

| 内容 | 命令 | 结果 |
| --- | --- | --- |
| Python 全部测试 | `.venv/Scripts/python -m pytest services/api/tests packages/doc_engine/tests -p no:cacheprovider -q` | **14 passed**（引擎 6 + 既有接口 1 + 新增集成 7） |
| 前端单元测试 | `pnpm test` | **25 passed**，联调 6 个跳过 |
| 前端 + 真实服务器联调 | `WORDWORK_LIVE_API=http://127.0.0.1:8000 pnpm test` | **31 passed** |
| TypeScript | `pnpm typecheck` | 通过，无错误 |
| 前端构建 | `pnpm build` | 通过，`index-*.js` 189.86 kB（gzip 62.04 kB） |
| Tauri 构建 | `pnpm tauri build` | 通过，3m44s（含依赖编译）；产出便携 EXE + NSIS + MSI，见第五节 |
| 便携 EXE 冒烟 | 直接启动 `wordwork.exe` | 进程存活、窗口标题 `wordwork`、`Responding = True` |

### Windows 部署那条路径上实际跑过的

以上都是 Linux/开发环境的结论。Windows 单机部署这一轮，在一台真实的 Windows 11
机器上（就是准备拿来当服务器的那台）**真装真跑**过：

| 内容 | 命令 / 做法 | 结果 |
| --- | --- | --- |
| 服务端全部测试 | `.venv/Scripts/python -m pytest -q`（`services/api`） | **8 passed** |
| 前端全部测试 | `pnpm test` | **34 passed**（4 个文件，含 6 个联调） |
| 前端 + 真实部署的后端联调 | `WORDWORK_LIVE_API=http://127.0.0.1:8000 pnpm test` | **34 passed**，老师发布-学生提交-合并全流程走通 |
| TypeScript | `pnpm typecheck` | 通过，无错误 |
| Caddyfile | `caddy validate` | `Valid configuration`；`tls internal` 对**非本机的公网 IP** 也签出了证书 |
| 学生那条链路 | `Invoke-RestMethod https://192.168.1.10:8443/healthz` | `{"status":"ok","version":"0.2.0","engine_available":true}` —— **局域网学生要走的这条路端到端通了** |
| 备份 | `backup.ps1` | 数据库 102,400 B（**注意磁盘上主库文件只有 4 KB、其余在 502 KB 的 WAL 里**，naive 复制会得到一个空的库，用 `Connection.backup` 才拿全）、文档对象 5 个、manifest 写好 |
| 恢复 | `restore.ps1 -BackupDir ... -Force` | 完整性校验通过、sha256 与 manifest 一致；先删掉一个文档对象再恢复，对象列表与损坏前**完全一致**；旧数据完整挪到 `.pre-restore-<时间戳>` |
| 恢复后可用性 | 重启服务后再跑一遍联调测试 | 34 passed，说明恢复出来的库不只是「能起来」而是真能写 |
| 诊断 | `diagnose.ps1` | 除「服务未注册」（还没提权注册）和「防火墙规则」两条外全部 OK；证书有效期到 2036、SAN 覆盖、全链路 HTTPS 都通过 |

### 关于「界面能显示不等于功能完成」

真实服务器联调那一组测试是为了回应这条要求：它用的就是出货客户端里同一份
`src/lib/api.ts`，对着真实跑起来的 uvicorn 完整走一遍——

老师登录 → 建项目 → 加学生账号 → 上传初始 DOCX → 建轮次 → 发布轮次 →
学生登录 → 提交修改稿（带真实 SHA-256）→ 读差异 → 老师逐条接受 → 定稿 →
发布合并结果 → 校验合并结果里两处修改都在 → 下载版本 → 恢复历史版本 →
写批注 → 退出登录后令牌立即失效 → 学生越权请求被 403 拦下 → 错地址给出中文 network 错误。

跑完之后检查过服务器磁盘，确实落下了 1 个项目、2 个成员和 5 个内容寻址的 DOCX
对象（基准、提交、修订痕迹、贡献、汇总对照），说明按钮背后改的是真实数据。

---

## 五、产物路径

三种产物都已经**真实构建出来并跑过**，全部落在 `apps/desktop/src-tauri/target/release/`：

| 产物 | 路径 | 大小 | 说明 |
| --- | --- | --- | --- |
| 便携 EXE | `target/release/wordwork.exe` | 3,655,680 B（3.5 MB） | 免安装，双击即用 |
| NSIS 安装包 | `target/release/bundle/nsis/wordwork_0.1.0_x64-setup.exe` | 1,301,430 B（1.24 MB） | 中文安装界面，`currentUser` 模式（不需要管理员） |
| MSI 安装包 | `target/release/bundle/msi/wordwork_0.1.0_x64_zh-CN.msi` | 1,912,832 B（1.82 MB） | zh-CN 界面 |

（相对路径的基准目录是 `apps/desktop/src-tauri/`。`target/` 是构建目录，不进仓库。）

三者二进制头都验过：便携 EXE 是 `MZ` 的 x86-64 GUI PE，子系统 2，内嵌 manifest；
MSI 是 `d0cf11e0` 的 OLE 复合文档。便携 EXE 实际启动过一次，进程存活、
窗口标题为 `wordwork`、`Responding = True`，然后手动结束。

重建命令：

```bash
# 需要 node / cargo 在 PATH 上，另外按下面「构建工具链」把 MinGW 和 Tauri 的
# NSIS / WiX 缓存准备好
cd apps/desktop && pnpm tauri build          # 出便携 EXE + NSIS + MSI
cd apps/desktop && pnpm tauri build --no-bundle   # 只出便携 EXE
```

### 构建工具链（换机器要重做）

这台机器上的**工具链是环境级的，没有写进仓库**，换机器需要按下面的顺序重来一遍。

1. **MSVC 这条路在本机走不通**，别再浪费时间去修。经过是这样的：VS Build Tools
   安装器安静模式报 `Exit Code: 5007`（要求先提权）；提权后退出码为 0，但 Windows
   SDK 始终没装上——`C:\Program Files (x86)\Windows Kits\10\` 下只有 `Catalogs` 和
   `Redist`，没有 `Lib`、没有 `Include`，全盘找不到 `kernel32.lib`。控制面板里却挂着
   一条 "Windows SDK Desktop Libs x64 10.1.26100.7705"，`InstallLocation` 是空的，
   属于幽灵记录，所以 `winget install --force` 和 `winsdksetup.exe /q` 都被当成
   "已安装"直接跳过。

2. **改用 GNU 目标**（自包含，绕开 VS 安装器）：

   ```bash
   cd apps/desktop/src-tauri
   rustup target add x86_64-pc-windows-gnu
   rustup override set stable-x86_64-pc-windows-gnu
   ```

   注意 `rustup override` 把设置存在 rustup 自己的配置里（`D:\tools\wordwork\apps\desktop\src-tauri`），
   **不在仓库里**，换机器必须重新执行。

3. **rustup 自带的 MinGW 不够用**。它只带一个仅用于链接的 gcc（同目录的
   `GCC-WARNING.txt` 写明不能拿来编译 C），且**没有 `as.exe`**，dlltool 因此报
   `error calling dlltool 'dlltool.exe'` / `CreateProcess` 失败。改用完整 MinGW：

   ```bash
   winget install BrechtSanders.WinLibs.POSIX.UCRT
   ```

   装完把它的 `mingw64/bin` 放在 PATH 最前面（里面有 gcc 16.1.0、`as.exe`、
   `dlltool.exe`、`ld.exe`，以及 `../x86_64-w64-mingw32/lib/libkernel32.a`）。
   实测同一句 dlltool 从失败变为 exit 0。

4. **Tauri 打包工具下不下来**。`pnpm tauri build` 会去 GitHub Releases 拉 NSIS 3.11
   和 WiX 3.14，本机到 GitHub Releases 是直接超时的（`failed to bundle project:
   timeout: global`）。绕法是先用镜像把两个包提前塞进 Tauri 的缓存目录
   `%LOCALAPPDATA%\tauri\`：

   ```
   NSIS\nsis-3.11 的内容直接铺开            <- nsis-3.11.zip（sha1 EF7FF7...B10D）
   NSIS\Plugins\x86-unicode\additional\nsis_tauri_utils.dll   <- v0.5.3（sha1 75197F...B860）
   WixTools314\ 的内容直接铺开              <- wix314-binaries.zip（sha256 6ac824e1...3d31）
   ```

   用 `https://ghproxy.net/https://github.com/...` 前缀下载，三个文件按 Tauri 内置的
   sha1 / sha256 校验都对得上，之后 `pnpm tauri build` 就不再联网，两个安装包一次出。

5. **一条残留告警**：链接时 GNU ld 会打印
   `.rsrc merge failure: multiple non-default manifests`。这是 GNU 工具链合并资源清单
   的已知告警，不影响产物——已确认 EXE 里仍然有 manifest，且是 GUI 子系统。

---

## 六、测试账号与首次登录

演示账号只在**数据库为空**时由服务端自动创建。三个账号的初始密码都是
`wordwork-demo-change-me`：

| 账号 | 角色 |
| --- | --- |
| `teacher` | 老师 |
| `student1` | 学生 |
| `student2` | 学生 |

`must_change_password` 默认为真，所以**第一次登录一定会被要求改密码**，改完才能
进入工作区。这是刻意设计，避免默认密码被长期沿用。

正式部署请改掉自动建号逻辑，改用环境变量：

```
WORDWORK_BOOTSTRAP_TEACHER=你的老师账号
WORDWORK_BOOTSTRAP_PASSWORD=至少12位的密码
WORDWORK_BOOTSTRAP_FORCE_CHANGE=1
```

这些变量同样只在数据库为空时生效一次。之后的账号由老师在客户端里创建
（`POST /projects/{id}/members` 会顺带建号）。

客户端首次打开会先要求填服务器地址，本地开发填 `http://127.0.0.1:8000`。

---

## 七、未完成与已知问题

### 构建环境

三种产物都已经构建成功，路径见第五节。但**这台机器的工具链是手工拼出来的，没有
写进仓库**：MSVC 路线因为 Windows SDK 装不上而放弃，改用了 GNU 目标 + WinLibs MinGW，
Tauri 的 NSIS / WiX 也是手动塞进缓存目录的。换一台机器重新构建之前，请先照第五节
「构建工具链」那一节从头做一遍，尤其是 `rustup override set stable-x86_64-pc-windows-gnu`，
它不在仓库里。

### ~~一处小不一致~~（已于 2026-09-13 修复）

> 以下为当时的记录，保留下来是因为它解释了为什么安装包名字变成 `0.2.0`：
> 早先 `services/api/app/main.py` 里 FastAPI 的 `version` 是 `0.2.0`，而桌面端
> （`package.json` / `Cargo.toml` / `tauri.conf.json`）和三个安装包都是 `0.1.0`。
>
> **现状**：API、桌面端 `package.json`、`Cargo.toml`、`Cargo.lock`、`tauri.conf.json`
> 和 `wordwork-doc-engine` 的 `pyproject.toml` 已统一为 **0.2.0**。因此重新构建后，
> 安装包名会从 `wordwork_0.1.0_x64-setup.exe` 变成 `wordwork_0.2.0_x64-setup.exe`；
> 下面第五节里 `0.1.0` 的安装包路径与大小是**旧构建的产物**，只对得上 `0.1.0` 那一次。

### 功能上的取舍

- **没有做浏览器 UI 的自动化点击测试。** 本环境没有可用的浏览器自动化工具，所以
  「按钮真的调用了后台并改变了真实数据」是通过出货客户端代码打真实服务器的联调
  测试来证明的，而不是通过模拟点击。DOM 层面的交互没有自动化覆盖，建议下一个接手
  的人在能用浏览器的机器上补一层 Playwright 测试。
- **图片、公式、图表、域等复杂对象**一律按高风险结构块处理，不做自动合并，冲突时
  只能人工合并。这是 v1 的刻意选择，改动前请先读 `docs/ARCHITECTURE.md`。
- **插入和删除段落**目前也是 conflict-only，不参与自动合并。
- **macOS Keychain 未接**，非 Windows 平台的登录态是明文落盘的，只适合开发机。
- **登录态落盘用 DPAPI 绑当前用户**，换机器或换 Windows 用户后旧状态文件读不出来
  （代码里对读失败做了兜底，会退回登录页，不会崩）。

### Windows 部署还没验证的几件事

前面那张表里的验证都是在**没有提权**的情况下做的（`install.ps1 -NoServices` 模式 +
手工起进程），下面这几件必须有人点一下才算完：

- **注册成 Windows 服务**。需要一次 UAC 授权，而 UAC 提示没法自动化。跑
  `scripts\windows\install.ps1`（管理员）之后应确认 `Get-Service wordwork-api,wordwork-caddy`
  都是 `Running`。
- **重启后自动起来**。依赖上一条。`Restart-Computer` 之后两个服务应当自己恢复。
- **真的点一次上传**。原生文件对话框自动化不了，必须人工在教师端上传一个新建的
  `.docx`，确认不再报「不是安全有效的 .docx」。这是那个 base64 bug 的验收点。
- **外网到底通不通**。文档使用 TEST-NET 示例公网地址 `203.0.113.10`，实际部署时应替换为管理员自己的地址，
  但**大陆家宽很常见「看着有公网 IP、其实是运营商 CGNAT 大内网」或者封了入站端口**，
  而这一点**只能在外部验证**：让处在另一个网络的人执行
  `Test-NetConnection 203.0.113.10 -Port 8443`。`diagnose.ps1` 会给线索，
  但给不了结论。如果进不来，就得改用内网穿透或让运营商放行——不是脚本能解决的。

### 需要人工确认的产品行为

- 发布结果是不可逆的（轮次一旦 `published` 不能再回到 `open`）。目前用「恢复历史
  版本」来达到类似效果。如果实际使用中需要「撤回发布」，这是一个需要产品决策的改动。
- 学生之间是否允许互相看到批注正文，目前是允许的（同一项目成员都能读到某份提交的
  全部批注）。如果课题组的习惯是只让老师看，需要改 `list_comments` 的可见性。

---

## 八、下一个开发者应该先看什么

1. **先跑 `scripts/start-dev.ps1`**，确认后台起来、能登录、能建项目。这是最快的
   自检路径。
2. **再跑真实联调测试**（`WORDWORK_LIVE_API=http://127.0.0.1:8000 pnpm test`）。
   这一步能立刻暴露客户端与服务端的字段 / 路径错配，比读代码快得多。
3. **读 `services/api/app/main.py` 的 `publish_result`**。合并与冲突是最容易出问题的
   地方，也是这次修过 bug 的地方，改动前请先看 `packages/doc_engine` 里
   `merge_contributions` 的 `safe_keys` / `claimed` 逻辑。
4. **注意 `scripts/start-dev.ps1` 必须保留 UTF-8 BOM**，否则 PowerShell 5.1 会按 GBK
   解析中文并报出莫名其妙的语法错误。
5. **`src-tauri` 的构建工具链**没有写进仓库配置，是环境级的。换机器时按第五节的
   说明重新准备。
