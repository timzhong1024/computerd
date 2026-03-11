# Examples

## `bash-terminal.ts`

最简单的 systemd 封装用法示例：

- 通过 `createControlPlane()` 创建一个 control plane
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
