# Browser Container Runtime Rationale

## Status

本文记录已经被采纳的一次架构判断：

- `browser computer` 继续保留为产品 profile
- `browser` 的底层 runtime 从 host-based systemd unit 演进到 container-backed runtime

它不是正式规格；当前正式定义仍以：

- [docs/browser-computer.md](/Users/timzhong/computerd/docs/browser-computer.md)
- [docs/computer-networks.md](/Users/timzhong/computerd/docs/computer-networks.md)

为准。

## Original Starting Point

当前 browser runtime 的真实形态并不是“宿主上一个普通浏览器进程”，而是由 computerd 托管的一整套专用运行环境：

- 独立 runtime user
- 独立 state/runtime/profile 目录
- 独立 virtual display
- 独立 CDP / VNC / audio attach surface
- 由 primary systemd unit 拉起整组辅助进程

当前 unit 内实际承载的是：

- `Xvfb`
- `chromium`
- `x11vnc`
- `pipewire`
- `wireplumber`
- `pipewire-pulse`

这说明 browser 在产品上虽然仍是 `computer.profile = "browser"`，但在运行时上已经不是“host process with a command line”，而是一个专用 sandbox。

## Why Host-based Runtime Becomes Awkward

网络模型收敛后，问题变得很直接：

- `container` 和 `vm` 天然有独立网络边界
- `browser` 当前没有
- `host` / `browser` 选择 isolated network 时只能报 unsupported

如果继续坚持 host-based browser runtime，要补齐 isolated network，通常需要额外引入：

- netns 生命周期管理
- `veth` / bridge 接线
- 地址、路由、DNS 配置
- 与 control-plane 旁路通信的边界处理

一旦 browser runtime 还需要自己携带 DHCP client、独立 `/etc/resolv.conf` 视图或更多 userspace 网络初始化，它就开始明显长成“自制容器”，而不是普通 systemd service。

## Key Architectural Observation

这里最重要的判断不是：

- browser 像不像浏览器

而是：

- browser runtime 像不像容器工作负载

答案基本是：

- 像

因为它已经具备容器式工作负载的大部分特征：

- 独立用户态环境
- 独立运行目录
- 独立网络隔离诉求
- 独立 attach surface
- 明确的持久化 profile

继续把它维持在 host-based service 形态，意味着 control plane 需要不断手搓容器 runtime 已经擅长解决的问题。

## Why Not Change The Product Model

这个判断不意味着：

- 把 `browser` 降格成 `container`
- 或重新把顶层对象改回 workload-first

顶层产品模型仍应保持：

- managed object 还是 `computer`
- `browser` 还是一个独立 profile

变化只发生在 runtime substrate：

- `browser profile`
  - before: host-based systemd service
  - after: container-backed browser runtime

也就是说，用户看到的仍然是 browser computer，不是“装了 Chromium 的 container”。

## Why Container-backed Runtime Fits Better

### Networking

这是最直接的收益。

container runtime 天然已经解决：

- 独立 netns
- network attach
- DNS 视图
- 默认路由
- 与 `networkId -> bridge/network substrate` 的映射

这比在 host service 上补 netns wiring 更自然，也更接近当前 `network` 顶层对象的设计方向。

### Environment Reproducibility

当前 browser 对宿主环境依赖很重：

- Chromium 版本
- Xvfb / x11vnc / PipeWire 可用性
- 用户权限
- 目录布局

container-backed runtime 能把其中相当一部分固定进 image，减少宿主差异。

### Lifecycle Clarity

现在 browser primary unit 里混合了：

- business process
- display helper
- audio helper
- attach helper

容器化后，这些更适合作为 browser runtime image 内部的一组受控进程，而不是 unit-file 层的大段 shell orchestration。

### Future Extensibility

如果后续出现：

- headless browser variant
- 带代理 / 证书 / 插件的 browser profile
- 更强的网络策略

container-backed runtime 更容易扩展，而不需要继续加厚 host-side runtime script。

## Main Counterweight

这个方向最主要的阻力不是网络，而是图形和音频。

### Audio

当前音频链路依赖 PipeWire/Pulse 兼容语义，并且和宿主 attach 方式耦合较深。

容器化后必须重新决定：

- PipeWire 是否仍在容器内启动
- 是否桥接宿主 socket
- server 侧如何稳定抓流

这部分复杂度明显高于“把 Chromium 接进 isolated network”。

### Display And Attach

当前 `Xvfb + x11vnc + chromium` 都在同一 host unit 内。

改成 container backend 后，需要重新收敛：

- 哪些组件进入容器
- monitor / automation / screenshot 通过什么边界导出
- 哪些仍保留为宿主侧 bridge/attach 层

## Why Host Profile Should Not Follow The Same Path

`browser` 像容器，不代表 `host` 也应同样演进。

原因是：

- `host` 的产品语义就是宿主环境上的长期进程
- 一旦给 `host` 强加独立 netns 和独立网络视图，它的“host”语义会迅速变形

所以更合理的收敛是：

- `host` 继续只支持 host network
- `browser` 单独演进到更适合隔离的 runtime substrate

## Recommended Migration Direction

推荐的不是：

- 把现有 browser profile 删除

而是：

- 保持 browser profile / API / WebUI / MCP contract 基本不变
- 只替换底层 runtime implementation

第一阶段更合理的目标是：

- container-backed Chromium
- container 内自带 virtual display stack
- monitor / CDP / screenshot 继续暴露现有能力
- 先拿到 isolated network 支持
- audio 单独作为下一阶段问题

这条路径的价值在于：

- 先解决最强的结构性痛点
- 避免一开始把音频、网络、图形、控制面全部一起重构

## Decision

最终结论不是“browser 就是 container”。

结论是：

- `browser` 在产品上仍然是 browser computer
- `browser` 在技术实现上已经足够 container-like，因此迁移到了 container-backed runtime

如果继续停留在 host-based browser runtime 上补 isolated networking，团队很可能会在 systemd + shell + host netns 上重复制造一个不完整的容器子系统。
