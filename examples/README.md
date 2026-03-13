# Examples

## `bash-terminal.ts`

最简单的 systemd 封装用法示例：

- 通过 `new SystemdControlPlane()` 创建一个 control plane
- 创建一个 `host` 类型的 persistent `computer`
- 将 `runtime.command` 设为 `/usr/bin/bash -i -l`
- 执行 `start -> get detail -> stop -> delete`

运行方式：

```bash
pnpm exec vite-node examples/bash-terminal.ts
```

默认会写入：

- metadata: `/var/lib/computerd/computers`
- unit files: `/etc/systemd/system`

可通过环境变量覆盖：

- `COMPUTERD_METADATA_DIR`
- `COMPUTERD_UNIT_DIR`

由于当前实现使用 system bus + system scope，这个示例通常需要足够权限才能成功创建、enable、start 和删除 unit。

## `browser-cli.ts`

browser computer 的示例 CLI：

- `browser-info <name>`
- `browser-connect <name>`
- `browser-screenshot <name> [--out <file>]`

运行方式：

```bash
pnpm exec vite-node examples/browser-cli.ts browser-info chrome1
pnpm exec vite-node examples/browser-cli.ts browser-connect chrome1
pnpm exec vite-node examples/browser-cli.ts browser-screenshot chrome1 --out ./chrome1.png
```

可通过下面两种方式指定 server 地址：

- `--base-url http://127.0.0.1:3000`
- `COMPUTERD_BASE_URL=http://127.0.0.1:3000`

## `playwright-connect.ts`

最小 Playwright attach 示例：

- 通过 `@computerd/sdk` 创建 browser automation session
- 直接 attach 到现有 Chromium CDP websocket
- 读取页面标题并保存一张 page screenshot

运行方式：

```bash
pnpm exec vite-node examples/playwright-connect.ts chrome1
```

前置条件：

- browser computer 已创建
- browser computer 已处于 `running`
- `apps/server` 已提供 HTTP API

## Host / Container Notes

### Broken state

computer 现在可能返回 `state = "broken"`：

- metadata 还在
- 但 backing runtime entity 已经丢失

当前 `broken` 只支持 inspect：

- 可以 list / get detail
- 不支持 start / stop / restart
- 不支持 delete
- 不支持打开 console / monitor / automation / screenshot / exec

### Container console vs exec

container computer 当前有两种交互面：

- `console`: 连接容器主进程的交互 stdin/stdout
- `exec`: 在运行中的容器里临时打开一个新的 `/bin/sh`

当前推荐：

- 对 agent，优先使用 console-capable computer，也就是让容器主进程本身可交互
- `exec` 当前更偏 operator-only / web-oriented surface，适合人类在前端临时排查

这不是对 container exec 的永久否定；如果后续出现明确价值，再把它提升为更稳定的自动化能力。

## VM Notes

`vm` computer 第一版基于 `QEMU/KVM`：

- monitor 走 QEMU VNC
- console 走 QEMU serial
- `qcow2` 路径支持最小 cloud-init
- `iso` 路径用于手工安装系统

运行前提：

- 宿主必须有 `/dev/kvm`
- 服务端需要配置默认 bridge，环境变量为 `COMPUTERD_VM_BRIDGE`
- 当前不支持 SPICE、virtio-gpu、audio、NAT 或 per-VM network override
