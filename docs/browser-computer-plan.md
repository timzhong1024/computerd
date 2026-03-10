# Browser Computer Status

## Summary

`browser computer` 已经从“schema 存在但 runtime 不支持”的 profile，落成了一个真实可用的 managed `computer`。

当前仓库中，browser computer 具备这些基本能力：

- 可创建 / 启动 / 停止 / 重启
- 由 systemd 管理 primary unit
- 拥有 computerd 隔离的数据目录和运行时目录
- 可创建 monitor session，并通过 WebUI/noVNC 打开远程浏览器画面
- 可创建 audio session，并在 monitor 页面播放 browser computer 音频
- 可创建 automation session，并暴露底层 CDP websocket attach 入口
- 可获取全屏 screenshot
- 可通过 WebUI popup 打开独立 browser stage 页面

本轮 vertical slice 已完成，后续工作不再是“补齐基本可用性”，而是围绕体验、分辨率策略、权限模型和更强的 automation 能力迭代。

## Implemented Shape

### Product model

- 顶层 managed object 仍然只有 `computer`
- browser 仍然是 `computer.profile = "browser"`
- 没有引入新的顶层 `browser` / `virtual-x11` / `vm` object kind

### Runtime model

- 首版只支持 `chromium`
- browser runtime 建立在 virtual X11 substrate 上
- 当前 primary unit 内会拉起：
  - `Xvfb`
  - `chromium`
  - `x11vnc`
  - `pipewire`
  - `wireplumber`
  - `pipewire-pulse`
- browser profile 数据放在 computerd 管理目录下
- browser runtime 以专用 Linux 用户运行
- stop/start 保留 profile 数据，但不承诺恢复 tabs/windows

### Access model

- monitor: noVNC over websocket bridge
- audio: HTTP `audio/ogg` stream
- automation: CDP websocket attach
- screenshot: fullscreen PNG capture

### WebUI model

- inventory/detail 中 browser 与 terminal 并列显示
- browser detail 页支持 `Open browser`
- `Open browser` 会弹出独立窗口，打开 `/computers/:name/monitor`
- popup 页面内部只保留远程浏览器画面，不再展示普通 detail layout

## Verified End-To-End

下面这些能力已经完成并验证过：

- browser create/start/stop/restart
- systemd unit 渲染与真实运行
- browser monitor session create
- browser audio session create
- browser automation session create
- fullscreen screenshot create
- WebUI noVNC popup 建连并显示真实 Chromium 画面
- WebUI monitor 页面可并行播放浏览器音频
- CDP websocket attach
- stop/start 后 profile 目录持久化

## Current Defaults

- browser engine: `chromium`
- profile persistence: `true`
- display protocol: virtual X11
- audio runtime: PipeWire user session
- Chromium audio backend: `pipewire-pulse` on top of PipeWire
- monitor auth: `none`
- automation auth: `none`
- screenshot type: fullscreen only

## Current Limits

这几项仍然是当前边界，而不是 bug：

- 只 harden 了 `chromium`
- screenshot 只支持整屏，不支持 page/selector 级截图
- 没有内建 tab/page/action 级 browser tool schema
- Playwright/agent 侧应直接走 CDP attach，而不是依赖 computerd 自己转译高阶动作
- 音频输出目前固定为 `audio/ogg`
- Chromium 当前稳定音频路径依赖 `pipewire-pulse`，尚未验证纯原生 PipeWire 输出链路

## Next Work

更适合放在后续迭代的方向：

- browser resolution presets / explicit resize action
- 更细的 monitor auth / ticket 机制
- 更强的 browser automation ergonomics
- monitor popup 的进一步 polish
