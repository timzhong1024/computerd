<!-- DOC-TODO-START -->

## 当前 TODO

- [ ] P1: 决定是否继续沿用 `display-actions` 作为公共命名，还是提升为更明确的 generic input contract，并把 browser / vm / future android 的暴露范围写成统一 capability 规则。
- [ ] P2: 在现有 pointer / keyboard v1 之上补齐 touch-oriented contract 与 optional perception sidecar 边界，但不要让它们阻塞 core control surface。
<!-- DOC-TODO-END -->

# Display Interface Model

## Status

本文定义 computerd 中与“显示器/屏幕”相关的通用接口模型。

当前仓库已经落地了第一版 screen generic input contract：

- `packages/core` 定义了 `DisplayAction` schema
- `packages/control-plane` 可对 browser / vm computer 执行批量 display actions
- HTTP 暴露 `POST /api/computers/:name/display-actions`
- MCP 暴露 `run_display_actions`

但它还只是 v1：

- 目前只覆盖 pointer / keyboard 相关基础原语与 `wait`
- 实际 profile 暴露范围当前只有 browser / vm
- touch、device key、perception sidecar 仍未进入稳定 contract

它不只服务 `android computer`，也服务：

- browser computer
- vm computer
- 未来其他带 monitor 的 computer profile

## Why This Document Exists

在 `android computer` 讨论过程中，逐渐发现“如何操作显示器”和“如何操作某个特化对象”不是同一件事。

如果把这两类问题混在一起，会导致：

- 把视觉理解和设备控制耦合在一个接口里
- 无法清楚地区分通用 monitor 能力与 browser / Android 特化能力
- 让 agent-facing contract 变得含混

因此，这里把显示器相关设计单独抽出来。

如果要专门看“通用输入动作该如何建模”，见：

- [docs/input-action-design.md](/Users/timzhong/computerd/docs/input-action-design.md)

## Core Principle

display interface 解决的是：

- agent 如何看见屏幕
- agent 如何对屏幕执行通用输入

display interface 不直接解决：

- app lifecycle
- shell access
- browser tab/page management
- Android device management

这些属于 specialized surface。

一个重要补充是：

- display interface 应该成为 agent 的通用完备兜底面
- 但 agent 不应被强制只使用 display interface
- 当存在更稳定、更高效的 specialized surface 时，应优先使用 specialized surface

## Interface Layers

computerd 中更合适的 agent-facing 分层是：

- display interface
- console interface
- specialized surface
- optional perception sidecar

其中：

- display interface
  面向 screen / viewport / generic input
- console interface
  面向 shell / command stream
- specialized surface
  面向某一特定对象模型的高效操作协议
- optional perception sidecar
  面向 OCR / region proposal / visual grounding

## Display Interface

display interface 的最小组成建议是：

- monitor
- screenshot
- input injection
- optional audio observe surface

其中：

- `monitor` 负责持续画面会话
- `screenshot` 负责静态观察
- `input injection` 负责通用输入执行
- `audio` 更适合作为独立 observation side channel，而不是 monitor 的子语义

### Monitor

`monitor` 的语义是：

- 获取实时画面
- 建立长期可交互显示会话

它不预设底层一定是：

- VNC
- noVNC
- scrcpy
- 其他任意图传协议

对外稳定 contract 应该是：

- `monitor session`

### Screenshot

`screenshot` 的语义是：

- 获取某一时刻的静态屏幕图像

它适合作为：

- 视觉感知输入
- 失败诊断 artifact
- 多模态 agent 的观察面

### Input Injection

`input injection` 的语义是：

- pointer / mouse input
- keyboard input
- 未来的 touch / device-key input

display interface 关心的是“通用输入注入”，不关心更高层对象语义。

当前仓库里已经落地的 agent-facing contract 名称是 `display-actions`。它在抽象上仍属于 generic input injection，只是命名还偏 display-oriented。

第一版已实现的原语是：

- pointer
  - `mouse.move`
  - `mouse.down`
  - `mouse.up`
  - `mouse.scroll`
- keyboard
  - `key.down`
  - `key.up`
  - `key.press`
  - `text.insert`
- timing
  - `wait`

还没有进入稳定 schema 的包括：

- `click` / `drag` / `hotkey` 这类宏动作
- `touch` / `device_key`
- 相对指针、focus、IME、high-res scroll 等可选能力

这层的目标不是“替 VLM 猜目标元素”，而是“给 agent 一套足够抽象、足够通用、可覆盖任意 GUI 的输入方式”。

## Visual Grounding

display interface 上可以叠加一层可选的 `visual grounding sidecar`。

这类模块解决的是：

- screen parsing
- interactable region detection
- visual grounding

典型代表包括：

- OmniParser
- UGround

它们更适合作为：

- `display perception`

而不是：

- device control protocol

也就是说，它们回答的是：

- “屏幕上哪里是目标区域”

而不是：

- “如何稳定打开某个 app”
- “如何进入 shell”
- “如何管理会话与生命周期”

这带来两个设计约束：

- computerd 不应把 visual grounding 做成 core control contract 的前置依赖
- computerd 也不应把 perception sidecar 从体系里完全排除

也就是说，更合理的边界不是：

- “必须预装 parser，agent 才能工作”
- “perception 一律不应该存在”

而是：

- generic input 是基础完备面
- perception 是可插拔增强面
- specialized surface 是优先路径

## Specialized Surface

specialized surface 的意义在于：

- 当某一类对象已经有更强、更稳定、更高效的专用协议时，agent 不必总盯着显示器做事

### Browser

对 browser computer 来说，specialized surface 是：

- `CDP`

它能高效完成：

- 标签页管理
- 导航
- DOM / page 操作

这比纯 monitor + screenshot + click 更快也更稳定。

因此 browser 的推荐策略应当是：

- 优先 `CDP`
- 需要视觉兜底时再回退到 screenshot + generic input
- 必要时允许 hybrid path，而不是强制纯 GUI path

### Android

对 android computer 来说，specialized surface 是：

- Appium
- `adb`

它们能高效完成：

- 打开 app
- 读取设备状态
- 进入 shell
- 执行 Android 特化动作

这同样比纯 monitor + screenshot + click 更快也更稳定。

## Design Implication

这套模型带来一个重要设计结论：

- 通用 display interface 是所有带屏 computer 的基础能力
- specialized surface 是某些 profile 的加速层，而不是基础层

因此 agent 的推荐路径通常应是：

- 优先使用 specialized surface
- specialized surface 不足时回退到 display interface
- visual grounding 作为 display interface 的增强层，而不是 specialized surface 的替代品

## Current Repository Status

下面是当前仓库内已经实现和仍未实现的边界。

### Already Implemented

- browser computer monitor session
- browser computer screenshot
- browser computer audio stream
- browser computer specialized surface: `CDP` attach
- browser / vm generic display action execution
- shared `DisplayAction` schema in `packages/core`
- HTTP `POST /api/computers/:name/display-actions`
- MCP `run_display_actions`
- vm computer monitor session
- vm computer screenshot
- host/container console surface

### Not Implemented Yet

- touch-oriented display contract
- Android-oriented device key / text contract
- click / drag / hotkey 等 higher-level macro contract
- richer pointer metadata contract（例如 relative mode / focus / scale mapping）
- perception / OCR / visual grounding sidecar contract
- 视频帧流级的 stable observation contract
- 把 audio 抽象成 profile-independent display observation surface

### Design Implication Of Current Status

当前仓库已经有：

- display observation 的一部分
- console interface
- browser specialized surface
- screen-oriented generic input v1

当前还没有：

- 覆盖 touch / android 的完整 generic input
- 明确的 profile capability matrix
- perception sidecar contract

因此下一阶段更合理的工作顺序应当是：

1. 明确 `display-actions` 是否就是长期 generic input 命名。
2. 把 browser / vm / future android 的 capability 暴露规则写清楚。
3. 在不破坏 v1 schema 的前提下扩展 touch / device-key。
4. perception sidecar 保持 optional，不阻塞 core contract。
5. browser 继续坚持 `CDP` first，而不是退回 server-side 高阶 browser DSL。

## Current Relevance To Android

对 `android computer` 来说，这套模型具体意味着：

- monitor / screenshot / input injection 是基础 display 能力
- `adb shell` 是 console interface
- Appium / `adb` device operations 是 specialized Android surface
- OmniParser / UGround 更适合做 display perception sidecar，而不是替代 Appium 的 primary automation engine
