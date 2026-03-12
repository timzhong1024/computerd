# Android Computer Rationale

## Status

本文记录 `android computer` 的讨论过程、取舍依据和最终收敛出的设计方向。

它不是正式规格文档。

正式定义见：

- [docs/android-computer.md](/Users/timzhong/computerd/docs/android-computer.md)

## Starting Point

最初的问题不是“怎么接一个 Android 自动化库”，而是：

- computerd 已经有 `host`、`container`、`vm`、`browser`
- 是否值得再做一个 `android computer`
- 它到底是独立 profile，还是现有 `vm` 的一个特化 preset

这里最早的产品动机很直接：

- 有些 app 只有移动端
- 现有四类 computer 不能自然承载这类 workflow
- 如果让 agent 真正处理移动端业务，Android 设备环境需要成为一等 managed object

## Early Confusion

一开始最容易滑向两个方向：

- 把 Android 当成“再加一种 automation tool”
- 把 Android 当成“现有 VM 套一层 preset”

这两条路都有问题。

如果把 Android 只理解成自动化工具问题，会忽略：

- 长期存在的设备状态
- monitor
- 生命周期
- 人类与 agent 共用一台设备
- 恢复与快照

如果把 Android 直接做成现有 `vm profile` 的一种配置模板，又会暴露太多通用虚拟机自由度。

## Why It Is Not Just VM

后来逐步明确的一点是：

- Android 的底层 substrate 可以是 VM
- 但 Android 的产品语义不能继续等同于通用 VM

不是因为 VM 不够强，而是因为 VM 暴露的自由度和 Android 设备的用户心智并不一致。

### The Wrong Knobs Problem

如果直接沿用现有 `vm profile`，用户会被迫面对这类输入：

- `iso` / 安装介质
- 通用 guest 安装流程
- `nic[]`
- `cloud-init`
- serial boot / install 调试入口
- GPU / boot 参数矩阵

这些选项在通用 VM 场景里是能力。

但在 Android 设备场景里，它们更像噪音，因为它们会带来：

- 更大的错误配置空间
- “能启动但极卡”或“根本跑不起来”的失败模式
- 错误的产品心智

Android 用户真正关心的是：

- 能不能顺利启动
- 图形是否流畅
- 能不能 monitor
- `adb` 是否可用
- Appium 是否可用
- 数据是否保留
- 能不能恢复到干净状态

也就是说，Android profile 的一个核心目标不是暴露更多自由度，而是刻意删除不属于 Android 设备语义的自由度。

## Final Principle

最终收敛出的正式原则是：

- `android computer is a device-semantic profile with a VM-backed default runtime.`

这句话包含两层意思：

- `device-semantic profile`
  对用户来说，这是手机，不是通用虚拟机
- `VM-backed default runtime`
  第一版底层实现仍然走 VM，是现实且合理的技术路线

## User Mental Model

用户管理的不是一台可自由调参的 VM，而是一台由 computerd 预制并托管的 Android 手机。

这套心智后面成为设计判断的基准：

- 创建时选基础镜像
- 基础镜像之后不再变更
- `start` / `stop` / `restart` 只是开关机
- 数据默认持久化
- 人类主入口是 monitor
- agent 主入口是 Appium，`adb` 作为兜底
- 回到干净状态靠 `restore`，不是靠重启或改底层配置

如果某个设计会让用户重新学回“虚拟机安装与调优”的心智，那大概率就是错误方向。

## Why Base Image Is Immutable

后面另一个关键收敛点是：

- 一台手机只能绑定一个 base image
- base image 只能在 create 时设置
- 想换 base image，必须重新创建手机

原因不是实现偷懒，而是产品语义需要这样稳定：

- base image 是这台设备身份的一部分
- 切换 base image 本质上已经不是“修改设置”，而是“换一台系统底座不同的手机”，就像从 Samsung 换成 Google Pixel 一样。

如果把 base image 也做成可变参数，用户又会被拖回“我在持续调一台 VM 的系统盘来源”这种错误心智。

## Why State Is Persistent By Default

这里也经历过一次收敛。

一开始曾经出现过一种模糊表述：

- 试图把“是否回到初始态”塞进生命周期语义里

后来很快发现这会把生命周期和破坏性恢复动作混在一起。

最终更清晰的结论是：

- 默认语义就是持久化
- `stop` / `start` / `restart` 不隐含 reset
- 回到干净状态必须走显式恢复面

这更接近真实手机心智，也更容易让控制面保持可预测。

## Recovery Model Discussion

恢复模型其实也经历过几轮摇摆。

### Stage 1: `recreate`

最早我们考虑过增加：

- `recreate`

它的直觉含义是：

- 丢弃当前 writable state
- 基于同一 base image 重新造一台干净手机

问题是这个名字很容易和 `restart` 混淆。

### Stage 2: `factory reset` + snapshot

后来又讨论过：

- 保留 `restore snapshot`
- 另外单独提供 `factory reset`

这在用户语义上已经比 `recreate` 清楚，但控制面里仍然有两个 destructive verb。

### Stage 3: single `restore`

最后收敛出的结果是：

- 只保留一个 destructive verb：`restore`

具体来说：

- `restore(initial)` = 恢复出厂设置
- `restore(<snapshot>)` = 回滚到某个用户保存状态

这样用户只需要学一个动作：

- 所有回滚都是 `restore`

区别只是目标不同。

这是目前最干净的恢复模型。

## Snapshot Scope

恢复模型收敛后，接着需要锁定 snapshot 的范围。

这里也很容易一开始想得太大，比如：

- live VM snapshot
- RAM / CPU / GPU / device state 一起保存
- 恢复到“某个屏幕瞬间”

但这会让第一版快速失控。

最终收敛是：

- 第一版只做 `offline storage snapshot`

也就是：

- 快照对象是 writable userdata layer
- 不承诺保存运行时 RAM / CPU / device state
- create / restore 都要求 computer 先处于 `stopped`

这样做的好处是：

- 足够覆盖“恢复出厂设置 / 回到干净业务态”的核心需求
- 不把 QEMU live snapshot 的复杂度带进第一版稳定 contract
- 更容易兼容不同的底层块存储实现

## Storage Backend Decision

当恢复面收敛后，技术选型就可以明确落到 block storage backend 上。

最终的方向是：

- default backend: `qcow2`
- optional future backend: `lvm-thin`

### Why `qcow2`

之所以先锁 `qcow2`，主要因为：

- 仓库现有 VM 路线已经在用 `qcow2`
- QEMU 原生支持好
- 不要求宿主预先配好 VG / thin pool
- 更容易先做出默认可用的 vertical slice
- 更适合把所有状态都放进 computerd 管理目录

### Why Not `lvm-thin` First

`lvm-thin` 不是坏选择，相反它很有价值，但不适合作为第一版默认前提，因为它会引入：

- 更强的宿主环境要求
- 更重的存储运维前置条件
- 更低的可移植性

所以更合理的策略是：

- 先定住 product contract
- 先用 `qcow2` 落默认实现
- 以后需要时再引入 `lvm-thin`

## Automation Tool Landscape

自动化轮子也经历过从“选一个”到“分层看待”的过程。

一开始最显眼的是：

- Appium
- Maestro

但后来逐步明确，不能只在这两个名字之间二选一。

应该按正交技术形态来分层：

- `adb`
- Appium
- Maestro
- UI Automator
- Espresso

### Final Positioning

最后收敛出的定位是：

- `adb`
  必须存在的系统 escape hatch
- Appium
  第一版一等自动化 attach 面
- Maestro
  可选上层 flow runner，不是第一版 core contract
- UI Automator
  平台原生 UI automation 参考面
- Espresso
  面向 app 团队的深度白盒测试选项

这个结论背后的核心判断是：

- computerd 不应该重写一套移动自动化生态
- computerd 应该负责 lifecycle、session、monitor、统一对象模型
- 低层自动化能力应尽量复用成熟轮子

## Relationship To Browser Computer

整个 Android 方向真正成型，是因为后来找到了一条和 `browser computer` 很像的类比路径。

`browser computer` 的本质是：

- 顶层是独立 profile
- 底层是预制好的 runtime bundle
- 用户不需要理解 Xvfb / x11vnc / pipewire 等实现细节
- 对外暴露 monitor 和 automation attach

Android 很适合沿着同样的路径发展：

- 顶层独立 profile
- 底层使用预制 VM runtime
- 用户不理解 QEMU / NIC / cloud-init / GPU 矩阵
- 对外暴露 monitor、`adb shell`、Appium attach

也就是说，Android 不是“图形版 VM”，而是“设备语义下的 managed computer”。

## Final Shape

经过这些讨论之后，方向基本稳定为：

- 独立 `android` profile
- VM-backed default runtime
- create-time immutable base image
- persistent data by default
- single destructive verb: `restore`
- `restore(initial)` 表示恢复出厂设置
- offline storage snapshot in v1
- default storage backend: `qcow2`
- optional future backend: `lvm-thin`
- primary automation engine: Appium
- `adb` as escape hatch

如果后续还要扩展，这份文档的价值就在于：

- 先记住为什么没有走其他看似也能工作的路
- 避免未来又把 Android 退化回“VM preset + 一堆 knobs”
