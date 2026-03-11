# Computer Profiles

## Summary

当前 computerd 管理三类 computer：

- `host`
- `browser`
- `container`
- `vm`

它们共享同一套 control-plane object model，但背后的 runtime substrate 不同。

## Broken State

所有 profile 现在都可能返回：

- `state = "broken"`

语义固定为：

- computer metadata 仍存在
- 但 backing runtime entity 已经找不到

当前 broken 只支持 inspect：

- `list`
- `get detail`

当前不支持：

- `start`
- `stop`
- `restart`
- `delete`
- 任何 attach/session surface

computerd 当前不会自动 repair / recover broken computer，也不提供 force delete。

## Host And Container Interaction

### Host

`host` computer 的主要交互面是 console。

如果启用了 console access，computerd 会把它作为主交互 shell surface 暴露出来。

### Container

`container` computer 当前有两种不同语义的终端面：

- `console`
- `exec`

`console` 的语义是：

- 连接容器主进程的交互 stdin/stdout

`exec` 的语义是：

- 在已运行容器里临时打开一个新的 `/bin/sh`

### VM

`vm` computer 当前基于 `QEMU/KVM`，同时支持两条交互面：

- `monitor`
- `console`

`monitor` 复用现有 VNC/noVNC surface，直接桥接到 QEMU 内建 VNC。

`console` 复用现有 websocket terminal surface，但背后接的是 QEMU serial socket，而不是 shell/tmux。

当前第一版支持两种系统盘来源：

- `qcow2` 基础镜像
- `iso` 安装介质

其中：

- `qcow2` 路径支持最小 cloud-init
- `iso` 路径依赖人工安装系统
- `computer.network` 表示这台 VM 接入哪种 bridge/network substrate
- `vm.runtime.nics[]` 表示 guest 内部 NIC 与 IP 配置
- 当 VM 使用 `qcow2 + cloud-init enabled` 时，computerd 会根据 `vm.runtime.nics[0]` 生成并应用 `network-config`
- `iso` 或 `cloud-init disabled` 时，NIC 配置仍会保留，但不会自动下发到 guest
- 当前自动网络配置只覆盖单 NIC VM

当前约束：

- 只支持 Linux / x86_64
- 要求宿主存在 `/dev/kvm`
- 图形输出只使用 QEMU VNC
- `network.mode = "host"` 绑定 `COMPUTERD_VM_BRIDGE`
- `network.mode = "isolated"` 绑定 `COMPUTERD_VM_ISOLATED_BRIDGE`
- 当前开发机桥接模式是 host-only 静态网段，不做 NAT / DHCP

## Current Recommendation

当前对 agent 的推荐仍然是：

- 优先使用 console-capable computer
- 对 container，优先让主进程本身就是可交互的

当前 `exec` 更偏：

- operator-only
- web-oriented
- 临时排查/观察入口

这并不意味着未来永远不会支持 agent-facing exec；只是当前还没有把它定义成稳定的自动化 contract。
