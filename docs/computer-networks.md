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
- bridge / router / DHCP / NAT 的只读健康状态
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
