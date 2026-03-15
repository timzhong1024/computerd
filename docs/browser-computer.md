<!-- DOC-TODO-START -->
## 当前 TODO
- [ ] P1: 为 browser computer 增加 generic pointer / keyboard injection surface，并明确它只作为 `CDP` 失效时的视觉兜底面。
- [ ] P2: 为 browser monitor / automation session 补充 ticket/token 鉴权，收紧当前默认无鉴权的最小实现。
<!-- DOC-TODO-END -->

# Browser Computer

## What It Is

browser computer 是一个长期存在、由 computerd 管理的有状态浏览器环境。

它的定位是：

- 一个 managed browser workspace
- 一个可被人类 monitor 的图形环境
- 一个可被 agent 通过 specialized browser protocol attach 的自动化对象

它不是：

- server-side browser DSL 翻译层
- 纯 GUI click bot
- 只允许 screenshot + click 的 agent 沙盒

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

关于为什么 `browser` 作为产品 profile 应保留，但底层 runtime 值得演进到 container-backed substrate，见：

- [docs/incubation/browser-container-runtime-rationale.md](/Users/timzhong/computerd/docs/incubation/browser-container-runtime-rationale.md)

## Runtime Layout

browser runtime 由 systemd primary unit 承载，内部当前采用 virtual X11 stack：

- `Xvfb`
- `chromium`
- `x11vnc`
- `pipewire`
- `wireplumber`
- `pipewire-pulse`

目录约定：

- state root: `/var/lib/computerd/computers/<slug>`
- runtime root: `/run/computerd/computers/<slug>`
- chromium profile: `<state root>/profile`
- browser runtime user: `computerd-b-<slug>`

这保证 browser 数据不会落在宿主用户的默认 home profile 中。

音频当前采用 user-scoped PipeWire session：

- 每个 browser computer 运行在独立 Linux 用户下
- 该用户自己的 runtime 中启动 `pipewire` / `wireplumber`
- Chromium 音频输出当前通过 `pipewire-pulse` 进入 PipeWire graph
- server 侧通过目标 browser user 的 `XDG_RUNTIME_DIR` 附着并抓取该 user 的音频 node

实现上这意味着：

- 对外仍然兼容 Pulse 语义
- 底层媒体 graph 仍由 PipeWire 驱动
- 当前不假设 Chromium 已经稳定支持“完全不经 `pipewire-pulse` 的原生 PipeWire 音频输出”

## Supported Capabilities

下面的 `Supported Capabilities` 指当前仓库已实现能力，而不是目标形态。

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
- popup viewport 会随窗口大小实时回传并更新远端分辨率
- monitor 页面可同时播放 browser computer 音频

### Automation

- CDP websocket attach
- 适合给 Playwright 直接连接

这是 browser computer 当前最重要的 specialized surface。

推荐优先级是：

1. `CDP`
2. 必要时 monitor / screenshot
3. 将来如果补 generic input，再作为视觉兜底面

Playwright 接入细节见：

- [docs/playwright-browser-computer.md](/Users/timzhong/computerd/docs/playwright-browser-computer.md)

当前推荐开发者入口：

- `@computerd/sdk` 的 `createComputerdClient(...)`
- `examples/browser-cli.ts`
- `examples/playwright-connect.ts`

### Capture

- fullscreen screenshot
- PNG base64 payload
- HTTP `audio/ogg` live audio stream

## Interaction Model

browser computer 的 agent-facing 模型应拆成三层：

- display observation
  - monitor
  - screenshot
  - audio
- specialized browser surface
  - `CDP`
- optional future generic input
  - pointer
  - keyboard

当前仓库里真正已经稳定暴露的是：

- display observation
- `CDP`

当前还没有暴露：

- browser generic input injection API

这意味着 browser computer 现在的推荐路径仍然应该是：

- 优先 `CDP`
- 不鼓励把 browser computer 用成“只能截图再点鼠标”的系统

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
- `POST /api/computers/:name/audio-sessions`
- `POST /api/computers/:name/automation-sessions`
- `POST /api/computers/:name/screenshots`
- `POST /api/computers/:name/viewport`
- `GET /api/computers/:name/audio`
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
- `updateBrowserViewport(name, { width, height })`
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
- 当前音频输出格式固定为 `audio/ogg`
- 当前未内建 selector/tab/page 级 browser actions
- 当前未暴露 generic pointer / keyboard injection API
- 当前未暴露 perception / visual grounding sidecar contract
- 当前 stop/start 不保证浏览器窗口和标签页恢复

## Operational Notes

browser runtime 当前默认以专用非 root 用户运行，例如 `computerd-b-<slug>`。

在宿主完成 `pipewire`、`wireplumber`、`pipewire-pulse` 安装后，每个 browser unit 会在自己的 user-scoped session 中拉起这组音频进程，再启动 Chromium。

Chromium 目前的稳定出声路径依赖 `pipewire-pulse`。因此当前推荐的宿主前提是：

- `pipewire`
- `wireplumber`
- `pipewire-pulse`
- `ffmpeg`

这里的定位不是“继续使用独立 PulseAudio daemon”，而是“保留 Pulse 兼容接口，由 PipeWire 作为底层媒体后端”。
