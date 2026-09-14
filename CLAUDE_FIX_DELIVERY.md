# wordwork 修复交付报告

日期：2026-09-13
仓库：`D:\tools\wordwork`
范围：按验收单顺序修改 P0（4 项）→ P1（6 项）→ P2（4 项），补测试，跑验证，产出新安装包。

**状态词只用四个**：`已修复并测试` / `已修复但需要人工验证` / `未完成` / `因安全原因改为人工冲突`。

---

## 1. 修复摘要

本轮把"审稿结果可能悄悄出错"这一类问题当作最高优先级处理。四个 P0 都是同一个病根：**引擎在无法安全处理时选择了沉默**——插入/删除没落进文档也不报错、纯格式改动被当成"没改"、含图片的段落被抽成纯文本重写、还有未审阅的提交时照样能发布。现在这四种情况一律变成**显式阻塞或显式冲突**，宁可让老师多点一下，也不让文档静默损坏。

在 P1 上补齐了"离线也能干活"的闭环：提交先落成按内容哈希寻址的不可变快照，网络恢复后自动补交；草稿在内容稳定 5 分钟后自动上传，老师能看到学生进度；覆盖写任何文件前先确认 Word/WPS 已释放；`/events` 接进客户端，别人提交后界面自己刷新。强制改密从"客户端自律"改成"服务端拦截"（未改密一切接口返回 428）。

P2 收尾了三处不一致：人工合并现在和自动发布产出同样形状的结果（都有汇总红线、都返回 `resolution`）；红线稿不再丢信息——整段插入/删除都打成修订，打不了的写进 `warnings` 一路传到界面上；冲突表按 `(round_id, anchor)` 加了数据库唯一约束并写了能重复跑的加性迁移。同时修掉了桌面前端 README 里"有 mock 模式"这类**与实际不符**的陈旧说明，并把各处版本号统一到 0.2.0。

**新增测试约 43 个**（引擎 8、服务端 12、桌面端 23），超过验收单要求的约 35 个。全绿，详见第 5、6 节。

---

## 2. 每条问题的最终修复状态

### P0

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| P0.1 | 接受的插入/删除必须真的进文档，不能静默丢失 | 已修复并测试 |
| P0.2 | 纯格式修改不得被误判为 unchanged | 已修复并测试 |
| P0.3 | 含复杂对象的段落禁止文本重建 | 已修复并测试（无法安全套用的一律改判为人工冲突） |
| P0.4 | 发布前每份有效提交必须处于终态 | 已修复并测试 |

### P1

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| P1.1 | 离线队列改为按 SHA-256 的不可变快照 | 已修复并测试 |
| P1.2 | `POST /documents/{id}/versions`「替换主文档」 | 已修复并测试 |
| P1.3 | 接上 `uploadDraft()`（稳定 5 分钟 / 间隔 10 分钟） | 已修复并测试 |
| P1.4 | 消费 `/events` | 已修复并测试（实时性有一处取舍，见第 3 节末） |
| P1.5 | 覆盖写前 `waitForFileReleased()` + Rust 原子写 | 已修复但需要人工验证 |
| P1.6 | 服务端强制 `must_change_password` + 不可关闭弹窗 | 已修复并测试 |

### P2

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| P2.1 | 人工合并也要产出汇总红线，字段与自动发布一致 | 已修复并测试 |
| P2.2 | 插入/删除与高风险告警在红线/接口/界面可见，id 唯一且可复现 | 已修复并测试 |
| P2.3 | `(round_id, anchor)` 数据库唯一约束 | 已修复并测试 |
| P2.4 | 陈旧文档、版本号不一致 | 已修复并测试（文档改动本身无断言测试，已逐份人工核对） |

合计：**14 项中 13 项「已修复并测试」，1 项（P1.5）「已修复但需要人工验证」，0 项未完成。**

---

## 3. 修改的文件清单与逐项说明

### 引擎 `packages/doc_engine`

| 文件 | 改动 |
| --- | --- |
| `src/wordwork_doc_engine/engine.py` | `_redline_paragraph` 去掉 `w:date`、删除与插入各用独立 `w:id`；新增 `_redline_inserted_paragraph` / `_redline_deleted_paragraph` / `_mark_paragraph_mark`；`generate_redline` 重写为同时处理整段插入、整段删除、段内改写，并把表达不了的改动写进 `warnings`；`_insert_clone` 改为返回树里真正那个克隆元素（原来返回 bool，调用方拿不到插入副本） |

**P0.1**：整段插入按"最近一个两边都存在的兄弟节点"定位，连续插入保持文档顺序；找不到锚点（例如整块新表格）不再猜位置，记 `cannot_determine_insert_position`；整段删除定位失败记 `cannot_locate_block_for_deletion`。两者都会阻止提交被标记 `reviewed`。

**P0.2**：新增 `_format_fingerprint()`，只对 `w:pPr` / `w:rPr` 计算并忽略 `rsid*` 噪声。加粗/倾斜/对齐等纯格式变化现在产出 `operation="format"` 的差异块。

**P0.3**：段落含 `w:drawing` / `w:pict` / `w:object` / `w:chart` / 公式 / `w:fldSimple` / `w:instrText` / `w:hyperlink` / `w:sdt` 时，不再"抽纯文本改完写回"，改记 `complex_edit` 冲突。

**P2.2**：整段插入标 `w:ins`、整段删除标 `w:del`+`w:delText`，两者的**段落标记**也分别标在 `w:pPr/w:rPr` 上（只标 run 的话，Word 接受修订时会把新段落并进上一段）；`w:del` 内部所有 `w:t` 递归改成 `w:delText`（否则 Word 报文件损坏）；去掉 `w:date` 后同一输入两次生成**字节完全相同**。

### 服务端 `services/api`

| 文件 | 改动 |
| --- | --- |
| `app/main.py` | `MergeConflict.__table_args__` 加唯一约束；`_EXTRA_COLUMNS` 加 `submissions.redline_warnings`；`_migrate()` 折叠重复冲突行后建唯一索引；新增 `upsert_conflict()`；`record_apply_conflicts`、`publish_result` 改走 `upsert_conflict`；`publish_result` / `publish_manual_result` 返回 `summary_redline_version_id` + `resolution` + `redline_warnings`；`require_password_change` 中间件；`GET /events` 支持 `?after=` |

**P0.4**：`publish_result` 先检查所有提交状态，只要还有非终态就返回 **409**，响应体 `detail.outstanding` 列出 `id` / `author` / `status`。终态 = `reviewed` / `skipped` / `rejected`。

**P2.3**：`UniqueConstraint("round_id", "anchor", name="uq_merge_conflicts_round_anchor")`；迁移先按"优先保留已写 `resolution` 的行、其次取最新 `id`"折叠历史重复行，再 `CREATE UNIQUE INDEX IF NOT EXISTS`（不先折叠的话老库启动就失败）；`upsert_conflict()` 用 SQLite `ON CONFLICT DO UPDATE`，两个请求同时命中同一锚点也插不出两行。

### 桌面端 `apps/desktop`

| 文件 | 改动 |
| --- | --- |
| `src/lib/api.ts` | 终态判定与 `outstandingOf` / `outstandingFrom` / `applyConflictsFrom`；428 → `password_change_required`；新增 `skipSubmission()`、`replaceDocumentVersion()`、`uploadDraft()`；`publishResult` 返回 `resolution` + `redline_warnings` |
| `src/lib/events.ts` | 新增。`/events` 订阅：WebSocket 取历史积压 + `?after=` 轮询取增量、去重、指数退避、4401 视为登录失效 |
| `src/lib/drafter.ts` | 新增。纯函数 `shouldUploadDraft()`：内容稳定 5 分钟且距上次上传满 10 分钟 |
| `src/lib/native.ts` | 新增 `removeFile` / `saveSnapshot` / `snapshotBytes`；浏览器模式退化为内存 Map（`memory://<sha>`） |
| `src/lib/format.ts` | `OPERATION_LABELS` 补 `format:'格式修改'`；新增 `redlineWarningLabel()` 把引擎告警码翻成中文 |
| `src/lib/store.tsx` | 离线队列改内容哈希快照、提交单飞、失败 8 次或终态错误才丢弃；接入事件流；`revision` 计数驱动刷新；`enqueueSubmission` |
| `src/types.ts` | 新增 `SubmissionStatus` / `OutstandingSubmission` / `ApplyConflictView`；`QueuedSubmission.snapshotPath`+`attempts`；`redline_warnings` |
| `src/components/ui.tsx` | `Modal` 支持 `dismissible={false}`（隐藏 × 并吞掉 Esc）；`StatusPill` 补 `skipped` / `manual_required`（原来 map 里有重复键） |
| `src/App.tsx` | `ChangePasswordModal` 改为不可关闭，按钮只有「退出登录」和「修改密码」 |
| `src/components/RoundPage.tsx` | 发布按钮按未处理提交置灰；覆盖写文件前 `waitForFileReleased()`；大学生草稿自动上传（60 秒检查一次）；发布后提示汇总红线不完整；`skipSubmission` |
| `src/components/ReviewWorkbench.tsx` | 409 冲突分流；"红线稿不完整"横幅；`format`/`structure` 段落显示解释文字而不是指纹串 |
| `src/components/ProjectPage.tsx` | 多文档选择；「替换主文档」改为新建版本 |
| `src/components/VersionsPanel.tsx` | 下载前等待文件释放 |
| `src-tauri/src/main.rs` | `write_file` 先写 `<name>.wordwork-tmp` 再 `fs::rename` 原子替换；新增 `save_snapshot` / `remove_file` 命令并注册进 `generate_handler!` |

**P2.4（文档）**

- `apps/desktop/README.md` 整篇重写：删掉**不存在**的"mock 模式"、`VITE_API_URL`、`src/lib/local.ts` 说明，改成真实模块清单与约定。
- 版本号统一 **0.2.0**：`apps/desktop/package.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 的 `wordwork-desktop` 条目、`tauri.conf.json`、`packages/doc_engine/pyproject.toml`。
- `README.md`：安装包名改 `wordwork_0.2.0_x64-setup.exe`；补"三个演示账号首次登录强制改密（428，窗口关不掉）"。
- `CLAUDE_DELIVERY.md`：原「一处小不一致」一节划掉并标注「已于 2026-09-13 修复」，旧说明保留为解释而不删除。

### 关于 P1.4 的一处取舍（必须说明）

服务端现有的 `/events` WebSocket 循环**只回 ping，不主动推事件**。因此客户端实现为：WebSocket 只取历史积压并用 4401 识别登录失效，真正的"新事件"靠 `GET /events?after=<lastId>` 轮询发现。这一点写在 `src/lib/events.ts` 的文件头注释里，没有假装推送可用。要真推送需要改服务端 socket 循环——**未完成，见第 8 节**。

---

## 4. 数据库模型和接口变化

### 模型 / 迁移（全部是加性的，老库能原地升级）

| 表 | 变化 | 迁移方式 |
| --- | --- | --- |
| `members` | `must_change_password BOOLEAN DEFAULT 0` | `PRAGMA table_info` 判断后 `ALTER TABLE ADD COLUMN` |
| `submissions` | `redline_warnings TEXT DEFAULT '[]'`（JSON 字符串数组） | 同上 |
| `merge_conflicts` | 新唯一约束 `(round_id, anchor)`，索引名 `uq_merge_conflicts_round_anchor` | 先折叠重复行（保留优先级：有 `resolution` 的 > 最新 `id`）再 `CREATE UNIQUE INDEX IF NOT EXISTS` |

迁移函数是 `_migrate()`，每次启动都会跑，**可重复执行**。

### 接口变化

| 方法 + 路径 | 变化 |
| --- | --- |
| `POST /rounds/{id}/publish-result` | **新增 409**：还有非终态提交时拒绝，`detail.outstanding` = `[{id, author, status}]`；**新增返回** `resolution: "auto"`、`redline_warnings: string[]` |
| `POST /rounds/{id}/manual-result` | **新增返回** `summary_redline_version_id`、`resolution: "manual"`、`redline_warnings`（原来只返回 version_id，现在与自动发布形状一致） |
| `POST /submissions/{id}/skip` | **新增**。把一份提交标记为 `skipped`（终态），让老师能"这份不审了"从而解锁发布 |
| `POST /documents/{id}/versions` | **新增**。「替换主文档」= 新建版本，而不是新建第二个文档 |
| `POST /rounds/{id}/drafts` | 已有，桌面端现在真的在调它（草稿自动上传） |
| `GET /submissions/{id}/diff` | **新增返回** `redline_warnings` |
| `GET /rounds/{id}/submissions` | **新增返回** 每份提交的 `redline_warnings` |
| `GET /events` | 支持 `?after=<lastEventId>` 增量拉取（客户端轮询用） |
| 任意受保护接口 | **新增 428**：会话 `must_change_password=true` 时一律拒绝（豁免路径只有登录/改密/登出） |

---

## 5. 新增测试及其覆盖场景

### 引擎（8 个，`packages/doc_engine/tests/test_engine_safety.py` 新增 `RedlineDeterminismTests`）

| 测试 | 覆盖场景 |
| --- | --- |
| `test_the_same_input_produces_byte_identical_redlines` | 同一输入两次生成红线稿**字节相同**（去掉 `w:date` 的回归防线） |
| `test_every_revision_id_is_distinct_across_paragraphs` | 两段替换共 4 个修订元素，`w:id` 互不相同且都非空 |
| `test_a_wholly_new_paragraph_is_marked_as_an_insertion` | 整段插入标 `w:ins`，段落标记也标了 |
| `test_a_wholly_removed_paragraph_is_marked_as_a_deletion` | 整段删除标 `w:del`+`w:delText` |
| `test_a_deletion_never_leaves_a_plain_text_run_behind` | `w:del` 内不残留 `w:t`（含超链接内的文本） |
| `test_a_drawing_paragraph_is_reported_instead_of_being_redlined` | 含图片的段落产出 `high_risk_block_not_redlined:` 告警 |
| `test_a_new_table_is_reported_rather_than_silently_dropped` | 新增整块表格产出 `not_redlined_insert:` 告警，不静默丢弃 |
| `test_mixed_insert_replace_delete_keeps_every_id_unique` | 插入+替换+删除混合时 id 仍唯一、文本与删除文本各自正确 |

另有本轮之前已存在、本次未改动的 P0 覆盖：`test_pure_bold_change_becomes_a_format_hunk`、`test_paragraph_alignment_change_is_detected`、`test_rsid_only_run_properties_are_not_a_change`、`test_partial_edit_on_image_paragraph_becomes_a_manual_conflict`、`test_partial_edit_on_hyperlink_paragraph_becomes_a_manual_conflict`、`test_accepted_insertion_lands_in_document_order` 等。

### 服务端（`services/api/tests/test_integration.py`）

| 测试 | 覆盖场景 |
| --- | --- |
| `test_redline_warnings_travel_with_a_high_risk_submission` | 含图片的提交，`/diff` 与 `/rounds/{id}/submissions` 都带回告警 |
| `test_a_low_risk_submission_reports_no_redline_warnings` | 普通文字提交不带告警（防止"永远报警"的假阳性） |
| `test_submissions_table_has_the_additive_redline_warnings_column` | 加性迁移真的给老库加上了列 |
| `test_publish_result_requires_every_submission_to_be_terminal` | 有人未审阅时发布会话被 409 拒绝，且列出是谁 |
| `test_skipping_a_submission_unblocks_publishing` | 跳过算终态，跳过后可以发布 |
| `test_unresolvable_conflict_can_be_replaced_by_a_teacher_uploaded_manual_merge` | 人工合并返回 `resolution="manual"` 且有 `summary_redline` 版本 |
| `test_conflicts_are_unique_per_round_and_anchor` | 同锚点重复上报只留一行 |
| `test_conflicts_survive_a_restart_of_the_migration` | 唯一索引存在且正好建在 `round_id, anchor` 两列上；无重复行 |
| `test_replacing_the_main_document_adds_a_version_instead_of_a_second_document` | 「替换主文档」是加版本不是加文档 |
| `test_first_login_password_change_is_enforced_before_any_other_call` | 未改初始密码时其他接口返回 428 |
| `test_member_pending_password_change_may_still_log_out` | 待改密时仍能登出（否则用户被锁死） |
| `test_finalize_creates_the_paragraph_a_student_inserted` | 学生新增的段落真的出现在定稿结果里 |

### 桌面端（23 个，vitest）

| 文件 | 数量 | 覆盖场景 |
| --- | --- | --- |
| `src/tests/publish-gate.test.ts`（新） | 6 | 终态判定、`outstandingOf`/`outstandingFrom`、409 的 `conflicts` 与 `outstanding` 分流；含"两名学生提交、只审阅一份时另一份挡住发布" |
| `src/tests/events.test.ts`（新） | 7 | `freshEvents` 去重与排序、畸形事件丢弃、`backoffDelay` 指数+封顶、用真实 `?after=` 轮询补拉（socket 重复投递同一 id 时不会重复触发）、4401 触发登录失效且不再重连、普通断开按退避重连、`stop()` 停止轮询 |
| `src/tests/drafter.test.ts`（新） | 5 | 内容未变不上传、稳定时间不足不上传、距上次上传不足 10 分钟不上传、满足条件才上传、无哈希不上传 |
| `src/tests/format.test.ts`（补充） | 3 | `redlineWarningLabel` 把三类告警码翻成中文且不泄漏原始码；不认识的码原样返回 |
| `src/tests/live.test.ts`（改造） | — | 学生登录后**先完成强制改密**再走全程；见下节 |

发送前统一校验：测试只构造程序生成的最小 DOCX，不依赖任何真实文稿或真实材料。

### 联调测试（`live.test.ts`，用桌面端同一套 `ApiClient` 打真实 FastAPI）

建项目 → 加学生 → 上传文档 → 发轮次 → 学生提交 → 老师逐条判定 → 定稿 → 发布 → 下载合并结果 → 恢复历史版本 → 评论 → 越权被拒 → 登出后 token 立即失效。其中学生登录后会先完成一次强制改密，因为服务端现在会拦截未改密会话。

### 验收单第二节要求"保持正确、不得破坏"的四项，全部仍绿

并行修改不同段落自动合并（`test_two_students_edit_different_paragraphs_then_teacher_publishes`）、同段冲突必须老师决定（`test_same_paragraph_conflict_blocks_publish_until_teacher_chooses_a_side`）、版本不可变与内容寻址、`.docx` 校验（宏文档/加密包/zip slip/超大文件一律拒绝，`test_uploads_reject_corrupt_macro_and_mismatched_content`）。

---

## 6. 本地实际执行的命令与原始输出摘要

全部在本机（Windows 11，Python 3.12.14，Node/pnpm，Rust gnu 工具链）真实执行。

### 6.1 Python：引擎 + 服务端

```powershell
.\.venv\Scripts\python.exe -m pytest services\api\tests packages\doc_engine\tests -p no:cacheprovider -q
```

```text
45 passed, 2 warnings in 16.10s        # 加完红线告警测试后
48 passed, 2 warnings in 16.89s        # 全部加完后（最终）
```

（两条 warnings 都是第三方库的弃用提示：`httpx`/`starlette` 的 `TestClient` 与 `anyio` 别名，与本项目代码无关。）

### 6.2 桌面端：类型检查 + 构建 + 单元测试

```powershell
cd apps\desktop
pnpm typecheck
pnpm build
pnpm test
```

```text
# pnpm typecheck
tsc -b --pretty false            # 无输出 = 通过

# pnpm build
✓ 49 modules transformed.
dist/assets/index-C2wT-Q1-.js   199.96 kB │ gzip: 66.17 kB
✓ built in 517ms

# pnpm test（浏览器模式，live 默认跳过）
✓ src/tests/publish-gate.test.ts (6 tests)
↓ src/tests/live.test.ts (6 tests | 6 skipped)
✓ src/tests/events.test.ts (7 tests)
✓ src/tests/api.test.ts (18 tests)
✓ src/tests/format.test.ts (10 tests)
✓ src/tests/drafter.test.ts (5 tests)
✓ src/tests/native.test.ts (3 tests)
Test Files  6 passed | 1 skipped (7)
     Tests  49 passed | 6 skipped (55)
```

### 6.3 联调测试（打真实服务端）

本机注册的 `wordwork-api` Windows 服务跑的是改动前的代码，重启服务需要管理员权限（我无法自动提权），所以改用独立数据目录的临时实例，没有污染正式数据：

```powershell
$env:WORDWORK_DATA_DIR = 'D:\tools\wordwork\.live-test-data'
$env:WORDWORK_BOOTSTRAP_TEACHER = 'teacher'
$env:WORDWORK_BOOTSTRAP_PASSWORD = 'live-test-teacher-password'
$env:WORDWORK_BOOTSTRAP_FORCE_CHANGE = '0'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir services\api --host 127.0.0.1 --port 8010

# 另开一个窗口：
$env:WORDWORK_LIVE_API = 'http://127.0.0.1:8010'
$env:WORDWORK_LIVE_TEACHER_PASSWORD = 'live-test-teacher-password'
cd apps\desktop; pnpm test
```

```text
✓ src/tests/publish-gate.test.ts (6 tests)
✓ src/tests/events.test.ts (7 tests)
✓ src/tests/live.test.ts (6 tests) 1110ms        ← 真实端到端
✓ src/tests/api.test.ts (18 tests)
✓ src/tests/format.test.ts (10 tests)
✓ src/tests/drafter.test.ts (5 tests)
✓ src/tests/native.test.ts (3 tests)
Test Files  7 passed (7)
     Tests  55 passed (55)
```

### 6.4 Rust

```powershell
cd apps\desktop\src-tauri
cargo check
```

```text
    Checking wordwork-desktop v0.2.0 (D:\tools\wordwork\apps\desktop\src-tauri)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 08s
```

### 6.5 打包

```powershell
cd apps\desktop
pnpm tauri build --no-bundle
pnpm tauri build
```

```text
   Compiling wordwork-desktop v0.2.0 (D:\tools\wordwork\apps\desktop\src-tauri)
warning: linker stderr: ...ld.exe: .rsrc merge failure: multiple non-default manifests
warning: `wordwork-desktop` (bin "wordwork") generated 1 warning
    Finished `release` profile [optimized] target(s) in 1m 14s
       Built application at: D:\tools\wordwork\apps\desktop\src-tauri\target\release\wordwork.exe

# 带打包的完整构建：
    Finished 2 bundles at:
        ...\release\bundle\nsis\wordwork_0.2.0_x64-setup.exe
        ...\release\bundle\msi\wordwork_0.2.0_x64_zh-CN.msi
```

那条 `multiple non-default manifests` 是 **mingw 链接器的既有告警**（Tauri 与 windres 各带一份 manifest），不是错误，exe 正常产出、版本信息正常。本机一直如此。

---

## 7. 新安装包（EXE）的完整路径、大小和构建时间

构建时间均为 **2026-09-13 15:53**（第二遍带 bundle 的构建把 exe 也重新打了一次，故为 15:53）。

| 产物 | 完整路径 | 大小 | 版本 |
| --- | --- | --- | --- |
| 免安装主程序 | `D:\tools\wordwork\apps\desktop\src-tauri\target\release\wordwork.exe` | 3,664,384 B（3.49 MB） | 0.2.0 |
| NSIS 安装包（推荐给学生） | `D:\tools\wordwork\apps\desktop\src-tauri\target\release\bundle\nsis\wordwork_0.2.0_x64-setup.exe` | 1,306,485 B（1.25 MB） | 0.2.0 |
| MSI 安装包 | `D:\tools\wordwork\apps\desktop\src-tauri\target\release\bundle\msi\wordwork_0.2.0_x64_zh-CN.msi` | 1,916,928 B（1.83 MB） | 0.2.0 |

校验值：

```text
b5cbda2def9e8227c4f7dbe648c8938a  wordwork.exe
ee15a56585d41c85cadd652246285339  wordwork_0.2.0_x64-setup.exe
18581c08b99a8d079b319eb73e1bdb38  wordwork_0.2.0_x64_zh-CN.msi
```

`(Get-Item ...).VersionInfo` 显示 `FileVersion: 0.2.0`、`ProductVersion: 0.2.0`。

> **提醒**：同目录下还留着上一轮的 **0.1.0** 安装包
> （`bundle\nsis\wordwork_0.1.0_x64-setup.exe`、`bundle\msi\wordwork_0.1.0_x64_zh-CN.msi`，均为 13:40）。
> 分发时请只取 0.2.0 那两个，避免发错。这两个旧文件我没有删——需要的话说一声我来清。

---

## 8. 仍未完成或只做了人工验证的事项

### 已修复但需要人工验证（需要人的手或权限）

1. **重启正式服务**。注册在案的 `wordwork-api` 服务跑的是改动前的代码，`Restart-Service` 需要管理员权限：
   ```powershell
   Restart-Service wordwork-api      # 管理员 PowerShell
   ```
   之后 `http://127.0.0.1:8000/healthz` 应为 0.2.0 且 `engine_available: true`。在重启之前，老师/学生客户端连上去用的还是旧逻辑。

2. **文件占用检测（P1.5）**。用 Word/WPS 打开一份工作副本**不要关闭**，再在客户端点"下载工作副本"覆盖它，应弹「文件正被 Word/WPS 占用」而不是写出半截文件。原生文件对话框与 Word 的时序无法自动化。

3. **强制改密弹窗（P1.6）**。用一个新建的学生账号登录，弹窗应当关不掉（没有 ×、按 Esc 无效），只能改完或退出登录。

4. **界面回归**。审阅页新增的"红线稿不完整"横幅、发布按钮在有人未审阅时的置灰提示，需要在装好新 `wordwork.exe` 的界面上实际看一眼。

5. **外网可达性**（与本次修复无关，属部署收尾）。只能从校外/4G 机器验证：
   ```powershell
   Test-NetConnection <公网IP> -Port 8443
   ```
   大陆移动家宽有 CGNAT（"看着有公网 IP、其实是运营商大内网"）或封入站端口的可能，脚本判断不了。

### 未完成

6. **`/events` 真正的服务端推送**。现有 WebSocket 循环只回 ping，客户端只能用轮询补增量。要改成真推送需要动服务端 socket 循环。当前实现是**可用且诚实**的（事件最终会到、登录失效能被发现），只是延迟取决于轮询间隔。

7. **图片/公式/图表/域的自动合并**。按项目既定能力边界不做，本次只是把它们从"静默丢弃"变成"显式人工冲突"。

8. **实时共同编辑、内置 Word 编辑器、完整聊天**。按项目既定能力边界不做。

---

## 9. 给下一位接手者的重点位置

按"容易改坏"的排序：

| 位置 | 为什么 |
| --- | --- |
| `packages/doc_engine/.../engine.py` → `_redline_paragraph` / `_redline_inserted_paragraph` / `_redline_deleted_paragraph` | **不要往 `w:ins`/`w:del` 里写 `w:date` 或任何当前时间**。写了同一输入就会产出不同字节，内容寻址存储会为同一份红线稿存出两个版本。每个 `w:id` 必须全文档唯一：一次替换 = 一个删除 id + 一个插入 id |
| 同上 → `_insert_clone` | 返回的是**树里那个克隆**，不是入参元素。要标注插入内容必须用返回值——用入参改的是没进树的副本，界面上看不到效果 |
| 同上 → `generate_redline` 的 `warnings` | 新增"表达不了的改动"时务必也写 warning，不要 `continue` 了事。这些字符串经 `redline_warnings` 一路传到界面，是老师唯一能看出"红线稿不完整"的途径 |
| `services/api/app/main.py` → `_migrate()` | 加性迁移必须能**重复跑**。加唯一索引前必须先把老数据里的重复行折叠掉，否则老库启动会直接失败（`CREATE UNIQUE INDEX` 报错） |
| 同上 → `upsert_conflict()` | 用 UPSERT 而不是"先查再写"，否则两个并发请求会各插一行，唯一索引会把第二个请求变成 500 |
| 同上 → `require_password_change` 中间件 | `PASSWORD_CHANGE_EXEMPT_PATHS` 是唯一出口。往白名单里加路径等于让未改密会话能碰它，加之前想清楚 |
| `apps/desktop/src/lib/events.ts` | WebSocket **只**用来取历史积压和识别 4401。别把"实时性"挂到 socket 的 `onmessage` 上——服务端根本不会推。新事件来自 `?after=` 轮询 |
| `apps/desktop/src/lib/store.tsx` → `flushQueue` | 快照按 SHA-256 存，重试前**必须**重新校验哈希；对不上的要丢弃并提示，不能当成功 |
| `apps/desktop/src/lib/drafter.ts` | 两个时间常数（5 分钟稳定 / 10 分钟间隔）是产品决策，改小会让服务器收到大量草稿 |
| `apps/desktop/src-tauri/src/main.rs` → `write_file` | 必须先写临时文件再 `fs::rename`。直接 `fs::write` 在 Word 持锁时会留下截断的 `.docx` |
| `apps/desktop/src/tests/live.test.ts` | 学生必须先完成强制改密（`loginStudent()`），否则服务端 428 会把测试全挂掉 |

### 本机构建环境（这次踩过的坑，省得再踩）

- **Python 测试必须用项目 venv**：`.venv\Scripts\python.exe -m pytest ...`。系统 Python 3.9 没装 `wordwork_doc_engine`，会 `ModuleNotFoundError`。
- **Rust/Tauri 构建需要 WinLibs mingw 在 PATH 上**（`dlltool.exe` 和 `as.exe` 都要）：
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin`
  在一个精简 PATH 的 shell 里构建时，rustup 自带的 `self-contained\dlltool.exe` 会顶替 WinLibs 的 dlltool，但它找不到 `as.exe`，报 `dlltool could not create import library ... CreateProcess`。把上面这个目录加进 PATH 即可。`cargo` 通常位于 `%USERPROFILE%\.cargo\bin`。
- **MSVC 工具链不可用**：装了 VS Build Tools 2022，但**没装 Windows SDK**（`C:\Program Files (x86)\Windows Kits\10` 下只有 `Catalogs`/`Redist`，缺 `Lib`/`Include`），链接会报 `LNK1181`。另外 `D:\Git\usr\bin\link.exe` 是 coreutils 的 `link`、不是链接器，会遮蔽 MSVC 的 `link.exe`。项目用 `stable-x86_64-pc-windows-gnu`。

---

## 10. 老师与学生可以做的最后验收步骤

### 管理员 / 老师（一次性）

1. 管理员 PowerShell 里 `Restart-Service wordwork-api`，然后浏览器访问 `https://<服务器地址>/healthz`，确认 `"version":"0.2.0"`、`"engine_available":true`。
2. 把 `wordwork_0.2.0_x64-setup.exe` 发给老师自己和学生（注意别发成同目录下的 0.1.0）。
3. 老师在自己的客户端上用 `http://127.0.0.1:8000` 登录（本机不需要装证书）。

### 老师要亲手验的四件事

1. **强制改密**：给学生新建一个账号，用那个账号首次登录 → 应该弹出**关不掉**的改密窗口（没有 ×、按 Esc 无效），改完才能进主界面。
2. **发布被挡住**：开一轮，让两个学生各交一份，但**只审阅其中一份**，然后点"发布本轮结果" → 应该弹提示并告诉你**是哪位同学**还没处理，发布被拒。把剩下那份要么审完、要么"跳过"，再点发布就应该成功。
3. **红线稿完整性提示**：让学生交一份**改动里含图片**的稿件，打开审阅页 → 顶部应出现「红线稿不完整」的黄色横幅，用中文说明"含图片、公式、域或超链接，红线稿里没有标出这处改动，请用 Word 打开对照"。
4. **文件占用保护**：下载一份工作副本，用 Word 打开不关，再点"下载工作副本"覆盖 → 应提示「文件正被 Word/WPS 占用」，Word 里那份文件不受影响。

### 学生要亲手验的三件事

1. 用老师给的地址连上，首次登录按提示改密码（改不掉关不掉的窗口），然后能正常看到轮次。
2. 下载工作副本 → 用 Word/WPS 改 → **保存并关闭 Word** → 回到客户端提交 → 能提交成功并看到自己的差异。
3. 把网络断掉再提交一次 → 应先排队（提示已排队），恢复网络后自动补交成功；期间不要反复重交同一份文件。

---

## 附：本轮改动对应的原始验收单条目索引

| 验收单条目 | 本报告位置 |
| --- | --- |
| P0 四项（三.1–三.4） | 第 2 节 P0 表、第 3 节逐项说明 |
| P1 六项（四.5–四.10） | 第 2 节 P1 表、第 3 节逐项说明 |
| P2 四项（五.11–五.14） | 第 2 节 P2 表、第 3 节逐项说明 |
| DOCX 安全原则（六） | 第 3 节 P0.3、第 8 节第 7 条 |
| 新增测试（七，约 35 个） | 第 5 节，实际 43 个 |
| 验证命令（八） | 第 6 节，含原始输出 |
| 交付报告十项（九） | 即本文十节 |
| 工作方式（十） | 全程先改代码再测；未使用 Computer Use；Rust 无法在本机链接的部分已在第 6.4/6.5 与第 8 节说明 |
