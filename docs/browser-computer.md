# Browser Computer

## What It Is

browser computer 是一个长期存在、由 computerd 管理的有状态浏览器环境。

它不是“启动浏览器并打开某个 URL 的一次性命令”，而是一个可以跨 agent 生命周期持续存在的 browser workspace：

- 有自己的 profile
- 有自己的 cookie / local storage / session data
- 可以被人类通过 WebUI 直接操作
- 可以被 agent 通过 CDP / Playwright 使用

## Object Model

browser computer 仍然是统一 `computer` 模型的一种 profile：

- `profile = "browser"`
- `runtime.browser = "chromium"`
- `runtime.persistentProfile = true`

没有新增顶层 `browser` object kind。

## Runtime Layout

browser runtime 由 systemd primary unit 承载，内部当前采用 virtual X11 stack：

- `Xvfb`
- `chromium`
- `x11vnc`

目录约定：

- state root: `/var/lib/computerd/computers/<slug>`
- runtime root: `/run/computerd/computers/<slug>`
- chromium profile: `<state root>/profile`

这保证 browser 数据不会落在宿主用户的默认 home profile 中。

## Supported Capabilities

### Lifecycle

- create
- start
- stop
- restart
- inspect detail / state

### Interactive monitor

- browser monitor session
- noVNC websocket attach
- WebUI popup browser stage

### Automation

- CDP websocket attach
- 适合给 Playwright 直接连接

Playwright 接入细节见：

- [docs/playwright-browser-computer.md](/Users/timzhong/computerd/docs/playwright-browser-computer.md)

当前推荐开发者入口：

- `@computerd/sdk` 的 `createComputerdClient(...)`
- `examples/browser-cli.ts`
- `examples/playwright-connect.ts`

### Capture

- fullscreen screenshot
- PNG base64 payload

## WebUI

browser detail 页提供 `Open browser` 按钮。

点击后会打开一个独立 popup window：

- 初始窗口大小优先按远端渲染分辨率打开
- 如果本机屏幕放不下，则默认按 1/2 分辨率回退开窗
- popup 内部只展示远程浏览器画面

## API Surfaces

当前 browser computer 相关的最小 API 面：

- `POST /api/computers/:name/start`
- `POST /api/computers/:name/stop`
- `POST /api/computers/:name/restart`
- `POST /api/computers/:name/monitor-sessions`
- `POST /api/computers/:name/automation-sessions`
- `POST /api/computers/:name/screenshots`
- `GET /api/computers/:name/monitor/ws`
- `GET /api/computers/:name/automation/ws`

## SDK And CLI

当前仓库已经提供一套轻量开发者入口：

- TypeScript SDK：`@computerd/sdk`
- 示例 CLI：`examples/browser-cli.ts`

SDK 当前提供的最小 browser client：

- `createComputerdClient({ baseUrl, fetch? })`
- `getComputer(name)`
- `createBrowserAutomationSession(name)`
- `createBrowserMonitorSession(name)`
- `captureBrowserScreenshot(name)`
- `resolveWebSocketUrl(...)`
- `connectPlaywright(name)`

CLI 当前支持：

- `browser-info <name>`
- `browser-connect <name>`
- `browser-screenshot <name> [--out <file>]`

## Current Constraints

- 当前只支持 `chromium`
- 当前只支持 fullscreen screenshot
- 当前 monitor / automation 默认无鉴权
- 当前未内建 selector/tab/page 级 browser actions
- 当前 stop/start 不保证浏览器窗口和标签页恢复

## Operational Notes

在 root 运行 browser unit 的环境里，Chromium 目前会使用 `--no-sandbox` 启动。

这能保证当前 vertical slice 可运行，但不是最终安全形态。后续更合理的方向是把 browser runtime 切到专用非 root 用户。
