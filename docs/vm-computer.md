# VM Computer

## Status

本文定义当前仓库里的 `vm computer` profile。

除非明确说明，下面描述的是当前已经实现的行为和已明确收敛的运行时语义，不是未来设想。

正式原则：

- `vm computer is a general-purpose virtual machine profile backed by QEMU/KVM.`

设计讨论与取舍记录见：

- [docs/incubation/vm-computer-rationale.md](/Users/timzhong/computerd/docs/incubation/vm-computer-rationale.md)

## User Mental Model

用户管理的是一台长期存在、可启动/停止/重启/监看/接入控制台的虚拟机。

用户应当这样理解它：

- 这是一台通用 VM，不是一次性 job
- `start` / `stop` / `restart` 就是虚拟机开机、关机、重启
- VM 默认有状态，系统盘数据会保留
- monitor 是图形主入口
- console 是 serial 主入口
- VM 的网络分两层：
  - `computer.network` 表示接入哪个 computerd network
  - `vm.runtime.nics[]` 表示 guest NIC 与 IP 配置

用户不需要理解：

- 任意 QEMU 参数拼装
- 任意设备矩阵
- 任意启动参数注入
- 复杂网络后端切换

## Object Model

vm computer 仍然是统一 `computer` 模型的一种 profile：

- `profile = "vm"`

没有新增新的顶层 `virtual-machine` / `guest` object kind。

它和其他 profile 的关系是：

- `host` 表示宿主长期环境
- `browser` 表示宿主图形浏览器环境
- `container` 表示 image-backed 长期环境
- `vm` 表示基于完整虚拟机边界的长期环境

## Runtime Input

当前 `vm` create runtime 支持两条系统盘来源：

- `source.kind = "qcow2"`
- `source.kind = "iso"`

### `qcow2`

`qcow2` 路径适合直接从基础镜像派生一台 VM。

当前稳定字段：

- `runtime.hypervisor = "qemu"`
- `runtime.source.kind = "qcow2"`
- `runtime.source.imageId`
- `runtime.source.cloudInit`
- `runtime.nics[]`

其中：

- `cloudInit.enabled` 默认视为启用
- `cloudInit.enabled = false` 时不会生成 `cloud-init.iso`
- 第一版只支持 1 块 NIC

### `iso`

`iso` 路径适合人工安装传统系统。

当前稳定字段：

- `runtime.hypervisor = "qemu"`
- `runtime.source.kind = "iso"`
- `runtime.source.imageId`
- `runtime.source.diskSizeGiB?`
- `runtime.nics[]`

其中：

- `iso` 路径不自动应用 guest IP 配置
- 仍会保留 NIC 配置和 resolved MAC

VM create 当前不再直接接受 path，而是引用 image inventory。

也就是说：

- `qcow2` VM 通过 `imageId` 选择基础镜像
- `iso` VM 通过 `imageId` 选择安装介质
- VM image 可通过 image inventory import 到 computerd 自己的 image store

image inventory 见：

- [docs/image-management.md](/Users/timzhong/computerd/docs/image-management.md)

## Runtime Layout

当前 VM runtime 由 systemd primary unit 管理，底层是 `qemu-system-x86_64`。

目录约定：

- state root: `/var/lib/computerd/computers/<slug>/vm`
- runtime root: `/run/computerd/computers/<slug>/vm`

每台 VM 的持久资产包括：

- `disk.qcow2`
- `cloud-init.iso`（仅 `qcow2 + cloud-init enabled`）
- `cloud-init/` 目录（user-data / meta-data / network-config）

运行时资产包括：

- `serial.sock`

当前 delete 语义会清理 VM artifacts：

- systemd unit
- VM state 目录
- VM runtime 目录

因此同名 delete / recreate 当前是允许的。

## Lifecycle

当前已经实现：

- `create`
- `get`
- `list`
- `start`
- `stop`
- `restart`
- `delete`

broken state 语义与其他 computer 保持一致：

- metadata 仍存在
- backing runtime entity 丢失
- 当前只支持 inspect

当前不支持：

- repair
- force delete
- metadata-only cleanup

## Monitor And Console

vm computer 当前同时支持两条交互面：

- `monitor`
- `console`

### Monitor

monitor 复用现有 VNC session contract：

- `POST /api/computers/:name/monitor-sessions`
- `GET /api/computers/:name/monitor/ws`

底层直接桥接到 QEMU 内建 VNC。

当前图形输出固定使用：

- QEMU VNC

当前不做：

- SPICE
- virtio-gpu
- audio

### Console

console 复用现有 websocket terminal surface，但背后接的是 QEMU serial socket。

这意味着：

- 它不是 host shell
- 也不是 browser console
- 它是 VM guest serial

当前 console 通过：

- `POST /api/computers/:name/console-sessions`
- `GET /api/computers/:name/console/ws`

## Network Model

当前 VM 网络采用两层模型。

### Layer 1: `computer.network`

`computer.network` 表示这台 VM 当前连接到哪个 computerd network object。

network object 当前至少表达：

- `id`
- `name`
- `kind`
- `cidr`
- bridge / router / DHCP / NAT 的只读健康状态

当前第一版 `kind` 只有两种：

- `host`
- `isolated`

当前语义固定为：

- `host` = 接入保留的 host network
- `isolated` = 接入用户创建的 isolated network

桥接映射：

- `host network` -> `COMPUTERD_VM_BRIDGE`，默认 `br0`
- `isolated network` -> 该 network 自己的 `bridgeName`

VM create 当前不再直接传 `network.mode`，而是通过 `networkId` 选择 network object。

### Layer 2: `vm.runtime.nics[]`

`vm.runtime.nics[]` 表示 guest 内部的 NIC 与 IP 配置。

第一版字段：

- `name`
- `macAddress?`
- `ipv4`
- `ipv6`

支持的地址模式：

- IPv4
  - `disabled`
  - `dhcp`
  - `static`
- IPv6
  - `disabled`
  - `dhcp`
  - `slaac`
  - `static`

约束：

- 当前只支持一块 NIC
- 如果未提供 `macAddress`，computerd 会生成稳定 MAC
- 如果显式提供 `macAddress`，detail、cloud-init 和 QEMU 都会使用这个值

### Auto-apply Rules

当前只有下面这条路径会自动把 IP 配置下发到 guest：

- `source.kind = "qcow2"`
- `cloudInit.enabled !== false`

这时 computerd 会：

- 生成 `network-config`
- 按 MAC 匹配 NIC
- 自动把 IPv4/IPv6 配置写进 guest

其余情况：

- `iso`
- `cloudInit.enabled = false`

仍保留 `runtime.nics[]`，但不会自动应用到 guest。

detail 里会通过：

- `runtime.nics[0].ipConfigApplied`

明确标记当前是否已自动应用。

## Resource Model

当前 VM 资源限制还比较保守。

已接上的主要是：

- `resources.cpuWeight` -> systemd `CPUWeight=`
- `resources.memoryMaxMiB` -> systemd `MemoryMax=` 与 QEMU `-m`

当前没有形成统一的 CPU 总量/配额模型。

因此：

- `-smp` 当前固定为 `1`
- 不使用 `cpuWeight` 去推导 guest vCPU 数

## Current Constraints

当前第一版明确约束：

- 只支持 Linux / x86_64
- 要求宿主存在 `/dev/kvm`
- 不做 TCG fallback
- 不做多 NIC
- 不做 live snapshot
- 不做 NAT / DHCP / DNS
- 不做 per-NIC backend
- 不做 guest agent
- 不做 VM automation surface

当前推荐用法是：

- 人类：走 monitor / console
- agent：当前主要仍通过 monitor / console 协作，而不是依赖专门 VM automation contract

## Validation

当前 VM network 改动的真机 smoke 已经收成脚本：

- [scripts/smoke-remote-vm.mjs](/Users/timzhong/computerd/scripts/smoke-remote-vm.mjs)

对应 skill：

- [vm-remote-smoke/SKILL.md](/Users/timzhong/computerd/.codex/skills/vm-remote-smoke/SKILL.md)

统一 network object 设计见：

- [docs/computer-networks.md](/Users/timzhong/computerd/docs/computer-networks.md)

这条 smoke 只覆盖最关键主链路：

- `qcow2`
- `cloud-init enabled`
- `host network`
- 单 NIC
- 静态 IPv4

环境准备、风险和故障排查不在脚本里，而在 skill 中说明。
