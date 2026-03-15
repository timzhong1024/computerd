<!-- DOC-TODO-START -->

## 当前 TODO

- [ ] P1: 定义并落地 profile-independent 的 generic input injection contract，先覆盖 pointer / keyboard，再决定各 profile 的暴露范围。
- [ ] P2: 设计 optional perception sidecar contract，明确其作为增强面而不是 core control contract 前置依赖。
<!-- DOC-TODO-END -->

# Display Interface Model

## Status

本文定义 computerd 中与“显示器/屏幕”相关的通用接口模型。

除非明确说明，下面描述的是推荐接口边界与目标方向，不表示当前仓库已经全部实现。

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

- 点击 / touch
- swipe / drag
- keyboard input
- 特定设备按键

display interface 关心的是“通用输入注入”，不关心更高层对象语义。

从更抽象的接口角度看，它更适合被收敛成这几类原语：

- pointer
  - move
  - down
  - up
  - click
  - scroll
  - drag
- keyboard
  - down
  - up
  - type
  - hotkey
- touch
  - tap
  - down
  - move
  - up
  - swipe

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
- vm computer monitor session
- vm computer screenshot
- host/container console surface

### Not Implemented Yet

- 通用 `input injection` API
- browser generic pointer / keyboard injection contract
- vm generic pointer / keyboard injection contract
- touch-oriented display contract
- perception / OCR / visual grounding sidecar contract
- 视频帧流级的 stable observation contract
- 把 audio 抽象成 profile-independent display observation surface

### Design Implication Of Current Status

当前仓库已经有：

- display observation 的一部分
- console interface
- browser specialized surface

当前还没有：

- display execution 的通用输入层

因此下一阶段更合理的工作顺序应当是：

1. 先补齐 generic input contract
2. 再决定哪些 profile 暴露 pointer / keyboard / touch
3. perception sidecar 保持 optional，不阻塞 core contract
4. browser 继续坚持 `CDP` first，而不是退回 server-side 高阶 browser DSL

## Current Relevance To Android

对 `android computer` 来说，这套模型具体意味着：

- monitor / screenshot / input injection 是基础 display 能力
- `adb shell` 是 console interface
- Appium / `adb` device operations 是 specialized Android surface
- OmniParser / UGround 更适合做 display perception sidecar，而不是替代 Appium 的 primary automation engine
