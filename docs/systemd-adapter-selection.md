# Systemd Adapter Selection

## Goal

为 `computerd` 选择第一版 systemd adapter 路线，前提保持不变：

- 顶层 managed object 仍然是 `computer`
- 一个 `computer` 当前只绑定一个 primary unit
- `host-unit` 仍然只是只读 inspect surface
- 目标是替换当前 memory/fixture control plane，而不是做通用 systemd 管理台

## Required Capabilities

第一版真实 runtime 至少需要覆盖这些能力：

1. 为 `computer` 生成并落地 primary unit
2. 持久化 enable/disable 与 `autostart`
3. `start` / `stop` / `restart`
4. 读取 primary unit 的运行状态并映射到 `running` / `stopped`
5. 读取 unit 属性，反查 declarative config 是否生效
6. 读取最近日志与失败诊断

从当前领域模型反推，adapter 至少要能承载：

- unit identity: `unitName`
- lifecycle state: `ActiveState` / `SubState` / `LoadState`
- exec definition: `ExecStart`, working directory, environment
- resource control: CPU / memory / tasks
- enablement: `autostart`
- diagnostics: recent logs, failure result

## Candidates

当前可行的三条路线：

1. `systemctl` / `journalctl` CLI
2. 直接调用 systemd DBus (`org.freedesktop.systemd1`)
3. `systemd-run` + transient units

## Capability Matrix

| Capability | `systemctl` CLI | DBus manager API | `systemd-run` transient |
| --- | --- | --- | --- |
| 启停/restart | 强 | 强 | 强 |
| 读取 unit 属性 | 强，靠 `systemctl show` | 强，直接读 properties | 中，仍要回到 unit 属性读取 |
| enable/disable/autostart | 强 | 强 | 弱，不是主模型 |
| 持久 unit 定义管理 | 中，需要自己写 unit file | 中，需要自己写 unit file | 弱，天然偏临时单元 |
| 状态追踪 | 中，轮询 `show` / `is-active` | 强，可拿 job/unit 对象与 signal | 弱到中 |
| 错误结构化 | 弱，主要靠 exit code + stderr | 强，DBus 错误更结构化 | 中 |
| 日志读取 | 强，`journalctl` | 弱到中，通常还得配 journald API | 中 |
| Node 侧接入复杂度 | 低 | 中到高 | 低 |
| 可测试性 | 中，适合 fake CLI port | 中，需 mock bus 或抽更细 | 中 |
| 与持久 `computer` 语义匹配 | 强 | 强 | 弱 |

## Analysis

### 1. `systemd-run` 不适合当主路线

不推荐把 transient unit 当第一版主实现，原因很直接：

- 官方 DBus 文档里，`StartTransientUnit()` 创建的是 transient unit，会在不再运行、无引用或系统重启后释放
- 当前 `computer` 明确是持久对象，不是 disposable session
- `autostart`、声明式配置回读、持久 unit file 管理都不是 transient 模型强项

结论：`systemd-run` 可以保留为以后“临时 session computer”或调试工具，不适合当前主产品路径。

### 2. 纯 DBus 能力最完整，但不是第一阶段最省力

直接接 `org.freedesktop.systemd1` 的优势：

- `StartUnit()` / `StopUnit()` / `RestartUnit()` 完整
- `EnableUnitFiles()` / `DisableUnitFiles()` 完整
- `GetUnit()` / `LoadUnit()` / `SetUnitProperties()` / unit properties 读取都完整
- 错误和权限边界比 shell 更结构化

但第一阶段成本也更高：

- Node 侧要选 DBus client，并处理 system bus、类型签名、signal 订阅
- 日志能力通常仍要走 journald API 或 `journalctl`
- 仓库当前还没有任何 Linux-native binding 或 bus 抽象，直接上 DBus 会把 runtime 接入和基础设施选型绑死在一起

结论：DBus 更像第二阶段演进目标，而不是第一阶段最小替换路线。

### 3. `systemctl` + `journalctl` 更适合作为第一版 adapter

第一阶段推荐优先选这条路线：

- 启停、enable/disable、属性读取、日志读取都能覆盖当前所需能力
- `systemctl show` 明确就是给 computer-parsable output 用的
- unit file 写入仍然要由 `computerd` 自己负责，这一点无论 CLI 还是 DBus 都绕不开
- 实现复杂度最低，最容易先把 runtime port 从 fixture 替掉
- 后续仍可在不改 control-plane 语义的前提下，把 adapter 内部从 CLI 换成 DBus

限制也要提前承认：

- CLI 错误需要我们自己结构化
- 生命周期结果多半依赖“执行命令 + 轮询 show”
- shell-out 对测试和权限处理没有 DBus 干净

但这些限制在当前阶段可接受，因为我们先要证明的是 `computer -> persistent service unit` 这条主路径。

## Recommendation

推荐采用两阶段路线：

### Phase 1

用 `systemctl` + `journalctl` 实现第一版 adapter。

覆盖范围：

- unit file render + write
- daemon reload
- enable / disable
- start / stop / restart
- `systemctl show` 读状态与属性
- `journalctl -u <unit>` 读最近日志

### Phase 2

在 control-plane port 不变的前提下，视需要将 lifecycle/state 层切到 DBus。

触发条件：

- 需要更细粒度 job 跟踪
- 需要订阅状态变化而不是轮询
- 需要更稳定的结构化错误
- 需要减少 shell-out 依赖

## Minimal DBus Surface for Phase 1

如果后续做 DBus 原型，第一阶段最小面只包含这 4 个接口对象：

- `org.freedesktop.systemd1.Manager`
- `org.freedesktop.systemd1.Unit`
- `org.freedesktop.systemd1.Service`
- `org.freedesktop.DBus.Properties`

### Required Manager Methods

第一阶段最小可实现集合里，`Manager` 只需要这 7 个 methods：

- `LoadUnit`
- `StartUnit`
- `StopUnit`
- `RestartUnit`
- `Reload`
- `GetUnitFileState`
- `EnableUnitFiles` / `DisableUnitFiles`

### Required Property Reads

第一阶段属性读取方式只需要：

- `Properties.GetAll("org.freedesktop.systemd1.Unit")`
- `Properties.GetAll("org.freedesktop.systemd1.Service")`

`Properties.Get` 可以作为按需读取或性能优化，但不算首版必需。

### Stable Properties for v1

首版稳定依赖的关键属性建议限制为：

- `Unit`: `Id`, `Description`, `LoadState`, `ActiveState`, `SubState`, `UnitFileState`, `FragmentPath`, `StateChangeTimestamp`, `ActiveEnterTimestamp`
- `Service`: `ExecStart`, `WorkingDirectory`, `Environment`, `ExecMainPID`, `ExecMainStatus`, `Result`

如果首版同步做资源限制回读，可再纳入：

- `CPUWeight`
- `MemoryMax`
- `TasksMax`

### Functional Mapping

按当前 `computerd` 语义，DBus 面和功能的映射应保持很窄：

- `create/update`: unit file 写入不走 DBus；DBus 只负责 `Reload` 和 enable/disable
- `lifecycle`: 只用 `StartUnit` / `StopUnit` / `RestartUnit`
- `detail/inspect`: 用 `LoadUnit + GetAll(Unit/Service)`
- `host-unit inspect`: 复用同一套读取面，不新增额外接口

### Explicitly Deferred

第一阶段明确不纳入这批 DBus 面：

- `Subscribe` / `Unsubscribe`
- `JobNew` / `JobRemoved`
- `UnitNew` / `UnitRemoved`
- `ListUnits` / `ListUnitsByPatterns`
- `SetUnitProperties`
- `StartTransientUnit`
- `ResetFailedUnit`

同时要保持一个边界：`recentLogs` 不属于这组最小 DBus 面；首版日志能力仍应视作 `journalctl` 或单独 journald 接口问题，而不是 `org.freedesktop.systemd1` manager 主面的一部分。

## Proposed Port Shape

第一版不要抽象成万能 systemd manager，保持 `computer` 导向：

```ts
interface ComputerRuntimePort {
  createOrUpdateComputer(spec: ComputerRuntimeSpec): Promise<ComputerRuntimeRecord>;
  getComputer(unitName: string): Promise<ComputerRuntimeRecord>;
  listHostUnits(): Promise<HostUnitRecord[]>;
  getHostUnit(unitName: string): Promise<HostUnitRecord>;
  startComputer(unitName: string): Promise<ComputerRuntimeRecord>;
  stopComputer(unitName: string): Promise<ComputerRuntimeRecord>;
  restartComputer(unitName: string): Promise<ComputerRuntimeRecord>;
  readRecentLogs(unitName: string, limit: number): Promise<string[]>;
}
```

其中：

- `ComputerRuntimeSpec` 是从 `CreateComputerInput` 映射出的 runtime spec
- `ComputerRuntimeRecord` 是 runtime/metadata 的窄输出，不直接泄漏 CLI 或 DBus 细节
- `HostUnitRecord` 继续只承担 inspect surface

## Implementation Notes

第一阶段建议继续拆成两个 adapter，而不是一个大而全对象：

1. `UnitFileStore`
负责 render/write/remove unit file，与 `daemon-reload`

2. `SystemdManager`
负责 `systemctl` 生命周期与属性读取

3. `JournalReader`
负责最近日志读取

这样第二阶段如果切 DBus，只需要替换 `SystemdManager`，不用重写 unit file 与日志侧。
上面的最小 DBus 面清单只用于第二阶段实现或并行原型验证，不改变第一阶段仍优先采用 CLI adapter 的推荐结论。

## Open Decisions

开始实现前还需要明确 4 个点：

1. unit file 写入目录是 system scope 还是 user scope
2. `browser` profile 的 primary unit 是否直接承载 Xvfb/wayland helper，还是只承载 launcher
3. `storage.rootMode=ephemeral` 由 unit 字段表达，还是先降级为未实现
4. `network.mode=isolated` 是第一阶段显式不支持，还是通过额外 helper 实现

建议先把 3 和 4 标为 `not yet supported`，避免为了少数未定能力把 adapter 选型做宽。

## Sources

- [systemctl(1)](https://www.freedesktop.org/software/systemd/man/254/systemctl.html)
- [org.freedesktop.systemd1(5)](https://manpages.debian.org/testing/systemd/org.freedesktop.systemd1.5.en.html)
- [systemd-run(1)](https://www.freedesktop.org/software/systemd/man/systemd-run.html)
- [journalctl(1)](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html)
