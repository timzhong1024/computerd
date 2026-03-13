# Computer Networks Rationale

## Status

本文记录 `computer network` 与 `gateway` 模型的讨论过程、取舍依据和当前收敛出的设计方向。

它不是正式规格文档。

正式定义见：

- [docs/computer-networks.md](/Users/timzhong/computerd/docs/computer-networks.md)

## Starting Point

最初的 network 模型非常薄，只够表达：

- `host`
- `isolated`

而且它更像是 `computer` 上的一个小枚举，不像一个真正的顶层对象。

后来随着 `vm`、`container`、`browser` 的能力逐步落地，问题变得很明确：

- 单纯的 `network.mode` 不足以表达 computer 连接到哪张网
- 也不足以表达这张网自身的状态
- 更无法承载未来的 DHCP、DNS、NAT、VPN 暴露或 programmable gateway 能力

因此网络模型最终被收敛成新的顶层对象：

- `network`

## Why Network Became A Top-level Object

没有继续把 network 留在：

- `computer.network.mode`

而是提升成顶层对象，原因是：

- network 有自己的生命周期
- network 有自己的状态
- network 可以被多个 computers 共享
- network deletion 需要检查 attached computers
- network 未来要承载 gateway 能力，而不是只做一个 mode 字段

所以最终模型是：

- `computer` 引用 `network`
- `network` 自己描述 subnet / bridge / gateway 状态

## Why There Is A Reserved Host Network

一开始最容易走向“所有网络都是用户创建”的方向，但后来保留了一个系统保留对象：

- `host network`

原因很现实：

- 很多 computer 仍然需要一个默认网络承载
- `host/browser` 的 isolated runtime 当前还没有完全实现
- 保留一个不可删除的 host network，可以让模型统一而不要求所有 profile 同时完成隔离实现

因此现在的基础形态是：

- `host network`
  - 永远存在
  - 不可删除
- `isolated network`
  - 用户创建
  - 只要仍有 computer 连接就不能删除

## Why Network And VM NICs Are Two Layers

网络设计里最关键的一次收敛，是把：

- `computer 连接哪张网`
  和
- `VM guest 里哪块 NIC 怎么配`

明确拆开。

最终得到两层：

- `network`
- `vm.runtime.nics[]`

这里的判断是：

- `network` 只表达 computerd 提供的网络承载
- `vm.runtime.nics[]` 只表达 VM guest 内部的网卡与地址配置

如果不拆开，IP 配置就会错误地污染通用 network 模型。

## Why Host And Browser Were Not Forced Into Full Isolation Immediately

产品模型一旦统一后，很自然会想让：

- `host`
- `browser`
- `container`
- `vm`

同时真正进入 isolated network。

但运行时差异其实很大：

- `container` 和 `vm` 天然有独立网络边界
- `browser` 是一整套图形 runtime stack
- `host` 是长期进程环境

所以当前实现顺序刻意收敛成：

- 先让 `container + vm` 真正接入 isolated network
- `browser + host` 先在产品模型里统一到 network object
- 运行时暂时只支持它们连接 `host network`
- 若选择 isolated，明确报 unsupported

这样能先稳定住模型，而不是为了对称性把运行时复杂度一下拉满。

## Why Control Plane Must Bypass Business Network

讨论 `host/browser` 隔离时，一个关键问题是：

- 管理面要不要走 computer 自己的业务网络？

最终收敛出的原则是：

- 不允许

也就是说：

- business traffic 进入 selected network
- control-plane traffic 永远走宿主侧旁路

原因很直接：

- 一旦业务网络配置错了，computer 不能连管理面一起失联
- console / monitor / automation 必须继续可达

这个原则后来也反过来影响了 network 与 gateway 的后续设计。

## Why Router Was Not Promoted To A Top-level Object

network 能力开始变复杂后，最容易继续演化成：

- `router` 也做成顶层对象

但后来没有这么做。

原因是：

- 用户心智里真正关心的是“这张 network 的网关如何处理流量”
- 而不是“我有一个 network，再挂一个 router 对象”
- 对当前产品阶段来说，多一个顶层对象只会把模型变重

所以最终收敛成：

- `network`
- `network.gateway`

router 不再作为单独顶层资源，而是 network detail 的一部分。

## Why We Moved From Router State To Gateway Model

早期 network detail 更像几个零散的健康状态：

- `routerState`
- `dhcpState`
- `natState`

这足够表达运行时健康，但不足以承载未来能力。

后来的判断是：

- 用户看的是一张 network 的 gateway
- 不是几个散落的布尔/状态位

因此网关模型被收敛成统一的：

- `gateway`

而不是继续围绕 `routerState/dhcpState/natState` 加字段。

## Why DHCP Is Fixed But DNS Is Replaceable

在真正进入 gateway 分层之后，最自然的问题是：

- 哪些东西值得模块化
- 哪些不值得现在开放

最终这期收敛成：

- `dhcp`
  - 固定实现
  - 当前不允许替换
- `dns`
  - 显式子模块
  - 默认 `dnsmasq`
  - 未来允许 `smartdns`

这么做的原因是：

- DHCP 更偏基础设施底座，当前先求稳定
- DNS 更容易承载差异化能力
- DNS 替换不会像 DHCP 一样立刻影响整个地址分配语义

所以这一期只把 DNS 真正模块化，而不是一上来开放整套 gateway runtime 替换。

## Why Programmable Gateway Is A Reserved Slot

讨论到更高阶能力时，最初容易按功能拆成：

- policy
- transparent-proxy
- subnet advertise

后来逐步发现，这些能力在实现层很可能共享同一条数据面骨架：

- match
- jump 到自定义链
- 再进入本地 software network proxy / gateway

同时，在用户视角上再拆成很多概念会显得冗余。

于是最终收敛成：

- `programmableGateway`

它是统一的高阶 L3/L4 软件网关插槽，而不是多个并列的大类。

当前阶段只做 provider 预留，不做数据面实现。

## Why Programmable Gateway Has No Enabled Flag

`programmableGateway` 没有设计成：

- `enabled: true | false`

而是只看：

- `provider`

原因是：

- 对用户来说，是否启用高阶网关，本质上取决于选了什么 provider
- 再加一个 `enabled` 只会制造状态组合和歧义

因此当前固定规则是：

- `provider = null` -> 未启用
- `provider != null` -> 已选择某种 programmable gateway

## Why VPN Exposure Was Not Treated As A Separate Top-level Feature

后来又遇到一个关键问题：

- `tailscale/openvpn` 应该挂在哪个插槽？

最终没有把它们建模成：

- 新顶层对象
- 单独的 VPN feature 集合

而是归到：

- `gateway.programmableGateway`

这样做的原因是：

- 它们本质上也是 software gateway/provider
- 用户关心的是“这张 network 的 gateway 如何对外暴露和处理流量”
- 不需要再引入第三套主心智

## Why This Iteration Stops At The Framework

这期最重要的判断，不是“把所有东西一次实现完”，而是：

- 先把模型和插槽定死

所以这一期明确只做：

- gateway 模型
- DHCP 固定
- DNS provider 插槽
- programmable gateway provider 插槽
- 兼容迁移
- UI / API / MCP / docs 对齐

而不做：

- `smartdns` 真正运行
- `tailscale/openvpn` 真实数据面
- 更细粒度的 provider-specific schema

原因是当前最重要的是：

- 不再继续让 network 模型野生增长
- 给后续 DNS 和 programmable gateway 留出稳定位置

## Current Direction

当前稳定方向可以概括成：

- `network` 是顶层对象
- `gateway` 是 network 的统一能力视图
- `dhcp` 固定实现
- `dns` 可替换，但默认仍是 `dnsmasq`
- `programmableGateway` 是高阶 L3/L4 software gateway 的预留插槽
- 当前 provider 只保留：
  - `tailscale`
  - `openvpn`

未来如果继续往前推进，应该优先围绕这两个方向展开：

- DNS provider 的真实 runtime 分化
- programmable gateway provider 的真实实现与状态面
