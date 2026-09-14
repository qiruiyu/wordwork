# wordwork desktop

Tauri 2 + React + TypeScript/Vite 桌面客户端。**没有 mock 模式**：首次打开必须填写
一个可用的 wordwork 服务器地址，客户端会先打 `/healthz`，探不通就不让继续。

## 开发

```bash
pnpm install
pnpm dev        # 浏览器模式，界面能用但原生能力走 fallback
pnpm test       # 单元测试（联调测试默认跳过）
pnpm typecheck
pnpm tauri dev
```

## 目录

| 文件 | 作用 |
| --- | --- |
| `src/lib/api.ts` | 唯一的 HTTP 客户端。错误分类、`409`/`428` 的语义化解析都在这里 |
| `src/lib/store.tsx` | 登录态、工作副本、离线队列、服务端事件流 |
| `src/lib/events.ts` | 订阅 `/events`：WebSocket + `?after=` 轮询回填、去重、指数退避重连 |
| `src/lib/drafter.ts` | 草稿自动上传时机：内容稳定 5 分钟且距上次上传满 10 分钟 |
| `src/lib/native.ts` | Tauri IPC 桥。二进制一律 base64 过界，浏览器 fallback 见注释 |
| `src/lib/format.ts` | 时间/大小/位置标签与操作名（新增、删除、替换、格式修改、复杂对象修改） |
| `src-tauri/src/main.rs` | 原生文件对话框、读写字、调用 Word/WPS、系统通知、离线快照、DPAPI 会话加密 |

## 关键约定

- **服务器地址**只接受 `https://`；仅 `localhost` / `127.0.0.1` / `::1` 允许明文 `http://`。
  没有域名时由部署脚本用内部 CA 签证书，学生机需要装一次根证书。
- **覆盖写文件前**必须先 `waitForFileReleased()`，否则 Word/WPS 持锁时会写出截断的
  `.docx`。Rust 侧 `write_file` 一律先写临时文件再原子替换。
- **离线补传**是基于内容哈希的不可变快照（存在应用数据目录的 `snapshots/`），
  重试前重新校验哈希，成功后删除；连续失败 8 次或遇到 409 等终态错误就停止重试。
- **提交必须携带**冻结的 `base_version_id` 与本地 `sha256`，服务端会独立校验。

## 权限

老师可发布轮次、接受/拒绝片段、把无法自动套用的提交标记为人工合并或跳过，并发布结果；
学生只能查看他人提交、提交自己的修改和评论。发布本轮结果要求所有提交都处于
`reviewed` / `skipped` / `rejected` 终态，未处理完的提交会被服务端以 409 拒绝发布。

## 联调测试

```bash
WORDWORK_LIVE_API=http://127.0.0.1:8000 \
WORDWORK_LIVE_TEACHER_PASSWORD=<管理员密码> \
pnpm test
```

`src/tests/live.test.ts` 会打真实后端，走完建项目、加成员、上传、提交、审阅、发布的全流程。
