# @dsh-external/dsh-notifier

DSH 的任务提醒插件：**任务运行结束**、**运行中需要你做决策（权限审批 / 用户提问）**时，弹出**跨窗口可见**的提醒——类似 Codex / Claude Code 的 Hook 通知体验：你切到任何应用、任何桌面空间（甚至全屏应用）都能看到。

- **跨窗口悬浮面板（默认，v0.2）**：macOS 用内置 Swift notifier（NSPanel `.floating` + `canJoinAllSpaces` + `fullScreenAuxiliary`），浮在**所有应用窗口之上、所有 Space / 全屏应用之上**；样式与网页 toast 同款，「去处理 / 查看会话」按钮直接唤起浏览器打开 DSH
- **web 内 toast 弹窗**：DSH 网页里的右下角深色通知卡片 + 提示音（React portal 挂在 `document.body`，保证浮在面板之上）
- **系统通知中心横幅**：macOS `osascript` / Linux `notify-send` / Windows 气泡，可配置关闭
- **决策型弹窗钉住不放**：审批 / 提问在 web 端被回答、被拒绝后，悬浮面板自动消失；任务结束/出错面板 10 秒自动消失

## 效果截图

### 跨窗口悬浮面板（浮在其他应用之上）

| 任务完成 | 需要批准 | 需要回答 |
| --- | --- | --- |
| ![原生-任务完成](docs/screenshots/native/01-task-done.png) | ![原生-需要批准](docs/screenshots/native/02-approval-needed.png) | ![原生-需要回答](docs/screenshots/native/03-question-needed.png) |

### DSH 网页内 toast

| 任务完成 | 需要批准 | 需要回答 |
| --- | --- | --- |
| ![web-任务完成](docs/screenshots/01-task-done.png) | ![web-需要批准](docs/screenshots/02-approval-needed.png) | ![web-需要回答](docs/screenshots/03-question-needed.png) |

## 工作原理

事件 → Hook（host 插件）→ 系统提醒，与 Claude Code 的 Notification Hook 同构：

| 提醒 | 触发事件（host Hook） | web 弹窗信号（client） |
| --- | --- | --- |
| 任务结束 | `agent/status`：`running → idle` 边沿 | `events.host` 流 `host/session-status`：`running: true → false` 边沿 |
| 权限审批 | `session/event`：`approval/asked`（waterfall `approval/request` 辅助观察）；`approval/decided` 关闭面板 | `events.mux` 流 `approval/requested` / `approval/resolved` |
| 用户提问 | `session/event`：`tool/call`（`ask_user_question`）；对应 `tool/result` 关闭面板 | `events.mux` 流 `question/requested` / `question/resolved` |
| 任务出错 | `agent/error` | `events.host` 流 `host/agent-error` |

- macOS 悬浮面板：首次触发时用 `swiftc` 把 `assets/macos/DSHNotifier.swift` 编译缓存到 `~/.dsh/plugins/dsh-notifier/DSHNotifier`，之后直接拉起；无 `swiftc` 时回退 `osascript display dialog / notification`
- Linux：`zenity` 跨窗口对话框（无 zenity 回退 `notify-send`）；Windows：PowerShell `MessageBox`
- client 用 `ctx.connection` 消费两条实时事件流，断线自动重连；host 与 client 相互独立，任一失效不影响另一半

## 安装

### 方式一：GitHub Release 安装（推荐）

1. 到 [Releases](https://github.com/nanami-0713/dsh-notifier/releases) 下载最新 `dsh-external-dsh-notifier-<版本>.tgz`
2. 解压，然后把插件装进 web profile：

```bash
dsh plugin --profile web add <解压目录>
# 或：编辑 ~/.dsh/profiles/web/package.json：
#   "dependencies": { "@dsh-external/dsh-notifier": "link:<解压目录>" },
#   "dsh": { "profile": { "bundles": [..., "@dsh-external/dsh-notifier"] } }
dsh web   # 重启后自动装配
```

### 方式二：源码构建安装

```bash
git clone https://github.com/nanami-0713/dsh-notifier.git
cd dsh-notifier
npm install
npm run build:all          # 产物：lib/index.js（host）+ lib/client.js（web 弹窗）
dsh plugin --profile web add .
```

### 注入器环境（dev_* 工具）

```bash
# 构建并运行时注入（免重启）
dev_build_plugin {"dir": "<本目录>"}
dev_inject_plugin {"dir": "<本目录>"}
# 持久化安装（写 profile package.json + bundles，重启仍生效）
dev_install_package {"dir": "<本目录>"}
```

## 配置

插件接受可选配置（loader `config` / patch 中的 `config` 字段），全部有默认值：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `floating` | `true` | 跨窗口悬浮面板（macOS Swift notifier / Linux zenity / Windows MessageBox） |
| `desktop` | `true` | 系统通知中心横幅 |
| `webUrl` | `$DSH_WEB_URL` 或 `http://127.0.0.1:3080` | 悬浮面板「去处理 / 查看会话」按钮打开的地址 |
| `quietSeconds` | `8` | 同一事件的最短重复提醒间隔（秒） |

## 验收测试

仓库自带真实事件级 E2E 脚本（用 DSH host API 建会话、派任务、监听事件流）：

```bash
node scripts/e2e-done.mjs       # 任务结束：host/session-status idle 帧 → 悬浮面板上屏
node scripts/e2e-approval.mjs   # 权限审批：approval/requested 帧 → 悬浮面板钉住，拒绝后自动关闭
node scripts/e2e-question.mjs   # 用户提问：question/requested 帧
node scripts/ui-test.mjs        # Headless Chrome 全链路：真实事件 → 网页 toast → 截图
```

macOS 上可用 CoreGraphics 窗口枚举验证面板确实浮在屏幕上（`kCGWindowLayer == 3` 即 `.floating` 层）：

```bash
swiftc scripts/winlist.swift -o /tmp/winlist && /tmp/winlist
```

UI 测试会产出 `docs/screenshots/*.png`，并在结束后把测试会话归档清理。

## License

MIT
