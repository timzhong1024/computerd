# Examples

## `bash-terminal.ts`

最简单的 systemd 封装用法示例：

- 通过 `createControlPlane()` 创建一个 control plane
- 创建一个 `terminal` 类型的 persistent `computer`
- 将 `ExecStart` 设为 `/usr/bin/bash -i -l`
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
