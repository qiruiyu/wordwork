# CLAUDE_MANUAL_FIX_DELIVERY —— wordwork 真机验收缺陷修复交付报告

- 交付日期：2026-09-13
- 代码基线：`D:\tools\wordwork`（**本目录不是 git 仓库**，没有 commit 可作为基线；所有比对以文件当前内容为准）
- 依据：`CODEX_MANUAL_ACCEPTANCE_FIX_PROMPT.md`
- 交付范围：6 个缺陷（P0-1 / P0-2 / P0-3 / P1-1 / P1-2 / P2）的根因修复、自动化测试、Windows 便携 EXE 与安装包构建
- **没有动过**：`C:\ProgramData\wordwork` 下的数据库、对象、证书、日志、用户数据；**没有覆盖正在使用的 EXE**；**没有重启生产服务**

## 0. 结论速览

| 编号 | 问题 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| P0-1 | 下载到新文件名必报「Word/WPS 占用」 | 已修复 | Rust `WriteProbe` 枚举取代布尔值；6 条 Rust 单测 + 6 条前端组件测试 |
| P0-2 | 工作副本 / 离线队列跨账号串用 | 已修复 | `lib/accounts.ts` 按 `(服务器, member.id)` 分桶；13 条迁移与隔离测试 |
| P0-3 | 引擎版本不一致导致「完成审阅」稳定 500 | 已修复 | 行为式契约探测 + `/healthz` 契约字段 + 安装自检；5 条引擎契约测试 + 3 条 API 集成测试 |
| P1-1 | 复杂对象风险提示不明确 | 已修复 | 三分类 `Caveat` 横幅（设计限制 / 实际告警 / 处理要求）；4 条组件测试 |
| P1-2 | 红线审阅稿可直接恢复为正式主版本 | 已修复 | 服务端白名单 + 409 `version_kind_not_restorable`；前端同规则隐藏并说明 |
| P2 | 接受修改时页面闪烁 | 已修复 | 首屏之外不再整页 loading；就地更新决定状态；DOM 节点同一性测试 |

全部自动化测试在本机实跑通过：`pnpm test` 72 passed / 6 skipped、`pnpm typecheck` 无输出（干净）、`pytest` 56 passed、`cargo test` 6 passed，另有 6 条 live 联调测试打真实后端通过（见 §4）。

---

## 1. 每个问题的根因、修改文件与关键行号

### P0-1 下载到新文件名必然误报「Word/WPS 占用」

**根因**：`apps/desktop/src-tauri/src/main.rs` 里判断目标是否可写用的是
`OpenOptions::new().write(true).open(path)` 的**成功/失败布尔值**。目标文件不存在时该调用返回 `NotFound`，
被当成「文件没被释放」，于是调用方一律报「正被 Word/WPS 占用」；而预先创建同名文件再覆盖就成功。
同一个布尔值还把「父目录不存在」「只读/无权限」「路径是目录」全都压成同一句误导性提示。

**修改**：

| 位置 | 内容 |
| --- | --- |
| `apps/desktop/src-tauri/src/main.rs:215-230` | 新增 `WriteProbe` 枚举（`writable` / `locked` / `missing_parent` / `is_directory` / `denied` / `error{message}`），带 `state` 标签序列化给前端 |
| `apps/desktop/src-tauri/src/main.rs:238-247` | `classify_open_error()`：**先**查 `err.raw_os_error()` 是否为 32/33（`ERROR_SHARING_VIOLATION` / `ERROR_LOCK_VIOLATION`）判定为 `locked`，**再**看 `ErrorKind`——因为 Windows 会把这两个码映射到 `PermissionDenied`，顺序反了就会把 Word 占用说成权限问题 |
| `apps/desktop/src-tauri/src/main.rs:249-274` | `probe_write_target_at()`：目标不存在（`NotFound`）**单独分支**，改为判断父目录是否存在/是目录；父目录存在即为 `writable`，否则 `missing_parent` |
| `apps/desktop/src-tauri/src/main.rs:286-299` | `wait_for_write_target()` 只对 `locked` 做 500ms 轮询等待；`missing_parent` / `denied` / `is_directory` 立即返回，不再让界面空等到超时 |
| `apps/desktop/src/lib/native.ts:165-184` | 前端镜像类型 `WriteProbe`；`waitForWriteTarget()` 返回**原因**而非布尔值 |
| `apps/desktop/src/lib/native.ts:187-202` | `describeWriteProbe()`：把每种状态翻成一句可操作的中文提示 |
| `apps/desktop/src/lib/native.ts:211-220` | `saveDocument()` 成为**唯一**保存入口（工作副本 / 历史版本 / 红线稿 / 人工合并共用），调用方不再各自推断「是不是被占用」 |
| `RoundPage.tsx:95`、`ReviewWorkbench.tsx:125`、`VersionsPanel.tsx:56` | 三个下载入口统一改用 `native.saveDocument()` |

**busy 复位**：三处调用点都用 `try/finally` 包裹，取消保存对话框（`pickSavePath` 返回 `null`）与任何错误路径都会复位按钮——不再出现「长期显示下载中」。

### P0-2 本地工作副本和离线队列没有按账号隔离

**根因**：`apps/desktop/src/lib/store.tsx` 的持久化状态里 `workingCopies` / `queue` 是**全局单份列表**，
`upsertWorkingCopy` / `removeWorkingCopy` 只按 `roundId + baseVersionId` 匹配，没有服务器 / 账号 / 成员维度。
同一台 Windows 用户下多位学生轮流登录时，后登录者会看到前一位的「我的工作副本」，还带着指向别人文件的
「用 Word 打开」按钮；离线队列甚至可能把 A 的字节以 B 的身份补传上去。

**修改**：

| 位置 | 内容 |
| --- | --- |
| `apps/desktop/src/lib/accounts.ts`（新文件） | `normalizeServerUrl()`：去尾斜杠 + 转小写，避免 `http://Host:8000/` 与 `http://host:8000` 分叉成两个桶 |
| `apps/desktop/src/lib/accounts.ts:45-50` | `accountKey(serverUrl, memberId)` → `serverToken-m<memberId>`，**用数字 `member.id` 而不是用户名**（用户名只在单服务器内唯一，且可被重建）；没有账号时返回 `null`，**绝不**往共享桶里写 |
| `apps/desktop/src/lib/accounts.ts:54-71` | `bucketOf` / `withBucket` / `workingCopiesFor` / `queueFor`，读不到自己的桶就返回空数组，不会回落到别人的数据 |
| `apps/desktop/src/lib/store.tsx:133` | `memberKey` 由**当前会话**的 `state.serverUrl` + `state.session.member.id` 推导 |
| `apps/desktop/src/lib/store.tsx:343, 357, 427, 503` | 工作副本与队列的读写全部经 `bucketOf` / `withBucket` |
| `apps/desktop/src/lib/store.tsx:456-463` | 自动补传前**逐条复核** `item.owner === memberKey`；不一致就留在原账号桶里并提示，宁可不传也不冒名上传 |
| `apps/desktop/src-tauri/src/main.rs:161-182` | `save_snapshot(namespace, …)` 把快照落到 `snapshot_dir/<账号桶>/<sha256>.docx`；namespace 缺失直接报错 |
| `apps/desktop/src/lib/store.tsx:408` | 入队时以 `memberKey` 作为快照 namespace |

### P0-3 部署组件版本不一致导致「完成审阅」稳定返回 500

**根因（本机已现场复现）**：生产服务 venv 里装的仍是旧引擎。用服务自己的解释器跑自检：

```
引擎文件    : C:\ProgramData\wordwork\venv\Lib\site-packages\wordwork_doc_engine\__init__.py
引擎版本    : None（包元数据 0.1.0）
契约版本    : None
[FAIL] 部署自检未通过：
       - 引擎缺少 verify_contract()（0.1.0 及更早版本都有这个问题）
       - 契约版本不匹配：本 API 需要 2，实际 None
```

0.1.0 的 `apply_decisions()` 返回裸 `WindowsPath`，而 API 依赖结果对象的 `needs_manual_review` /
`warnings`，于是 `main.py:1054` 抛 `AttributeError`；同时 `/healthz` 只回 `engine_available: true`（= 能 import），
**完全无法暴露这种差异**，安装脚本也没有用部署解释器验证过引擎，所以故障一直藏到老师点「完成审阅」才爆。

**修改**：

| 位置 | 内容 |
| --- | --- |
| `packages/doc_engine/src/wordwork_doc_engine/engine.py:41` | `ENGINE_VERSION = "0.2.1"`（与 `pyproject.toml` 对齐，由 `/healthz` 上报） |
| `packages/doc_engine/src/wordwork_doc_engine/engine.py:43-49` | `ENGINE_CONTRACT_VERSION = 2`，并注明历史：`1` = 返回裸 `Path`；`2` = 返回 `ApplyResult` 且 `RedlineResult` 带 `warnings` |
| `packages/doc_engine/src/wordwork_doc_engine/engine.py:911-940` | `verify_contract()`：**行为式**探测——真造一个 `ApplyResult` / `RedlineResult`，检查 `needs_manual_review` 是 `bool`、`conflicts` / `warnings` 是 `list`，并核对五个入口函数是否可调用。**不做版本号比较**，因为旧部署正是「版本号相同、对象形状不同」 |
| `packages/doc_engine/src/wordwork_doc_engine/engine.py:943-952` | `engine_info()` 返回版本 / 契约 / `__file__` / 是否兼容 / 问题列表 |
| `services/api/app/main.py:1420` | `ENGINE_REQUIRED_CONTRACT = 2` |
| `services/api/app/main.py:1423-1461` | `engine_status()`；对**连 `verify_contract` 都没有**的 0.1.0 用 `getattr` 兜底成一条可读问题，而不是让 `/healthz` 自己抛 `AttributeError` |
| `services/api/app/main.py:633-649` | `/healthz` 新增 `status: ok\|degraded` 与 `engine_compatible` / `engine_version` / `engine_contract` / `engine_contract_required` / `engine_file` / `engine_problem` |
| `services/api/app/main.py:1464-1480` | `engine_api()` 依赖：契约不符直接 `503 {code: engine_contract_mismatch}`，**不会等到点「完成审阅」才失败** |
| `services/api/app/main.py:1070-1074` | finalize 的 `AttributeError` 兜底：回 500 并带 `code: engine_contract_mismatch` 方便查日志（只是兜底，不替代版本一致性） |
| `scripts/windows/engine_selfcheck.py:23` | `REQUIRED_CONTRACT = 2` |
| `scripts/windows/engine_selfcheck.py:50-73` | 打印实际 `__file__`（**证明加载的是哪个文件**）、引擎版本、包元数据版本、契约版本、Python 解释器；代码版本与元数据不一致、契约不符、或 `--expect-prefix` 之外的路径加载，任一命中即 `[FAIL]` 退出 1 |
| `scripts/windows/install.ps1:497-500` | 引擎安装改为 `--upgrade --force-reinstall --no-deps`（pip 对同版本本地目录会直接说「已满足」而不更新；引擎无必须一起装的依赖，`--no-deps` 安全） |
| `scripts/windows/install.ps1:521` | 安装收尾调用 `engine_selfcheck.py`，不通过即让**安装失败** |

**顺带修掉的真实漂移**（同一类 bug，不修则自检会正确地报错）：

- `services/api/pyproject.toml` 版本 `0.1.0` → `0.2.0`，与 `main.py` 里 `app.version = "0.2.0"` 一致。
- 开发 venv 里 editable 安装的包元数据停留在 `0.1.0`，已重装为 `0.2.1`。

**已确认不存在陈旧构建产物**：`packages/doc_engine/build` 与 `services/api/build` 都不存在，不会出现 `build/lib` 覆盖源码的情况。

### P1-1 复杂对象风险提示不够明确

**根因**：告警数据本身是有的（`redline_warnings`），但界面只把它当作一行小字，没有说明「公式内部差异**不会**在界面展开」「红线稿可能**没能**表达某些改动」「这些片段**必须**人工合并」这三件性质完全不同的事。老师因此把「公式不显示」理解成软件损坏。

**修改**：

| 位置 | 内容 |
| --- | --- |
| `apps/desktop/src/lib/format.ts:76-83` | `CAVEAT_LABELS`：`design`→「设计限制」、`warning`→「实际告警」、`required`→「处理要求」 |
| `apps/desktop/src/lib/format.ts:92-93` | `COMPLEX_OBJECT_CAVEAT`：一段说人话的说明，明确指出「这是设计取舍，不是文件损坏」，并让老师下载原文件与红线稿人工核对 |
| `apps/desktop/src/components/ui.tsx:81-99` | 新增 `Caveat` 组件，按 `kind` 取 info / warn / error 语气，并渲染分类标签 |
| `apps/desktop/src/styles.css` | `.banner.caveat` 左边框加宽、`.caveat-kind` 药丸标签样式 |
| `apps/desktop/src/components/RoundPage.tsx:264-271` | 提交列表**顶部**放「设计限制」横幅 |
| `apps/desktop/src/components/RoundPage.tsx:290-292` | 每个提交行：有 `redline_warnings` 就打「红线稿不完整」黄色标记，`title` 里是逐条人话解释 |
| `apps/desktop/src/components/ReviewWorkbench.tsx:189-217` | 差异窗口顶部按出现的实际情况渲染三种 Caveat：设计限制 / 实际告警（红线稿没能完整表达）/ 处理要求（必须人工合并） |

**没有**为了消除提示而把复杂对象转成纯文本，也**没有**静默删除图片、公式、域、超链接或字符格式。

### P1-2 历史红线审阅稿可直接恢复为当前主版本

**根因**：`restore` 端点对任何 `version.kind` 都放行；前端版本历史页对 `redline` 同样显示「恢复」按钮。
按业务语义，只有正式主版本、发布结果、人工合并结果、成员原始提交才该能成为主版本。

**修改**：

| 位置 | 内容 |
| --- | --- |
| `services/api/app/main.py:467-470` | `RESTORABLE_VERSION_KINDS = ("main", "submission", "manual_merge")` |
| `services/api/app/main.py:1350-1365` | `restore()` 非白名单直接 `409`，body 带 `code: version_kind_not_restorable`、`kind`、`restorable_kinds`——**服务端强制**，不是只把按钮藏起来，已知 version id 也绕不过去 |
| `apps/desktop/src/lib/format.ts:33-42` | `RESTORABLE_VERSION_KINDS` / `isRestorableVersion()`，与后端白名单一一对应 |
| `apps/desktop/src/components/VersionsPanel.tsx:134-143` | 白名单版本才给「恢复」按钮；非白名单显示「审阅用中间版本，不可恢复」并说明原因 |

**没有**改变「恢复 = 移动 `current_version_id` 指针 + 写审计」的语义，也没有覆盖或删除历史对象。

### P2 接受或「全部接受」时页面会闪一下

**根因**：每个决定都重跑整页 `load()`，加载期间把 `diff` 置空，导致差异弹窗被卸载重建——滚动位置、当前筛选丢失，视觉上就是每次操作闪一下。

**修改**：

| 位置 | 内容 |
| --- | --- |
| `apps/desktop/src/components/RoundPage.tsx:182` | `if (loading && !round) return <Spinner />;`——只有**首屏**（还没有数据）才整页转圈；刷新既有内容时不再卸载页面 |
| `apps/desktop/src/components/ReviewWorkbench.tsx`（`bulk()`） | 接受/全部接受成功后，用 `setDiff((current) => …map(…))` **就地**把已决定片段标成已接受，不再 `await load()` 重建；失败时才回滚/重载 |

服务端真实状态一致性没有被牺牲：局部更新只反映服务端已确认成功的决定，任何失败都会回退并以服务端为准。

### 附带的一致性修正（产品规则要求）

产品明确「学生在提交前即可查看并评论他人差异」是正常功能，因此修正了与之矛盾的旧文案：

- `README.md:245`：「**不必等自己提交**，随时都可以查看自己和同伴这一轮的差异、版本说明与批注，也可以在讨论区发言。但这些只是阅读，你**不能替老师做接受或拒绝**。」
- `apps/desktop/src/components/RoundPage.tsx:259`：界面同一措辞。
- `apps/desktop/src/lib/api.ts:126` 服务器地址示例、`ServerSetup.tsx:28,33` 占位符：从 `https://docx.example.com` 改为 `https://192.168.1.10:8443` 形状——本部署没有域名，走 `IP:端口`。

学生权限边界未动：接受/拒绝片段、完成审阅、跳过提交、解决冲突、恢复版本、发布结果仍然是老师专属，服务端 403 保持一致（有集成测试覆盖）。

---

## 2. 数据 / 状态迁移策略

### 2.1 客户端本地状态 v1 → v2

| 项 | 处理 |
| --- | --- |
| 版本号 | `STATE_VERSION = 2`（`accounts.ts:105`） |
| v1 的**全局** `workingCopies` / `queue` | **一律**移入 `orphaned`（`accounts.ts:157-165`），不归给任何账号 |
| 为什么不能直接归给当前登录者 | 持久化里的 session 是**最后一次登录**的账号，不一定是这些条目的作者。直接归属会**原样重现**本次要修的 bug：B 继承 A 的文件 |
| `orphaned` 的可见性 | 没有任何代码读、打开、监测、上传它；界面提示存在多少条旧数据，用户可以清除（`store.tsx:375-388`） |
| 磁盘上的旧快照 | **不删除**，留在原处；只是新代码不再读取。工作副本随手就能重新下载，误归属一次提交却无法挽回 |
| v2 状态 | 桶与 `orphaned` 原样保留，不会因为升级而丢数据 |
| 无法识别的状态（无 version / 未来版本 / 文件损坏） | 返回干净空状态（`accounts.ts:140`），绝不产生半填充状态 |
| 登出 / 切服务器 | 只切当前 `memberKey`，**不删除**任何桶——离线队列和工作副本可能在原账号下稍后恢复 |

对应测试见 §4 的 `accounts.test.ts`（13 条，含 v1 隔离、v1 无 owner 的队列、v2 往返、无法识别输入、A/B/C 同机隔离、换服务器隔离）。

### 2.2 服务端数据库

**没有 schema 变更，没有破坏性迁移。** 历史版本行原样保留，只是 `kind` 不在白名单的行不能再被「恢复」；
已发布轮次的 `base_version_id` 逻辑未改动，恢复当前主版本依旧不会改变旧轮次的基础版本（集成测试断言了这一点）。

### 2.3 引擎与快照

- 引擎是**可编辑安装**，修复靠重装（`--upgrade --force-reinstall --no-deps`），不涉及数据迁移。
- 快照目录新增 per-account 子目录（`snapshot_dir/<桶>/<sha256>.docx`）。旧扁平快照保持不动、不被新代码引用。

---

## 3. API—doc engine 契约版本的定义与「加载的是当前版本」的证明

### 3.1 定义

两个数字，含义不同，都必须一致：

- `ENGINE_VERSION`（当前 `0.2.1`）：引擎**代码**版本，与 `pyproject.toml` 对齐。
- `ENGINE_CONTRACT_VERSION`（当前 `2`）：**API 读取的结果对象形状**的版本。只有形状变化才递增：
  - `1` → `apply_decisions()` 返回裸 `Path`
  - `2` → `apply_decisions()` 返回 `ApplyResult`，且 `RedlineResult` 带 `warnings`

API 侧的期望值是 `services/api/app/main.py:1420` 的 `ENGINE_REQUIRED_CONTRACT = 2`，
与 `engine_selfcheck.py:23` 的 `REQUIRED_CONTRACT = 2` 必须同步。

### 3.2 三处证明（缺一不可）

1. **安装时（用服务实际使用的 Python）**：`scripts/windows/install.ps1:521` 调
   `scripts/windows/engine_selfcheck.py`，输出

   ```
   引擎文件    : D:\tools\wordwork\packages\doc_engine\src\wordwork_doc_engine\__init__.py
   引擎版本    : 0.2.1（包元数据 0.2.1）
   契约版本    : 2
   Python      : D:\tools\wordwork\.venv\Scripts\python.exe
   [OK] 引擎与 API 契约一致，部署可用。
   ```

   其中 `--expect-prefix <venv>\Lib\site-packages` 强制证明引擎**确实是从部署环境加载的**，
   而不是碰巧命中了开发源码目录。任何一项不符都打印 `[FAIL]` 并以退出码 1 让安装失败。

2. **服务启动后**：`GET /healthz` 不再只回 `engine_available`，而是

   ```json
   {"status":"ok","name":"wordwork","version":"0.2.0","engine_available":true,
    "engine_compatible":true,"engine_version":"0.2.1","engine_contract":2,
    "engine_contract_required":2,
    "engine_file":"D:\\tools\\wordwork\\packages\\doc_engine\\src\\wordwork_doc_engine\\__init__.py",
    "engine_problem":null}
   ```

   不兼容时 `status` 变 `degraded` 且 `engine_problem` 给出具体原因。**`engine_file` 让「加载的是哪个文件」可被直接读到**。

3. **请求路径**：`main.py:1464-1480` 的 `engine_api()` 依赖在不匹配时直接返回 503 `engine_contract_mismatch`；
   finalize 另有 500 兜底错误码。故障在第一次需要引擎的请求就被拦下，不会等到老师点「完成审阅」。

### 3.3 为什么是行为探测而不是版本号比较

本次事故里两边**版本号相同**（都自称 0.1.0），但结果对象形状不同。所以 `verify_contract()` 真造一个
`ApplyResult` / `RedlineResult` 去检查 API 实际读取的属性，而不是比对数字。`test_contract_probe_rejects_a_legacy_result_object`
用替身证明：即使版本号撒谎，探测也能识破。

---

## 4. 新增测试：名称、场景、通过数量与命令输出

### 4.1 新增/扩充的测试文件

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/main.rs`（`mod tests`） | 6 | P0-1 纯函数层 |
| `apps/desktop/src/tests/accounts.test.ts`（新） | 13 | P0-2 |
| `apps/desktop/src/tests/download-busy.test.tsx`（新） | 6 | P0-1 客户端 + P1-2 前端 |
| `apps/desktop/src/tests/review-stability.test.tsx`（新） | 4 | P1-1 + P2 |
| `apps/desktop/src/tests/harness.tsx`（新，非测试） | — | React 18.3 `act` + `createRoot` 渲染夹具 |
| `services/api/tests/test_engine_contract.py`（新） | 5 | P0-3 |
| `services/api/tests/test_integration.py`（追加） | 3 | P0-3 / P1-2 端到端 |

**P0-1（Rust）**：
`a_target_that_does_not_exist_yet_is_writable`、`an_unheld_existing_file_is_writable`、
`a_missing_parent_directory_is_reported_as_such`、`a_directory_target_is_not_a_writable_file`、
`a_read_only_file_is_reported_as_denied_not_locked`、
`a_file_held_open_by_another_process_is_locked`（用 `OpenOptionsExt::share_mode(0)` 复现 Word 的独占持有）。

**P0-2（`accounts.test.ts`）**：规范化服务器地址；按成员 id 而非用户名分桶；按服务器分桶；
无账号/无服务器时拒绝给键；键可直接作文件夹名；读不到自己的桶返回空数组；
`withBucket` 不改原对象；**v1 全局工作副本被隔离不自动归属**；v1 队列连 owner 都没有仍只进隔离区；
v2 往返完整；无法识别的状态变空状态；**A 的副本与离线项对 B、C 不可见且 A 再登录时仍在**；换服务器不串用。

**P0-1 + P1-2（`download-busy.test.tsx`）**：红线审阅稿没有「恢复」按钮并说明原因；
「恢复」用提交自己的版本 id 并把结果写回列表；**取消保存对话框后按钮立刻可用、不写文件也不报错**；
**文件被 Word 占用时给出可读提示并复位按钮**；下载接口本身失败也复位按钮；保存成功时按钮复位。

**P1-1 + P2（`review-stability.test.tsx`）**：`Caveat` 用不同标签和语气渲染三种类别；
提交列表顶部说明复杂对象不在此展开（设计限制）；差异窗口里三种情况同时出现且互不相同；
**revision 变化触发重新加载时弹窗还是同一个 DOM 节点**（这是「不卸载」的可观测证据）。

**P0-3（`test_engine_contract.py`）**：出厂引擎满足它自称的契约；契约探测能识破替身的旧结果对象；
契约探测能报出缺失入口；自检脚本在当前解释器上通过；**自检脚本拒绝一个伪造的 0.1.0 引擎**
（写进临时目录并用 `PYTHONPATH` 抢先于 site-packages，断言退出码 1 与 `[FAIL]`）。

**P0-3 / P1-2（`test_integration.py` 追加）**：
`test_healthz_proves_the_engine_contract_instead_of_just_an_import`（`/healthz` 必须证明契约而不只是能 import）；
`test_the_api_refuses_to_finalize_against_an_incompatible_engine`（健康检查转 `degraded`，finalize 返回 503 `engine_contract_mismatch`）；
`test_only_promotable_version_kinds_can_become_the_main_version`（红线/摘要红线/成员贡献/草稿 → 409；
学生 → 403；`submission` → 200；恢复后轮次 `base_version_id` 不变）。

### 4.2 实跑命令与输出摘要（本机，2026-09-13）

```
> cd apps\desktop && pnpm test
 Test Files  9 passed | 1 skipped (10)
      Tests  72 passed | 6 skipped (78)          ← 6 条 live 测试默认跳过；见下

> cd apps\desktop && pnpm typecheck
（tsc -b --pretty false，无输出 = 无错误）

> .\.venv\Scripts\python.exe -m pytest services\api\tests packages\doc_engine\tests -p no:cacheprovider -q
56 passed, 2 warnings in 20.17s

> cd apps\desktop\src-tauri && cargo test
running 6 tests
test tests::a_missing_parent_directory_is_reported_as_such ... ok
test tests::a_directory_target_is_not_a_writable_file ... ok
test tests::an_unheld_existing_file_is_writable ... ok
test tests::a_target_that_does_not_exist_yet_is_writable ... ok
test tests::a_read_only_file_is_reported_as_denied_not_locked ... ok
test tests::a_file_held_open_by_another_process_is_locked ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

**live 联调（打真实后端，非 mock）**：

```
> WORDWORK_LIVE_API=http://127.0.0.1:8012 WORDWORK_LIVE_TEACHER_PASSWORD=*** pnpm vitest run src/tests/live.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

> 说明：这 6 条跑在**临时实例**（`WORDWORK_DATA_DIR` 指向临时目录、端口 8012）上，**没有碰生产服务**。
> 生产 `wordwork-api` / `wordwork-caddy` 仍在跑旧构建（见 §6），所以我不能用它来验收新代码。

**安装自检（本机开发 venv）**：

```
> .\.venv\Scripts\python.exe scripts\windows\engine_selfcheck.py
引擎文件    : D:\tools\wordwork\packages\doc_engine\src\wordwork_doc_engine\__init__.py
引擎版本    : 0.2.1（包元数据 0.2.1）
契约版本    : 2
Python      : D:\tools\wordwork\.venv\Scripts\python.exe
[OK] 引擎与 API 契约一致，部署可用。
```

**安装自检（生产 venv，修复前状态，作为 P0-3 的现场证据）**：

```
> C:\ProgramData\wordwork\venv\Scripts\python.exe scripts\windows\engine_selfcheck.py
引擎文件    : C:\ProgramData\wordwork\venv\Lib\site-packages\wordwork_doc_engine\__init__.py
引擎版本    : None（包元数据 0.1.0）
契约版本    : None
[FAIL] 部署自检未通过： … 引擎缺少 verify_contract() … 契约版本不匹配：本 API 需要 2，实际 None
```

### 4.3 关于 spec 里 6 条端到端回归的完成度

| # | 回归项 | 状态 |
| --- | --- | --- |
| 1 | 新路径下载成功、SHA-256 一致；已打开文件被拦截；取消不假死 | **自动化已覆盖**（Rust 6 条 + `download-busy` 6 条）；真机点击见 §6 |
| 2 | A/B/C 同机轮流登录，工作副本与离线队列严格隔离 | **自动化已覆盖**（`accounts.test.ts` 13 条）；真机登录见 §6 |
| 3 | 干净目录按安装脚本部署，确认加载当前引擎与契约 | 自检脚本已具备并实测；**真正从零部署需管理员权限**，见 §6 |
| 4 | 普通提交审阅后变 `reviewed`、发布条件正确；复杂对象走人工/跳过、不 500、不丢对象 | live 测试已跑通「上传→决策→finalize→发布」；`redline_warnings` 路径已由组件测试覆盖 |
| 5 | 恢复历史后既有轮次 `base_version_id` 不变 | **集成测试已断言** |
| 6 | 学生仍能查看并评论；老师专属端点继续 403 | 集成测试已断言 403 边界 |

---

## 5. 新构建产物、SHA-256、版本号、部署与回滚

### 5.1 产物（构建于 2026-09-13 18:50，输出到独立 target 目录，**未覆盖在用 EXE**）

| 产物 | 路径 | 大小 | SHA-256 | 版本 |
| --- | --- | --- | --- | --- |
| 便携 EXE | `D:\tools\wordwork\build\manual-fix\release\wordwork.exe` | 3,671,552 | `BEA07DA6142B8EB3C4BE5BE5D03BB8AF2F7597C7C011289C1EB7040C65F84D58` | 0.2.0 |
| NSIS 安装包 | `D:\tools\wordwork\build\manual-fix\release\bundle\nsis\wordwork_0.2.0_x64-setup.exe` | 1,311,315 | `80ADD92F06515BAF210F984E2CE6919EF2D72B0AF68226EA1C15ACD4AA52A8A9` | 0.2.0 |
| MSI 安装包 | `D:\tools\wordwork\build\manual-fix\release\bundle\msi\wordwork_0.2.0_x64_zh-CN.msi` | 1,921,024 | `F98AA7D1859E1397147871BC33F466ECC49FA133C4769959A96194C4EBEBA020` | 0.2.0（取自产物名与产品版本，MSI 不走 PE 版本头） |

为对比，**正在使用、未被触碰**的客户端 EXE：

| 产物 | 路径 | SHA-256 | 文件时间 |
| --- | --- | --- | --- |
| 在用 EXE（旧） | `D:\tools\wordwork\apps\desktop\src-tauri\target\release\wordwork.exe` | `0A7F0072BFF1556E42D19DCB05FD35FC50E8DEE64FDC65F969D6614AC08FA4EC` | 2026-09-13 15:53 |

构建期有一条**长期存在的外观性告警**（非本次引入，产出 EXE 可正常运行）：
`ld.exe: .rsrc merge failure: multiple non-default manifests`。

### 5.2 服务端部署（需要管理员 / 一次 UAC）

1. 以**管理员**身份打开 PowerShell。
2. 运行 `D:\tools\wordwork\scripts\windows\install.ps1`。
   它会重装引擎（`--force-reinstall`）、重写 `C:\ProgramData\wordwork\wordwork.env`（幂等）、
   用**服务实际使用的 Python** 跑 `engine_selfcheck.py`；**自检不通过则安装失败**，不要忽略。
3. 确认 `Get-Service wordwork-api, wordwork-caddy` 均为 `Running`。
4. 验收：`curl http://127.0.0.1:8000/healthz` 必须出现 `engine_contract: 2` 与 `engine_compatible: true`，
   且 `status` 为 `ok`。公网健康检查只返回引擎文件名，不公开服务器绝对路径；完整路径由本机安装自检输出。
5. 可选：`Restart-Computer` 后确认两个服务仍是 `Running`（开机自启验证）。

### 5.3 客户端部署（老师端 / 学生端）

- 老师端：把 §5.1 的便携 EXE 或安装包装上即可。老师端连 `http://127.0.0.1:8000`，**不需要证书**。
- 学生端：安装包安装时选择安装目录；学生需要先导入服务器根证书（`scripts/windows/export-ca.ps1` 导出的
  `wordwork-root.crt`），再填 `https://<公网IP>:8443` 或 `https://<局域网IP>:8443`。
- **不要**用新 EXE 直接覆盖正在运行的 `apps\desktop\src-tauri\target\release\wordwork.exe`——请先关掉客户端。

### 5.4 回滚

- **客户端**：旧 EXE 仍在 `apps\desktop\src-tauri\target\release\wordwork.exe`（SHA-256 `0A7F0072…`），
  未被覆盖，直接重新运行即可回滚。文件形态的替换唯一影响是本地 `STATE_VERSION` 从 2 回到 1：
  v2 状态在旧客户端里会被判为「无法识别」→ 干净空状态，**工作副本与离线队列会看不到**（原文件仍在磁盘，
  不会丢数据）。回滚前如需保留队列，先联网补传。
- **服务端**：引擎是 editable 安装，回滚相当于把 `packages/doc_engine` 切回旧代码后重跑 `install.ps1`。
  **数据库无 schema 变更**，所以服务端回滚不需要数据还原。注意旧引擎会让 `/healthz` 退回
  `engine_available: true` 的旧形状，新客户端仍能工作，但 P0-3 的故障会复现——不建议回滚这一步。

---

## 6. 仍未完成 / 必须人工真机验证的事项

**以下事项我没有做，也不会宣称已经通过：**

1. **生产服务仍运行旧构建**。实测 `http://127.0.0.1:8000/healthz` 与 `https://127.0.0.1:8443/healthz` 仍返回
   `{"status":"ok","name":"wordwork","version":"0.2.0","engine_available":true}`，**没有** `engine_contract` 字段；
   `C:\ProgramData\wordwork\venv` 里仍是 0.1.0 引擎。要生效必须由管理员重跑 `install.ps1`（§5.2）。
   我**没有**重启服务，也**不应**在未经批准时重启。
2. **两个 Windows 服务的注册/重启需要一次 UAC 授权**，我无法自动提权。
3. **新 EXE 没有以 GUI 形式在本机启动过**。我只做了「构建成功 + 前端产物确含新文案」的校验；
   桌面窗口、原生保存对话框、原生上传对话框都必须人工点一次。
4. **上传回归**：请老师在**教师端新建一个只含一行文字的 docx 并实际上传一次**，确认不再报
   「不是安全有效的 .docx」。原生文件对话框无法自动化。
5. **外网可达性**：需从 4G / 校外机器 `Test-NetConnection 203.0.113.10 -Port 8443`（部署时替换为真实地址）。
   大陆移动家宽可能有 CGNAT 或封端口，只能从外部验证。
6. **§4.3 表的第 1 项（真机点击下载）和第 2 项（真机轮流登录 A/B/C）**：自动化已覆盖逻辑，
   但「真机上点一遍」尚未做。
7. **端到端回归 #4 的复杂对象分支**：live 测试跑的是纯文字提交；含公式提交的人工处理 / 跳过流程
   只由组件测试与 `redline_warnings` 渲染测试覆盖，未在真机上跑过含公式的完整一轮。

---

## 7. 下一位审查者：10 分钟最小真机回归清单

前置：让管理员先跑一次 `install.ps1`（§5.2），确认 4 步里的 `/healthz` 出现 `engine_contract: 2`。
然后用 §5.1 的便携 EXE 或安装包启动客户端。

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 老师登录 → 建项目 → 加学生 → 上传一个**新建的、只含一行文字**的 docx → 发布第 1 轮 | 上传成功，不再报「不是安全有效的 .docx」 |
| 2 | 老师在该轮点「下载工作副本」，在保存对话框里输入一个**全新文件名** | **立刻**开始写盘并提示成功；**不得**出现「正被 Word/WPS 占用」，按钮不长时间转圈（这是 P0-1 的核心回归点） |
| 3 | 用 Word 打开刚下载的文件，再次下载到**同一个路径** | 提示「文件正被 Word/WPS 占用」；关闭 Word 后重试成功 |
| 4 | 上一步的保存对话框里直接点「取消」 | 按钮**立刻**恢复可用，不写文件、不弹错误 |
| 5 | 学生 A 登录 → 下载工作副本 → **不改密也要点开「我的工作副本」看一遍** → 退出 → 学生 B 登录 | B 的「我的工作副本」**为空**，看不到 A 的文件、也没有指向 A 路径的「用 Word 打开」（P0-2 核心回归点） |
| 6 | A 再登录 | A 自己的条目**仍在** |
| 7 | 学生提交一个含**公式**的修改；老师打开该提交的差异窗口 | 顶部有「设计限制」横幅；若有告警另有「实际告警」横幅；要人工合并时有「处理要求」横幅；三者在视觉上互不相同（P1-1） |
| 8 | 老师对一条片段点「接受」，再点「全部接受」 | 页面**不闪**，差异弹窗不重新出现、滚动位置不跳（P2） |
| 9 | 老师点「完成审阅」 | **不出现 500**；提交状态变 `reviewed`；`完成审阅 n/n` 计数正确（P0-3 核心回归点） |
| 10 | 打开版本历史 | 主版本 / 成员提交 / 人工合并结果有「恢复」按钮；**红线稿、摘要红线、草稿显示「审阅用中间版本，不可恢复」而没有按钮**（P1-2） |
| 11 | 恢复一个历史版本，再看某一已发布轮次 | 恢复成功；该轮次的 `base_version_id` **不变** |
| 12 | 以学生身份调用一个老师专属端点（或在 UI 上确认按钮不可见） | 服务端返回 **403**；学生仍能查看并评论他人已提交内容 |
| 13 | `curl http://127.0.0.1:8000/healthz` | `engine_contract: 2`、`engine_compatible: true`、`status: ok`；`engine_file` 只含文件名，不泄露绝对路径 |
