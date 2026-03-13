# VM Computer Rationale

## Status

本文记录 `vm computer` 的讨论过程、取舍依据和当前收敛出的设计方向。

它不是正式规格文档。

正式定义见：

- [docs/vm-computer.md](/Users/timzhong/computerd/docs/vm-computer.md)

## Starting Point

最初的问题不是“要不要支持 QEMU”，而是：

- computerd 已经有 `host`、`browser`、`container`
- 还缺不缺一类真正有 machine boundary 的 computer
- 如果要补，这个对象到底应该是什么语义

后来逐步明确的一点是：

- `container` 解决的是 image-backed 长期环境
- 它不替代完整 guest OS 边界
- 如果要承载更真实的系统级行为，VM 仍然是独立一层

## Why VM Is A Separate Profile

我们没有把 VM 做成：

- `host` 的一个 runtime 选项
- `container` 的一个高级模式

而是保留：

- `profile = "vm"`

原因很直接：

- VM 的生命周期与交互面和其他 profile 明显不同
- 它天然同时需要 monitor 和 serial console
- 它有自己的磁盘、cloud-init、VNC、QEMU 进程、guest 配网问题

如果把这些都塞进 `host` 或 `container`，顶层模型反而会变脏。

## Why QEMU/KVM First

底层最先锁定的是：

- `QEMU/KVM`

而不是：

- Firecracker
- libvirt first
- 自研 VM wrapper

原因是：

- 当前仓库已经以 systemd 为主控制面
- QEMU 参数和产物形态足够直接
- VNC 和 serial 都是现成能力
- 第一版更需要“快把主链路打通”，不是先叠一层完整虚拟化平台抽象

因此当前路线是：

- systemd primary unit
- 底层 `qemu-system-x86_64`
- monitor 直接复用 QEMU VNC
- console 直接复用 QEMU serial

## Why Monitor And Console Are Both First-class

一开始最容易出现的偏向是：

- 要么只做 GUI VM
- 要么只做 serial-only VM

后来收敛出的判断是：

- 这两个面都值得第一版一起做

原因是它们几乎都来自 QEMU 的原生能力：

- GUI -> VNC
- console -> serial

而产品收益很直接：

- monitor 让它真正像一台“computer”
- console 让它在安装、cloud-init 调试、网络排查时可控

所以第一版就同时支持：

- `monitor`
- `console`

## Why Only Qcow2 And ISO

系统盘来源一开始可能无限扩张：

- 任意镜像路径
- 任意块设备
- 任意安装介质组合

后来我们刻意把第一版收窄成两条：

- `qcow2`
- `iso`

这两条足够覆盖最关键的用户场景：

- `qcow2` -> 直接从 cloud image 起一台 VM
- `iso` -> 手工安装传统系统

这样既保留了通用 VM 的基本表达力，也不会过早变成“任意 QEMU 前端”。

## Why Cloud-init Is Optional

在 `qcow2` 路径上，cloud-init 的定位后来也收得比较清楚：

- 它是当前第一种自动 guest 初始化机制
- 不是 VM profile 的全部

所以现在是：

- `cloudInit.enabled !== false` -> 生成 `cloud-init.iso`
- `cloudInit.enabled = false` -> 不生成，也不挂这个盘

这点很重要，因为它决定了：

- create contract 允许关闭 cloud-init
- unit 渲染必须和这个 contract 保持一致

后来也确实暴露过一次回退：

- create 不生成 `cloud-init.iso`
- 但 QEMU unit 仍然无条件挂这个盘

这说明 VM profile 里，runtime contract 和 unit rendering 必须严格同步，不然 supported configuration 会直接变成启动失败。

## Why Network Was Split Into Two Layers

VM 网络是这一轮里最重要的一次建模收敛。

一开始的模型更接近：

- 在 VM runtime 上直接塞 `ipv4Address/prefixLength`

后来逐步发现这不够，因为它混淆了两类不同问题：

1. 这台 VM 接到哪种网络承载
2. guest 内部哪块 NIC 应该拿什么 IP

最终收敛出的结构是：

- `computer.network`
- `vm.runtime.nics[]`

### Why `computer.network`

`computer.network` 代表 computerd 提供的 network substrate / bridge 语义。

当前只保留两种：

- `host`
- `isolated`

它回答的是：

- 这台 VM 接到哪张桥

而不是：

- guest 内部配什么 IP

### Why `vm.runtime.nics[]`

`vm.runtime.nics[]` 代表 guest 内部的网卡与地址配置。

它回答的是：

- 这块 NIC 的 MAC 是什么
- IPv4/IPv6 是 DHCP、static 还是 disabled

这套模型之所以必要，是因为：

- cloud-init 需要命中“某块 NIC”
- guest 配网是网卡语义，不是单一 IP 字段语义

## Why NIC Is Single For Now

虽然 schema 设计成了 `nics[]`，但第一版依然只允许一块 NIC。

这是刻意限制，不是没想到多网卡。

原因是多 NIC 会立刻带来：

- 哪块 NIC 接哪张桥
- 默认路由落哪块 NIC
- per-NIC backend
- 多接口 cloud-init/netplan 生成
- 未来 host/container 是否也要跟着抽象

所以现在的结论是：

- 模型先设计成数组
- 实现先收窄到 1

## Why Stable MAC Matters

后面又有一次重要收敛：

- 不应该假设 guest 里的接口名稳定

之前如果按 `ens3` 去写 `network-config`，这条路在真机上是不稳的。后来改成：

- 每台 VM 派生稳定 MAC
- QEMU 网卡显式使用这个 MAC
- cloud-init 按 MAC `match`

再后来又暴露出另一条一致性问题：

- detail 里如果显式配置了 `runtime.nics[0].macAddress`
- QEMU 却还在用自动生成的稳定 MAC

最终正确的结论是：

- detail、QEMU、cloud-init 必须共享同一个 resolved MAC

也就是说：

- 用户显式提供 MAC -> 三处都用用户值
- 用户不提供 -> 三处都用 computerd 自动生成的稳定 MAC

## Why Delete Must Clean Artifacts

VM 不像 host/browser 只是一个 unit 文件。

它还有实际资产：

- `disk.qcow2`
- `cloud-init.iso`
- `cloud-init/`
- `serial.sock`

所以 delete 不能只删 metadata 和 unit。

后来也明确验证过：

- delete 后如果 VM artifacts 不清理，就会留下状态泄漏和脏目录

因此当前 delete 语义已经收成：

- 删 unit
- 删 VM state 目录
- 删 VM runtime 目录

这让同名 delete / recreate 成为可靠路径，而不是只删了“对象记录”。

## Why Bridge Ensure Stayed Narrow

在开发机验证里，网络问题很快逼着我们做了宿主 bridge ensure。

但这里没有继续扩成“大而全的网络管理器”，而是收得很窄：

- 只确保 bridge 存在
- 只确保桥有固定地址
- 只确保 QEMU bridge 配置可用

没有继续做：

- NAT
- DHCP
- DNS
- 主网卡桥接全自动化

因为当前阶段更重要的是：

- 验证 VM 主链路正确

而不是立刻把网络平台做完。

## Why Real-machine Smoke Matters

VM network 这条线在本地单测里只能验证：

- schema
- unit rendering
- cloud-init 文件生成

真正能证明模型是对的，还是得看真机：

- QEMU 是否真起机
- guest 是否真拿到 IP
- 宿主是否真能 ping 通 guest

所以后来把这套流程收成了仓库内脚本：

- [scripts/smoke-remote-vm.mjs](/Users/timzhong/computerd/scripts/smoke-remote-vm.mjs)

同时配了一份 skill：

- [vm-remote-smoke/SKILL.md](/Users/timzhong/computerd/.codex/skills/vm-remote-smoke/SKILL.md)

这里也有一个明确取舍：

- 脚本只保留最关键 smoke 逻辑
- 环境准备、镜像准备、桥接准备、风险说明都放在 skill

这样脚本不会变成“半个运维平台”，但真机验证路径仍然可重复。

## Current Conclusion

当前 `vm computer` 的设计结论可以收成几条：

- VM 是独立 profile，不是 host/container 的 runtime 变体
- 第一版底层固定 `QEMU/KVM`
- monitor 和 console 都是一等 surface
- 系统盘来源先只支持 `qcow2` 与 `iso`
- 网络模型固定为两层：
  - `computer.network`
  - `vm.runtime.nics[]`
- resolved MAC 必须在 detail / QEMU / cloud-init 三处一致
- delete 必须清理 VM artifacts
- 真机 smoke 是 VM network 相关修改的关键质量保障

这套定义让 VM 既保持了“通用虚拟机”的表达力，又没有过早滑向一个无限扩张的虚拟化平台。
