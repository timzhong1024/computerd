# Computer Profiles

## Summary

当前 computerd 管理三类 computer：

- `host`
- `browser`
- `container`

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

## Current Recommendation

当前对 agent 的推荐仍然是：

- 优先使用 console-capable computer
- 对 container，优先让主进程本身就是可交互的

当前 `exec` 更偏：

- operator-only
- web-oriented
- 临时排查/观察入口

这并不意味着未来永远不会支持 agent-facing exec；只是当前还没有把它定义成稳定的自动化 contract。
