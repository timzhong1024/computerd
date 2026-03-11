---
name: vm-remote-smoke
description: Run the real-machine VM smoke workflow against a remote Linux host with KVM. Use when the user asks to verify VM computer behavior on a real machine, a remote dev host, nested virtualization, bridge networking, or explicitly mentions $vm-remote-smoke.
---

# VM Remote Smoke

在用户要求“远端机器验证”“真机验证”“KVM/nested virtualization 实机 smoke”“验证 VM computer 真正起机和配网”时使用这个 skill。不要用它替代本地单元测试或 `pnpm verify:quick`。

## What This Skill Does

使用仓库内脚本 [scripts/smoke-remote-vm.mjs](/Users/timzhong/computerd/scripts/smoke-remote-vm.mjs)：

1. 从本地把当前工作树同步到远端文件系统
2. 在远端执行 `pnpm install --frozen-lockfile` 和 `pnpm build`
3. 在远端临时启动 `apps/server/dist/server.js`，默认端口 `3001`
4. 创建一台 `qcow2 + cloud-init enabled + runtime.nics[0].ipv4=static` 的 VM
5. 启动 VM，等待 `state=running`
6. 从宿主 ping guest 静态 IP，验证 host bridge + guest NIC 配置真正生效
7. 清理临时 VM 和临时 `3001` server

## Hard Requirements

这不是 CI 脚本，也不是开发模式脚本。必须满足：

- 用户必须提供一台“干净的、不重要的、搞坏了也无所谓”的 Linux 机器作为测试机
- 用户必须提供一台“干净的、不重要的、搞坏了也无所谓”的 Linux 机器作为测试机
- 用户必须提供一台“干净的、不重要的、搞坏了也无所谓”的 Linux 机器作为测试机
- 远端是 Linux 真机，或至少是已开启 nested virtualization 的 Linux VM
- 远端必须有 `/dev/kvm`
- 远端必须装好 `qemu-system-x86_64`
- 远端必须能运行仓库要求的 `node` / `pnpm`
- 本地到远端必须可无交互 `ssh`
- 远端需要一个用于测试的仓库落点，默认 `/root/computerd`
- 远端需要准备好 host bridge，默认 `br0`
- 远端需要准备好一个 `qcow2` cloud image；脚本不会替你下载镜像

如果这些前提不满足，这个 skill 不应继续“尝试看看”，而应先报告缺失项。

## Important Limits

这个 smoke 只验证当前最关键、最窄的一条真机主链路：

- `profile = "vm"`
- `source.kind = "qcow2"`
- `cloudInit.enabled = true`
- `network.mode = "host"`
- 单 NIC
- 静态 IPv4

它不验证：

- `iso` 安装流程
- `cloudInit.enabled = false`
- `network.mode = "isolated"` 的真桥接
- DHCP / SLAAC / IPv6 实际互通
- 长时间稳定性或性能

## Default Command

在仓库根目录运行：

```bash
COMPUTERD_REMOTE_HOST=root@your-test-host \
COMPUTERD_VM_BASE_IMAGE=/var/lib/images/ubuntu-24.04-server-cloudimg-amd64.img \
pnpm smoke:vm:remote
```

如果需要显式指定目标：

```bash
node ./scripts/smoke-remote-vm.mjs \
  --remote-host root@your-test-host \
  --remote-repo /root/computerd \
  --remote-port 3001 \
  --vm-bridge br0 \
  --vm-base-image /var/lib/images/ubuntu-24.04-server-cloudimg-amd64.img
```

## What The Script Intentionally Does Not Do

脚本只做最关键的 smoke，不负责环境准备。不要往脚本里继续塞这些逻辑：

- 不下载镜像
- 不安装 `qemu` / `node` / `pnpm`
- 不配置 nested virtualization
- 不搭建主机 bridge
- 不处理 `isolated` bridge
- 不验证 `iso` 安装路径
- 不验证 DHCP / SLAAC / IPv6 真互通

这些前置准备、人工检查和故障排查都应该留在 skill 说明里，而不是塞进脚本。

## Preparation Checklist

跑脚本前先人工确认：

1. `ssh root@your-test-host` 可无交互登录
2. `test -e /dev/kvm`
3. `qemu-system-x86_64 --version`
4. `bash -lc 'node -v && pnpm -v'`
5. `ip link show br0`
6. cloud image 路径存在，例如 `/var/lib/images/ubuntu-24.04-server-cloudimg-amd64.img`

有一项不满足，就先停下来修环境，不要直接跑脚本。

## Common Failure Modes

- `missing remote host`：没有传 `--remote-host`，也没设置 `COMPUTERD_REMOTE_HOST`
- `missing VM base image`：没有传 `--vm-base-image`，也没设置 `COMPUTERD_VM_BASE_IMAGE`
- 远端 `pnpm: command not found`：远端非交互 shell 没有初始化 Node/Pnpm 环境
- `/healthz` 起不来：远端 build 或 server 运行时依赖有问题
- VM create 400：当前 schema 变了，脚本 payload 需要同步
- VM 进入 `running` 但宿主 ping 不通：大概率是 bridge、cloud-init 网络应用、或 guest NIC 命名/匹配问题
- 清理后主服务异常：脚本只应该动临时 `3001` server；如果主 `3000` 被影响，说明脚本回归了，需要立即修

## When To Stop And Report

出现下面任一情况时，直接停下并报告，不要继续猜测：

- 远端没有 `/dev/kvm`
- `br0` 不存在或未就绪
- base image 路径不存在
- 远端 `pnpm install` / `pnpm build` 失败
- 临时 server 在 `3001` 无法通过 `/healthz`
- VM 能创建但长时间无法进入 `running`
- guest NIC 未自动应用，或宿主无法 ping guest IP

## Reporting Format

汇报真机结果时至少包含：

1. 目标机器，例如 `root@10.0.0.202`
2. 使用的 VM 合同：
   - `profile = "vm"`
   - `network.mode = "host"`
   - `runtime.nics[]`
3. 关键结果：
   - create/start 是否成功
   - `state`
   - resolved `macAddress`
   - `bridge`
   - `ipConfigApplied`
   - 宿主 `ping` 是否成功
4. 是否已清理临时 VM 与临时 `3001` server
