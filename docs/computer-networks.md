# Computer Networks

## Summary

`network` 是 computerd 的新顶层对象。

它表示一个可被 computers 连接的网络承载，而不是某台 computer 自己的 IP 配置。

第一版的产品结论：

- 所有 computer 都引用一个 `network`
- 每台 computer 当前只连接一个 `network`
- 系统保留一个不可删除的 `host network`
- 用户可以创建多个 `isolated network`

## What A Network Represents

network object 当前表达的是：

- `id`
- `name`
- `kind`
- `cidr`
- bridge 的只读状态
- 统一 `gateway` 视图
- 当前连接的 computer 数量
- 是否允许删除

这意味着 `network` 代表的是 computerd 提供的网络承载，而不是 guest/container 内部的 IP 细节。

## Kinds

当前第一版只有两种 network kind：

- `host`
- `isolated`

### Host Network

`host network` 是系统保留对象：

- 永远存在
- 不可删除
- 表示接入宿主默认网络承载

在 VM 上，它会映射到：

- `COMPUTERD_VM_BRIDGE`，默认 `br0`

### Isolated Network

`isolated network` 是用户创建的网络：

- 可创建多个
- 只要还有 computer 连接就不能删除
- 由 computerd 托管 bridge / DHCP / NAT / router 运行时

## Gateway Model

network 对外现在统一暴露 `gateway`，而不是零散的 `routerState/dhcpState/natState`。

当前第一版的 `gateway` 结构包含：

- `dhcp`
- `dns`
- `programmableGateway`
- `health`

其中：

- `dhcp`
  - 当前固定实现为 `dnsmasq`
  - 不允许切换 provider
- `dns`
  - 默认 provider 仍然是 `dnsmasq`
  - 未来允许替换为 `smartdns`
- `programmableGateway`
  - 作为高阶 L3/L4 software gateway 的统一占位
  - 当前仅预留 provider，不实现数据面
  - provider 枚举预留：
    - `tailscale`
    - `openvpn`

`programmableGateway` 没有独立 `enabled` 标记位：

- `provider = null` 表示未启用
- 只要 `provider` 有值，就表示该 network 选择了某种高阶 programmable gateway

当前未实现 provider 的行为是：

- 配置可保存、可见
- network health 会明确显示为 `unsupported/degraded`
- 不会静默回退成“已经正常运行”

## Reserved Gateway Runtime Direction

当前已经明确预留的后续方向是：

- `isolated network` 最终会拥有一个 per-network managed gateway runtime
- 这个 runtime 不会提升成新的顶层对象
- 用户仍然只管理 `network`

这个方向下，gateway runtime 的目标形态是：

- 逻辑上是双口设备
- `lan` 面向 network inside segment
- `wan` 通过宿主提供的 transit/uplink substrate 对外
- DHCP / DNS / programmable gateway provider 最终都应收敛到这个 runtime

但这里要特别注意：

- 这仍然是方向性设计，不是已经稳定开放的外部合同
- 当前不要把 gateway runtime 的内部拓扑、地址分配、container 细节当成正式 API
- 当前文档层面只把它视为 `network.gateway` 背后的实现预留，而不是用户可单独操作的新资源

换句话说：

- `network.gateway` 是稳定能力视图
- “per-network managed gateway runtime” 是当前已收敛、但仍在继续实现中的底层方向

当前实现中：

- `container` 和 `vm` 已经能真实接入 isolated network
- `browser` 和 `host` 还没有完成真正的 isolated runtime 实现

## Network Versus VM NICs

`network` 和 `vm.runtime.nics[]` 是两层模型，不互相替代。

### `computer.network`

`computer.network` 决定：

- 这台 computer 接入哪个 computerd network
- 也就是接到哪张 bridge / network substrate

### `vm.runtime.nics[]`

`vm.runtime.nics[]` 只用于 VM，决定：

- guest 里有哪些 NIC
- 每块 NIC 的 MAC
- IPv4/IPv6 是 DHCP、static、disabled 还是 SLAAC

一句话：

- `network` 决定“接哪张网”
- `vm.runtime.nics[]` 决定“接上之后 guest 里怎么配网卡”

## Current Runtime Mapping

### Container

- `host network` -> Docker `NetworkMode: "host"`
- `isolated network` -> computerd 托管的 Docker bridge network

container 第一版只暴露 DHCP 语义，不提供 runtime-level NIC/IP 配置面。

### VM

- `networkId` 决定 QEMU NIC 接到哪张 bridge
- `vm.runtime.nics[]` 决定 guest 内部 DHCP/static 配置

当 VM 走 `qcow2 + cloud-init enabled` 时：

- computerd 会根据 `vm.runtime.nics[0]` 生成 `network-config`

当 VM 走 `iso` 或 `cloud-init disabled` 时：

- NIC 配置仍会保留
- 但不会自动下发到 guest

### Browser And Host

当前产品模型已经统一到 network object，但运行时隔离尚未做完：

- 允许连接 `host network`
- 选择 isolated network 会明确报 unsupported

后续实现原则已经固定：

- business traffic 进入 selected network
- control-plane traffic 始终通过宿主侧本地 IPC 旁路

## Current Boundary

虽然 gateway runtime 方向已经收敛，但目前仍有几条边界不应误解为“已经做完”：

- 不应把 gateway runtime 当成新的 public managed object
- 不应假设 DHCP / DNS / programmable gateway provider 的最终 runtime contract 已固定
- 不应假设 workload 的默认网关地址、host bridge address、transit subnet 这些内部细节已经成为正式外部约定

当前真正稳定的只有：

- `network` 作为顶层对象
- `network.gateway` 作为统一能力视图
- `programmableGateway.provider` 作为高阶 software gateway 的预留插槽

而下面这些仍然属于继续实现中的底层设计空间：

- per-network managed gateway runtime 的最终数据面形态
- workload 是否最终直接把 gateway runtime 作为默认路由
- 宿主 substrate 与 gateway runtime 的最终职责切分

## Lifecycle And Deletion

network delete 规则第一版固定为：

- `host network` 永远不可删除
- 只要仍有 computer 连接，network 就不能删除
- 不做 force delete
- 不做自动迁移到 host network

## API Surface

当前 HTTP API：

- `GET /api/networks`
- `GET /api/networks/:id`
- `POST /api/networks`
- `DELETE /api/networks/:id`

computer create contract 不再使用 `network.mode`，而是使用：

- `networkId`

## UI Surface

Web 当前提供：

- network inventory
- isolated network create/delete
- computer create 时选择 network

如果 profile 当前还不支持 isolated runtime，UI 会明确提示，不会静默回退到宿主网络。
