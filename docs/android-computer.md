# Android Computer

## Status

本文定义一个拟新增的 `android computer` profile。

除非明确说明，下面描述的是目标产品形态与 runtime 定义，不表示当前仓库已经实现。

正式原则：

- `android computer is a device-semantic profile with a VM-backed default runtime.`

设计背景、方案取舍和完整讨论记录见：

- [docs/android-computer-rationale.md](/Users/timzhong/computerd/docs/android-computer-rationale.md)

## User Mental Model

用户管理的不是一台可自由折腾参数的 VM，而是一台由 computerd 预制并托管的 Android 手机。

用户应当这样理解它：

- 这是一台“手机”，不是“安装中的虚拟机”
- 创建时选定一个基础镜像，这等于创建一台基于某个系统底座的手机
- 基础镜像一旦选定就不再变更；想换系统底座，必须重新创建一台新手机
- `start` / `stop` / `restart` 的语义就是开机、关机、重启，不带任何重置含义
- 这台手机默认有状态，数据会保留
- 如果要回到干净状态，走 `restore`
- `restore(initial)` 就是恢复出厂设置
- `restore(<snapshot>)` 就是回到之前保存的业务状态

用户不需要理解：

- `iso`
- `cloud-init`
- `nic[]`
- GPU / boot matrix
- 底层 QEMU 参数

## Object Model

android computer 仍然是统一 `computer` 模型的一种 profile：

- `profile = "android"`

没有新增新的顶层 `device` / `phone` / `emulator` object kind。

`android` 与 `vm` 的关系是：

- `vm` 表示“通用虚拟机”
- `android` 表示“以 Android 设备语义暴露的预制虚拟机”

android computer 的 runtime 输入应该表达的是设备语义，而不是 QEMU 语义。推荐保留这类稳定字段：

- `runtime.engine`
  例如受控的 Android emulator runtime 标识
- `runtime.image`
  例如预制镜像渠道、flavor、版本
- `runtime.display`
  设备分辨率、密度、方向等 device-level 配置

create-time immutable 约束：

- 一台 android computer 只绑定一个 base image
- `runtime.image` 只能在 create 时设置
- create 之后不提供“切换基础镜像”的 update path
- 如果需要改用另一套 base image，必须重新创建这台手机

android computer 不应该把下面这些字段作为稳定用户输入暴露：

- 原始 `iso` 安装入口
- 自定义 `qcow2` 基础镜像路径
- 任意 `qemu` 参数
- 任意 `nic[]` 配置
- `cloud-init`
- 面向 guest 安装流程的 serial boot 交互

## Runtime Layout

android runtime 的定位是：

- 由 systemd primary unit 管理
- 底层启动一个高度预制的 Android VM
- 同时拉起若干 Android sidecar 能力

推荐的 runtime 组成是：

- Android VM runtime
- monitor stream / input bridge
- `adb` bridge
- Appium server sidecar

从技术选型上，android computer 的默认 runtime 仍然是 VM-backed，但恢复与快照能力不应重新发明一套专有格式，而应建立在现有虚拟磁盘 snapshot 能力之上。

目录约定可以延续现有 computer 目录布局：

- state root: `/var/lib/computerd/computers/<slug>`
- runtime root: `/run/computerd/computers/<slug>`
- Android userdata / snapshot / runtime cache 均落在 computerd 管理目录下

默认语义应当是持久化 device data。

因此 `stop/start` 的语义建议是：

- `stop` 只停止当前 Android runtime
- `start` 只重新启动已有 Android runtime
- `stop/start` 不隐含 destructive reset 或 restore 行为

如果用户需要“恢复出厂设置”或“回到预制干净状态”，应该通过显式恢复面完成，而不是复用生命周期动作。

更推荐的做法是只保留一个 destructive verb：

- `restore`

其中：

- `restore(initial)` 表示恢复出厂设置，回到 base image 定义的初始干净态
- `restore(<snapshot>)` 表示回滚到某个用户已保存的检查点

这比同时引入 `recreate`、`factory reset`、`restore snapshot` 等多个近义恢复动作更清晰，也更符合 Android device 的产品语义。

broken state 语义与其他 computer 保持一致：

- metadata 仍存在
- backing runtime entity 丢失
- 仅支持 inspect，不支持 attach/session surface

## Storage And Snapshot Model

android computer 的存储模型建议拆成两层：

- curated、只读、由 computerd 管理的 base image
- 每台 computer 独立的 writable userdata layer

这意味着：

- image version / system partition 由 computerd 作为受控 artifact 管理
- 用户真正会改变的数据主要落在 userdata layer
- `restore` 的主要对象也是 userdata layer，而不是让用户直接操作底层 VM 安装介质
- base image 一旦选定，就与这台 computer 绑定；要切换 base image，必须重新创建 computer

### Recovery Surface

android computer 应提供一组快照管理能力，以及一个统一的恢复动作：

- `create snapshot`
- `restore`
- `delete snapshot`

它们的语义建议是：

- `create snapshot`
  为当前 writable userdata layer 创建一个命名检查点
- `restore`
  把 writable userdata layer 回滚到某个恢复目标
- `delete snapshot`
  删除不再需要的检查点

`restore` 的目标可以是：

- 系统内建的 `initial` 恢复点
- 用户创建的命名 snapshot

其中：

- `initial` 是系统保留、不可删除的恢复点
- `restore(initial)` 就是 Android 语义下的“恢复出厂设置”

这里的正式约束应当是：

- `stop/start` 不隐含任何 snapshot / restore 语义
- snapshot/recovery 是独立 capability，不混入普通 lifecycle

### Snapshot Scope

第一版建议把 snapshot 定义为：

- offline storage snapshot

而不是：

- live VM snapshot
- RAM / CPU / device state snapshot
- “恢复到屏幕停留的那一刻”的 suspend/resume 语义

这样定义的好处是：

- 更贴近 Android “恢复出厂设置 / 回到干净业务态”的真实需求
- 更容易同时兼容 `qcow2` 与 `lvm` 两类 block-level snapshot substrate
- 避免把 QEMU live snapshot、USB/device state、GPU state 一并拉入第一版稳定 contract

因此第一版建议要求：

- 创建 snapshot 前 computer 处于 `stopped`
- restore 前 computer 处于 `stopped`

live snapshot 可以保留为未来增强方向，但不进入第一版正式 contract。

### Backend Selection

恢复与 snapshot 的技术选型建议锁定为：

- default backend: `qcow2`
- optional future backend: `lvm-thin`

不建议第一版自研专有 snapshot 格式或自定义块复制层。

### Why `qcow2` First

`qcow2` 应作为第一版默认 backend，原因是：

- 与当前 computerd `vm` 路线一致，仓库内已经存在 `qcow2` 基础镜像与 overlay 路径
- QEMU 原生支持 `qcow2` 以及多种 snapshot 能力
- 不要求宿主预先配置 volume group / thin pool
- 更容易作为受控 artifact 落在 computerd 管理目录下
- 更适合先做可移植、默认可用的 Android vertical slice

在实现形态上，第一版更推荐：

- curated read-only base image
- per-computer writable `qcow2` userdata disk
- snapshot 通过 `qcow2` 的 image-level checkpoint 能力完成

### Why `lvm-thin` Is Not The Default

`lvm-thin` 仍然是很有价值的后续 backend，尤其适合：

- 宿主已经有成熟的 LVM thin pool 运维体系
- 需要更快的 clone / rollback
- 希望把大量 Android computers 的 writable layer 放进统一 block storage 管理

但它不适合作为第一版默认前提，原因是：

- 对宿主环境要求更高
- 需要额外的 VG / thin pool provisioning 与运维约束
- 可移植性差于目录内可管理的 `qcow2`
- 会把过多 host storage policy 暴露进第一版产品边界

因此更合理的策略是：

- 先把 snapshot product contract 定死
- 先用 `qcow2` 落地默认实现
- 后续再把 `lvm-thin` 作为可插拔 storage backend 接入

### User-Facing Simplicity

无论底层最终使用 `qcow2` 还是 `lvm-thin`，都不建议把 storage backend 作为第一版 create-time 用户选择项暴露。

更合适的产品边界是：

- create input 只表达 Android device 语义
- storage backend 由 runtime / deployment policy 决定
- inspect detail 可以在需要时展示 effective backend

这同样是为了控制心智成本：

- 用户需要的是“恢复到干净状态”
- 而不是“学习哪种块存储 snapshot 格式更适合这台手机”

## Supported Capabilities

### Lifecycle

- create
- start
- stop
- restart
- inspect detail / state

### Recovery

- create snapshot
- restore
- delete snapshot

第一版这些能力建议都要求 computer 处于 `stopped`。

### Interactive Monitor

android computer 的主交互面是 monitor，而不是 console。

monitor 的产品语义是：

- 显示实时设备画面
- 支持 touch / swipe / keyboard input
- 支持 `home` / `back` / `app switch` 等设备按键

对外稳定 contract 应该是 `monitor session`，而不是承诺底层永远使用某一种图传协议。

第一版不要求支持：

- 音频
- 录屏
- 多点触控

### Console

android computer 的 console 语义不是 QEMU serial console，而是：

- `adb shell`

它的定位是：

- operator / agent 的系统兜底面
- 当高层自动化轮子不够用时的 escape hatch

这条 console 面应该沿用现有 websocket terminal surface，但背后连接的是 `adb shell`，不是 guest serial socket。

### Core Interfaces

android computer 的 agent-facing 接口建议拆成三层：

- display interface
- console interface
- specialized Android interface

其中：

- display interface 负责“看见屏幕并对屏幕执行通用输入”
- console interface 负责“进入设备命令面”
- specialized Android interface 负责“用 Android 特化协议高效完成设备级动作”

display interface 的推荐组成是：

- monitor
- screenshot
- input injection
- optional visual grounding sidecar

在这一层，OmniParser、UGround 这类模块的角色不是替代设备控制协议，而是增强 agent 对屏幕的理解能力。

更准确地说：

- OmniParser / UGround 更适合作为 `display perception` 接口
- 它们负责 screen parsing / visual grounding
- 它们不负责 app lifecycle、session management、device shell、稳定动作执行

console interface 的第一版稳定语义是：

- `adb shell`

specialized Android interface 的第一版推荐语义是：

- Appium session
- `adb` device operations

因此，对 android computer 来说：

- OmniParser / UGround 比 Appium 更适合作为“agent 如何操作显示器”的接口
- 但它们不比 Appium 更适合作为“agent 如何操作 Android 设备”的接口

这层分工与 browser computer 的思路一致：

- 通用 display 面解决“看见屏幕”
- 特化协议面解决“高效完成某一类对象操作”

对 browser 来说，特化协议是 `CDP`。

对 Android 来说，特化协议是：

- Appium
- `adb`

显示器相关的独立设计见：

- [docs/display-interface-model.md](/Users/timzhong/computerd/docs/display-interface-model.md)

### Automation

android 没有像浏览器 `CDP` 那样天然统一且占优的单一 attach protocol。

因此 android computer 的 automation 设计不应该强行押注单一协议，而应该采用“稳定 core + 受控 sidecar”模型：

- `adb` 是必须存在的系统级 escape hatch
- Appium 是第一版推荐的一等自动化 attach 面
- Maestro 不是第一版稳定 core contract

这意味着：

- computerd 负责 lifecycle、auth、session create、runtime health
- computerd 不在第一版内部重写一整套高层 mobile DSL
- agent / SDK 侧优先直接 attach Appium
- 当 Appium 无法覆盖时，允许回退到 `adb`

## Automation Wheel Landscape

这里有意只列“正交的自动化技术形态”，不枚举建立在这些 substrate 之上的语言 binding、wrapper、runner 变体或生态派生项目。

### `adb`

`adb` 是 Android 官方提供的设备通信与调试入口。

它负责：

- `shell`
- app install
- file push / pull
- port forwarding
- device reset / test harness

在 android computer 里，`adb` 的定位是：

- 必须存在的系统 escape hatch
- lifecycle 之外最底层、最通用的设备控制面
- 当其他自动化轮子失效时的兜底路径

它不适合作为完整高层 UI automation contract，但必须作为稳定基础设施存在。

### Appium

Appium 的特点是：

- 基于 W3C WebDriver 的 client-server architecture
- 适合被远程 attach
- 适合暴露为长期存在的 automation session

在 android computer 里，Appium 的定位是：

- 第一版推荐的一等自动化 attach 面
- 面向 agent / SDK / 外部程序化调用的 primary automation engine

它的优势在于 session model 与 computerd 当前 architecture 更接近。

### Maestro

Maestro 的特点是：

- black-box flow runner
- 通过 Android Accessibility layer 与已渲染 UI 交互
- 更偏 operator / test author 体验

在 android computer 里，Maestro 的定位更适合是：

- 可选的上层 flow runner
- smoke / regression / operator-authored flows
- 不是第一版稳定 core attach contract

它更像“编排与作者工具”，而不是 computerd 应该直接依赖的基础设备协议。

### UI Automator

UI Automator 是 Android 官方提供的 UI automation framework。

官方文档当前已经提供 modern UI Automator API，适合：

- 跨 app UI 自动化
- 基于可见 UI / accessibility tree 的元素查找
- screenshot 与多窗口等设备级 UI 交互

在 android computer 里，UI Automator 的定位更适合是：

- 平台原生能力参考面
- Appium 之外的一类底层 Android UI automation substrate

但它本身更偏 Android test/instrumentation integration model，而不是 computerd 想直接暴露给外部 agent 的长期远程 session contract。

### Espresso

Espresso 是 Android 官方提供的 app-oriented UI test framework。

它的特点是：

- 更偏开发者视角
- 与 app codebase / instrumentation test model 更紧
- 同步与 idling 机制很强

在 android computer 里，Espresso 的定位不应是默认自动化 contract，而更适合被视为：

- 面向 app 开发团队的 white-box / code-aware test wheel
- 某些深度应用内测试场景的可选集成方向

它不适合作为 managed Android device 的通用黑盒自动化入口。

### Capture And Artifacts

第一版建议稳定支持：

- fullscreen screenshot

更适合后续迭代的能力：

- logcat stream
- screen recording
- file push/pull
- richer artifact surfaces

## Visual Grounding Notes

OmniParser 与 UGround 对 android computer 的启发，不是替代 Appium，而是补上一层 `display perception`。

更合理的组合是：

- Appium / `adb` 负责设备控制与执行
- OmniParser / UGround 负责 screen parsing / visual grounding

当 Android UI tree 不可靠时：

- agent 先通过 screenshot + visual grounding 找到目标区域
- 再通过 Appium / `adb` 执行动作

这比把视觉模块直接当作设备控制协议更清晰，也更符合 computerd 的分层。

## Tooling Model

android computer 的底层选型原则是：

- 尽量复用业界成熟轮子
- computerd 只做 control plane 与统一产品化封装

推荐分层如下：

- monitor / human interaction: Android monitor session
- system escape hatch: `adb`
- primary automation engine: Appium
- optional future operator/test runner: Maestro
- platform-native reference substrate: UI Automator
- app-oriented deep integration option: Espresso

Maestro 的定位应明确为：

- 可选的上层 flow runner
- operator / smoke oriented tooling
- 不是第一版稳定自动化 core contract

这也意味着本文有意不把下面这些作为独立一等轮子展开：

- Appium 各语言 client
- WebdriverIO / Selenium bindings
- Appium driver 的上层封装
- 建立在同一 device protocol 之上的细分 runner

## WebUI

android detail 页应提供一个类似 browser popup stage 的入口，例如：

- `Open device`

点击后打开独立 monitor window：

- popup 只展示远程 Android 画面
- 人类通过该窗口完成 touch / keyboard / device key 交互

detail 页本身更适合展示：

- 设备镜像信息
- runtime engine
- 当前可恢复的 snapshot / restore 信息
- monitor / automation session 入口
- 当前连接状态与 runtime 健康状态

## API Surfaces

android computer 的最小 API 面建议是：

- `POST /api/computers/:name/start`
- `POST /api/computers/:name/stop`
- `POST /api/computers/:name/restart`
- `GET /api/computers/:name/snapshots`
- `POST /api/computers/:name/snapshots`
- `POST /api/computers/:name/restore`
- `DELETE /api/computers/:name/snapshots/:snapshotName`
- `POST /api/computers/:name/monitor-sessions`
- `POST /api/computers/:name/console-sessions`
- `POST /api/computers/:name/screenshots`
- `POST /api/computers/:name/appium-sessions`
- `POST /api/computers/:name/adb-sessions`

monitor / console / automation 的 session 返回值应继续遵守 computerd 现有的“创建 session，再返回 attach/connect 信息”的模式。

## Agent Recommendation

第一版对 agent 的推荐应该是：

- 优先使用 Appium attach
- 把 `adb` 作为系统兜底面
- 把 monitor / screenshot 作为多模态补充观察面

不建议第一版就把 computerd 定义成“通用移动 DSL 翻译器”。

更合理的边界是：

- computerd 负责设备生命周期与 attach surface
- 高阶 mobile actions 先交给 Appium 及其生态

这和 browser computer 当前“直接暴露 CDP attach，而不是重写 Playwright”保持一致。

## Current Defaults

android computer 的第一版默认形态建议是：

- substrate: 预制 Android VM
- image source: curated / prebuilt
- data persistence: `true`
- primary automation engine: Appium
- system fallback: `adb`
- audio: disabled
- network and GPU path: managed by runtime, not user-tunable

## Non-Goals

下面这些不应该成为第一版目标：

- 通用 Android 安装平台
- 暴露原始 QEMU 参数
- 用户自定义 `iso` / `cloud-init` / `nic[]`
- 多种 GPU / NIC / boot matrix 供用户自由组合
- 音频
- GPS / camera / sensors
- 多点触控
- iOS 同构设计
- 把 Maestro 纳入第一版稳定 core contract

## Relationship To Existing Profiles

`host` 的主交互面是 shell / console。

`browser` 的主交互面是 monitor + browser automation attach。

`vm` 的主交互面是通用虚拟机 monitor + serial console。

`android` 的主交互面应当是：

- Android device monitor
- `adb shell`
- Appium automation attach

因此 android profile 的本质不是“另一个带图形界面的 VM”，而是“一个以移动设备语义暴露的 managed computer”。
