# Display Interface Model

## Status

本文定义 computerd 中与“显示器/屏幕”相关的通用接口模型。

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

## Interface Layers

computerd 中更合适的 agent-facing 分层是：

- display interface
- console interface
- specialized surface

其中：

- display interface
  面向 screen / viewport / generic input
- console interface
  面向 shell / command stream
- specialized surface
  面向某一特定对象模型的高效操作协议

## Display Interface

display interface 的最小组成建议是：

- monitor
- screenshot
- input injection

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

## Current Relevance To Android

对 `android computer` 来说，这套模型具体意味着：

- monitor / screenshot / input injection 是基础 display 能力
- `adb shell` 是 console interface
- Appium / `adb` device operations 是 specialized Android surface
- OmniParser / UGround 更适合做 display perception sidecar，而不是替代 Appium 的 primary automation engine
