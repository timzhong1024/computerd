<!-- DOC-TODO-START -->

## 当前 TODO

- [ ] P1: 把 `profile / provider` 二层模型提升为正式对外语义，并据此收敛 capability 规则与 runtime adapter 边界。
- [ ] P2: 定义 `trajectory / artifact` 正式对象与最小持久化路径，优先覆盖 `display-actions`、`screenshot` 与 `console` 相关执行记录。
- [ ] P3: 明确 `gateway / network abstraction`、`trajectory` 和 `WebUI` 在对外产品叙事中的优先级，并把它们与 `control plane` 内核定位分开表达。
<!-- DOC-TODO-END -->

# Computerd Product Positioning

## Headline

`computerd` 提供一套可自托管、可追踪、带网络边界的 computer-use runtime，用来在单机上托管 browser、vm、container 和 host computers。

这句话是对外 headline，强调的是用户真正能感知到的价值：

- self-hosted computer environment
- networked runtime boundary
- trajectory / artifact foundation
- human-friendly takeover surface

它不直接强调 `control plane`，因为 `control plane` 更适合作为产品内核定义，而不是唯一卖点。

## One-Line Positioning

`computerd` 是一个面向 agent-accessible runtimes 的 single-machine computer control plane。

更具体地说：

- 它统一管理一台宿主机上的 `host`、`browser`、`container`、`vm` computer
- 它为这些 computer 暴露一致的 lifecycle、attach、display、console 和 future trace surface
- 它首先服务 agent builder、research/eval builder 和 advanced operator，而不是终端个人 agent 用户

## Product Narrative Layers

`computerd` 的产品叙事应明确分成两层：

- 外层卖点
  - networked computer runtime
  - execution trajectory / artifacts
  - self-hosted human-friendly environment
- 内层本体
  - single-machine computer control plane

这里的关键点是：

- `control plane` 解释系统为什么能统一管理不同 runtime substrate
- `gateway`、`trajectory`、`WebUI` 解释用户为什么愿意用它

因此，`control plane` 是架构中心，但不应被误写成唯一 headline。

## Product Definition

`computerd` 的核心产品定义不是：

- 个人 assistant app
- 多节点 cluster scheduler
- 企业级多租户平台治理系统

`computerd` 的核心产品定义是：

- 把一台机器上的多种 runtime substrate 抽象成统一的 computer object model
- 让上层 agent / tool / operator 通过稳定 contract 使用这些 computer
- 为 computer-use 系统提供可控制、可观察、可追踪、可带网络边界运行的执行底座

这一定义需要和对外卖点区分开：

- 内核定义关注 object model、lifecycle、capability、runtime boundary
- 对外卖点关注部署体验、可追踪性、网络边界和 human takeover

## Scope Boundary

`computerd` 当前应明确采用 `single-machine first` 边界。

这意味着：

- 当前控制面中心是单宿主机上的本地资源
  - Docker/container runtime
  - QEMU/KVM
  - host network / bridge
  - image store
  - VNC / CDP / console attach
- 当前不把自己定义为：
  - 多节点调度器
  - fleet orchestrator
  - distributed control plane

未来可以扩展到 fleet / cluster，但更合理的演进方式应是：

- `computerd`
  作为 node-local computer control plane
- future manager / orchestrator
  作为上层多机编排层

而不是在当前产品里同时承担两层职责。

## Non-Goals

当前阶段明确的非目标：

- 复杂 cluster scheduling
- 跨节点 state replication / HA control plane
- 复杂企业级 RBAC / policy inheritance / org hierarchy
- 面向普通终端用户的聊天式 personal agent 产品
- 将 benchmark / training workflow 直接塞进 runtime core

这不表示这些方向永远不做，而是：

- 现在做会稀释核心价值
- 当前用户痛点还没有落在这些问题上

## Target Customers

### Agent Infrastructure Builder

这类用户在搭建 computer-use agent 系统，本质需求是稳定的 runtime substrate 和 control surface。

他们通常需要：

- browser / vm / container / host 的统一 object model
- lifecycle 与 attach surface
- display / screenshot / console / automation contract
- 后续的 artifact / trajectory / replay 基础

这是当前最重要的第一用户。

### Research / Eval Builder

这类用户关心 benchmark、trajectory collection、模型效果验证、环境复现。

他们通常需要：

- 可重复启动的 computer 环境
- 一致的执行 surface
- artifacts / traces / failure cases
- browser / vm 统一的 substrate 抽象

这类用户不一定是最终商业化客户，但非常适合作为早期采用者和设计压力源。

### Advanced Operator

这类用户通常管理一台高配 Linux 主机，希望把 browser / vm / host / container 统一暴露给人类或 agent 使用。

他们通常需要：

- 单机上的统一 runtime control plane
- 稳定 attach / monitor / screenshot / console 能力
- 尽量少写 glue code 和 shell scripts

## Core Pain Points

### Runtime Fragmentation

当前 computer-use 系统的最大问题不是“没有 agent”，而是底层 runtime 分裂：

- browser、vm、container、host 各用不同 substrate
- lifecycle、attach、display、automation 语义很难统一
- storage / network / image / permissions 语义不一致

`computerd` 最核心的价值就是把这些 runtime 差异收敛到统一 control plane。

### Missing Network Boundary

对于真实可用的 computer-use 系统，仅有进程生命周期还不够，还需要正式的网络边界：

- 这台 computer 连到哪个网络
- 它和宿主、外网、其他 computer 的关系是什么
- browser / vm / container 是否具备一致的 network semantics

如果没有正式的 gateway / network abstraction，computer 很容易退化成一堆零散进程，而不是可托管、可复现的 runtime。

### Low Debuggability

computer-use 系统经常失败在：

- 当前屏幕内容
- 焦点状态
- 输入是否真的送达
- 页面或 guest 是否晚加载
- console / serial 输出

没有正式的 trajectory / artifact 时，这些失败几乎不可诊断、不可比较、不可回放。

这也是为什么 `trajectory` 应该被视为用户可感知的主卖点之一，而不是附属日志能力。

### Weak Reproducibility

无论是 builder 还是 researcher，都会很快撞上：

- 环境难复现
- 失败 case 难保存
- browser / vm 行为难比较
- 一次 run 发生了什么无法完整回看

这要求 control plane 不只是能 CRUD computer，还要能记录 execution artifacts。

### Unsafe Exposure

当前真正更紧迫的安全问题不是复杂 RBAC，而是：

- attach surface 如何最小授权
- screenshot / monitor / automation / console 如何做 lease / token
- 谁对哪台 computer 做了什么操作

这意味着 auth / coarse-grained authz / audit 比复杂组织权限更优先。

### Weak Human Takeover

即使系统主要服务 agent builder，真实使用里也仍然需要：

- 人类快速查看当前 screen / console 状态
- 在失败时直接接管 browser / vm
- 用 UI 而不是 shell scripts 完成常见操作

这意味着 human-friendly WebUI 不是“锦上添花”，而是部署在个人小主机上的重要 adoption wedge。

## Why Not Complex RBAC First

如果 `computerd` 当前是 single-machine-first control plane，那么最先要解决的不是复杂 RBAC，而是：

- identity/authentication
- coarse-grained authorization
- session-scoped tokens
- audit trail

复杂 RBAC 更适合：

- 多团队共享平台
- 多租户治理
- 组织层级与项目继承
- policy-heavy enterprise deployment

这些不属于当前主问题域。

当前阶段更合适的安全模型是：

- `read`
- `operate`
- `attach`
- `admin`

必要时再加 profile-scoped 权限，而不是直接引入高复杂度角色继承系统。

## Product Thesis

`computerd` 的产品 thesis 应当是：

- computer-use 需要的不只是一个 agent loop
- 更需要一个稳定的 computer control plane
- control plane 的工作不是规划动作，而是统一 runtime object model、capability surface、storage boundary、network boundary 和 execution trace

因此，`computerd` 首先应该成为：

- computer substrate abstraction
- control plane
- execution trace foundation

但它对外最值得强调的，不应只是一句“我是 control plane”，而应是：

- 我可以提供带正式网络边界的 computer runtime
- 我可以记录和回看 computer-use execution
- 我可以在一台个人机器上开箱部署并由人类接管

而不是先成为：

- end-user agent product
- benchmark brand
- multi-node platform

## Priority Roadmap

### P0: Lock The Product Boundary

先明确：

- single-machine first
- control plane / substrate first
- builder / researcher / operator first
- headline 以 `gateway + trajectory + self-hosted environment` 为主，而不是只写 `control plane`

这是所有后续技术决策的前提。

### P1: Formalize `profile / provider`

把“这台 computer 是什么”和“这台 computer 由谁承载”明确拆开。

目标：

- 固化对外 object model
- 收敛 browser / vm / container / host 的 capability 规则
- 降低 future runtime migration 的 API 代价

这是当前最优先的结构性工作。

### P2: Add `trajectory / artifact`

把 execution 过程提升成正式对象。

第一阶段优先覆盖：

- `display-actions`
- `screenshot`
- `console`

目标：

- 更强的调试能力
- 更好的复现与评测
- 为 benchmark / dataset export / replay 打基础

### P3: Clarify `storage / file / shared-folder`

显式区分：

- runtime persistent storage
- shared folder
- artifact storage
- optional sandbox file API

如果这层不拆清楚，后续 browser / vm / provider 差异会持续放大。

### P4: Clarify `gateway / network abstraction`

把 network 从“某个 runtime 的局部实现”提升为正式产品卖点。

目标：

- 让 computer 具备正式 network identity
- 明确 host / isolated / future policy semantics
- 让 browser / vm / container 在网络语义上尽量收敛

### P5: Add `auth / attach / audit`

在不引入复杂 RBAC 的前提下，补齐：

- API authentication
- session lease / token
- attach authorization
- audit logs

### P6: Strengthen Human-Friendly WebUI

让 WebUI 成为正式 adoption wedge，而不是只做调试附属面。

重点包括：

- browser / vm 的快速接管
- artifacts / trajectories 的可视化查看
- 常见 operator 动作的低门槛入口

### P7: Optional Upper Layers

在 core control plane 稳定后，再考虑增强层：

- benchmark / eval adapters
- research dataset export
- trajectory viewer / replay tools
- future fleet / manager layer

这些是重要扩展，但不应抢占 core positioning。

## Success Criteria

如果 `computerd` 的定位是正确的，短中期应能看到这些结果：

- 上层系统把它当作统一的 computer control plane，而不是一组杂散 runtime script
- 用户能清楚理解它的外部价值不只是“control plane”，而是“可部署、可追踪、可控网络边界的 computer runtime”
- browser / vm / host / container 能在同一 object model 下被稳定控制
- 失败 case 可以被 artifact / trajectory 明确记录
- network boundary 成为正式对象，而不是隐藏在 provider 实现里
- 新 provider 或新 profile 接入时，主要成本落在 adapter，而不是重写上层 contract

## Summary

`computerd` 不应试图在当前阶段同时成为：

- cluster control plane
- enterprise RBAC platform
- end-user personal agent

更合理的产品定位是：

- 单机上的 networked computer runtime
- 带 trajectory / artifact foundation 的 execution substrate
- 可被人类快速接管的 self-hosted environment
- 底层本体是 single-machine computer control plane
- 面向 agent builder / researcher / advanced operator
- 优先解决 runtime abstraction、network boundary、execution trace、storage boundary、auth/audit

这条路线更窄，但也更清晰，更符合当前代码库已经形成的真实优势。
