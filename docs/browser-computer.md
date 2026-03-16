<!-- DOC-TODO-START -->

## 当前 TODO

- [ ] P1: 为 browser monitor / automation session 补充 ticket/token 鉴权，并明确 container runtime 下 monitor / CDP attach 的权限边界。
<!-- DOC-TODO-END -->

# Browser Computer

## What It Is

browser computer 是一个长期存在、由 computerd 管理的有状态浏览器环境。

它的定位是：

- 一个 managed browser container
- 一个默认启用 `CDP` 的浏览器运行时
- 一个通过宿主桥接暴露 monitor / capture / resize / automation 能力的长期浏览器环境

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

`browser` 作为产品 profile 仍保留独立语义，但它当前的技术实现已经很明确：

- 它就是一个 browser container
- 它不是 host service，也不是需要单独理解的特殊宿主 substrate
- computerd 负责把这个 container 包装成一个长期存在的 browser computer

关于这次收敛背后的原因和取舍，见：

- [docs/incubation/browser-container-runtime-rationale.md](/Users/timzhong/computerd/docs/incubation/browser-container-runtime-rationale.md)

## Runtime Layout

browser runtime 当前就是一个受管 browser container，container 内部采用 virtual X11 stack：

- `Xvfb`
- `chromium`
- `x11vnc`

目录约定：

- state root: `/var/lib/computerd/computers/<slug>`
- runtime root: `/run/computerd/computers/<slug>`
- chromium profile: `<state root>/profile`
- browser runtime container: `computerd-browser-<slug>`
- browser runtime user: `computerd-b-<slug>`
- control socket: `<runtime root>/control.sock`

这保证 browser 数据不会落在宿主用户的默认 home profile 中，同时把浏览器进程和控制逻辑收敛到容器边界内。

当前 runtime 关键点是：

- browser persisted runtime record 使用 `runtime.provider = "container"`
- browser container 使用 bind mount 挂载 profile/state/runtime 目录
- container 内的私有 agent/control server 通过 control socket 提供私有协议
- browser monitor 通过宿主侧 websocket bridge 暴露 VNC/noVNC attach
- browser automation 通过宿主侧 websocket bridge 暴露 CDP attach
- browser 默认启用 Chromium remote debugging，也就是默认启用 `CDP`
- browser `networkId` 会直接映射到 host 或 isolated container network
- viewport 变更会通过 control socket 通知容器内 agent 重启图形栈并应用新分辨率
- screenshot 通过 control socket 调用容器内 capture 实现

当前容器内私有控制面的职责可以直接概括为：

- 健康检查
- screenshot capture
- 窗口 resize / 图形栈重启

而对外稳定暴露的 surface 是：

- `VNC`
- `CDP`
- screenshot
- viewport resize

未来如果继续扩展，比较自然的方向是：

- 视频流
- 更强的 monitor transport
- 更细的 attach 权限控制

## Runtime Stability Note

当前 browser runtime 的分工已经是清晰的，不再处于“到底是不是 container runtime”的摇摆阶段。

原因是：

- browser 现在就是一个普通受管容器工作负载
- computerd 额外提供的只是 browser-specific attach 和 control surface
- 这让 browser 的技术边界比之前的 host-based 方案清晰得多

因此，当前实现的正式判断应当是：

- browser profile 仍然成立
- browser runtime 已明确是 container-backed browser container
- browser 的核心分工已经明确：容器负责浏览器运行，computerd 负责生命周期与外部 attach surface

## Possible Future Convergence

browser 当前不需要再讨论“是否应该先回到 host service”这类问题。

更现实的后续演进问题是：

- VNC 是否继续作为主要 monitor backend，还是被更高效的视频/编码流替代
- resize / capture / future stream control 是否继续沿用当前私有控制面
- browser 与 VM 是否在 monitor / encoded-stream / input backend 上继续共享更多实现

如果后续确实要和 VM 收敛，更合理的收敛点是这些 backend：

- 复用更统一的 display / input backend
- 复用更统一的 monitor / capture / future encoded-stream pipeline
- 减少 `browser` 与 `vm` 在“带屏幕 computer”实现上的分叉

但这不改变当前判断：

- `browser` 仍然是独立的产品 profile
- `browser` 的当前实现就是 browser container

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

### Automation

- CDP websocket attach
- 适合给 Playwright 直接连接

这是 browser computer 当前最重要的 specialized surface。

推荐优先级是：

1. `CDP`
2. 必要时 monitor / screenshot / display-actions
3. 不鼓励优先走视觉点击路径，除非 `CDP` 不可用或不合适

Playwright 接入细节见：

- [docs/playwright-browser-computer.md](/Users/timzhong/computerd/docs/playwright-browser-computer.md)

当前推荐开发者入口：

- `@computerd/sdk` 的 `createComputerdClient(...)`
- `examples/browser-cli.ts`
- `examples/playwright-connect.ts`

### Capture

- fullscreen screenshot
- PNG base64 payload

### Generic Display Actions

- pointer / keyboard v1
- 通过 `display-actions` contract 暴露
- 当前底层通过 VNC backend 执行

这条路径的定位是：

- 一个 generic screen control fallback
- 不替代 `CDP`
- 更适合在 browser-specialized automation 不可用时兜底

## Interaction Model

browser computer 的 agent-facing 模型应拆成三层：

- display observation
  - monitor
  - screenshot
- specialized browser surface
  - `CDP`
- generic display control fallback
  - pointer
  - keyboard

当前仓库里真正已经稳定暴露的是：

- display observation
- `CDP`
- generic pointer / keyboard v1（通过 `display-actions`）

这意味着 browser computer 现在的推荐路径仍然应该是：

- 优先 `CDP`
- 必要时退回 `display-actions`
- 不鼓励把 browser computer 默认用成“只能截图再点鼠标”的系统

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
- `POST /api/computers/:name/viewport`
- `POST /api/computers/:name/display-actions`
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
- `runDisplayActions(name, { ops, observe? })`
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
- 当前 browser container 默认不提供稳定 audio session
- 当前未内建 selector/tab/page 级 browser actions
- 当前未暴露 perception / visual grounding sidecar contract
- 当前 stop/start 不保证浏览器窗口和标签页恢复

## Operational Notes

browser runtime 当前默认以受管 browser container 运行，持久 profile 和 runtime 目录通过 bind mount 暴露给容器。

当前 container runtime 的正式实现判断是：

- monitor / screenshot / CDP 已经围绕 browser container 收敛
- `isolated network` 对 browser 已经有自然承载，不再需要在 host service 上手搓 netns wiring
- audio 当前仍未作为稳定能力开放；仓库实现里 browser container 默认不提供 audio session

因此当前宿主前提更偏向：

- Docker runtime 可用
- browser runtime image 可拉取/启动
- 宿主本地 websocket / HTTP bridge 可访问 browser container 暴露的本地端口
