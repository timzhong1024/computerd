<!-- DOC-TODO-START -->

## 当前 TODO

- [ ] P1: 用真实 runtime port 替换当前内存/fixture control plane。
- [ ] P2: 保持 `computer` 为主模型，不把 runtime helper 反向抬升成顶层对象。
- [ ] P3: 把 Web 代码从当前单文件状态继续收紧为更清晰的 `transport / use-cases / view-model / ui` 边界。
- [ ] P4: 继续保持 MCP / HTTP / Web 共用同一套契约，而不是各自扩字段。
<!-- DOC-TODO-END -->

# AGENT.md

这个文件是给未来继续在本仓库工作的 agent 的短期记忆，不是产品宣传文案。上下文变长或中断后，优先先读这个文件，再看 `README.md`（如果存在）。
当前文件顶部 `当前 TODO` 块是待办唯一真源。需要判断“下一步做什么”、恢复上下文，或者回答用户“接下来该做什么”时，先读这个块，再继续展开全文。

TypeScript 编码规范单独写在 [docs/typescript-style.md](/Users/timzhong/computerd/docs/typescript-style.md)。做 TS 改动前，先按那份规范判断当前建模是不是足够窄、足够精确。

## 项目目标

Computerd 是一个面向 homelab 用户与 AI agent 的 computer control plane，底层由 systemd 承载。

当前核心判断：

- 顶层产品对象是 `computer`，不是 workload catalog。
- `browser` / `terminal` 先作为 `computer.profile` 存在，不再作为顶层类型扩散。
- host systemd units 保留，但只作为轻量 inspect surface，不是主要编辑路径。
- WebUI、HTTP API、MCP 必须共享同一套领域模型，不允许各自发明对象语义。

当前阶段仍然是早期重启期。默认不要为兼容旧想法、旧接口或外部用户保留负担；只要方向更清晰，允许直接做破坏性演进，并同步更新测试和文档。

## 当前代码状态

仓库已经初始化为 `pnpm` monorepo，当前主要工作区：

- `packages/core`: `computer` / `host-unit` 共享契约、schema、纯解析、纯校验
- `packages/control-plane`: control plane 端口、fixture-backed/in-memory application logic
- `apps/server`: Node.js HTTP host 与 `/mcp` transport
- `apps/web`: React + Vite 工作台
- `apps/mcp`: MCP tool/server 定义

当前已打通的最小链路：

- `packages/core` 导出：
  - `ComputerSummary`
  - `ComputerDetail`
  - `CreateComputerInput`
  - `HostUnitSummary`
  - `HostUnitDetail`
- `packages/control-plane` 提供：
  - `listComputers`
  - `getComputer`
  - `createComputer`
  - `startComputer`
  - `stopComputer`
  - `restartComputer`
  - `listHostUnits`
  - `getHostUnit`
- `apps/server` 提供：
  - `GET /healthz`
  - `GET /api/computers`
  - `POST /api/computers`
  - `GET /api/computers/:name`
  - `POST /api/computers/:name/start`
  - `POST /api/computers/:name/stop`
  - `POST /api/computers/:name/restart`
  - `GET /api/host-units`
  - `GET /api/host-units/:unitName`
  - `POST /mcp`
- `apps/web` 已完成：
  - managed computers 列表
  - create form
  - detail panel
  - start/stop/restart actions
  - host inspect list/detail
- `apps/mcp` 已完成与 HTTP 同步的 computer / host inspect tool 集

当前 control plane 还是内存/fixture 版本，用来稳定产品模型和工程边界。不要把这误写成“已经完成真实 systemd runtime 接入”。

## 当前分层约束

- `packages/core`
  - 只放领域类型、schema、纯解析、纯校验、纯映射
  - 不放环境变量读取、HTTP、MCP、文件系统读写、systemd 调用
- `packages/control-plane`
  - 放用例、application wiring、runtime/metadata port 边界
  - server / mcp 只通过这里复用后端能力
- `apps/server/src/transport`
  - 只负责 HTTP 输入输出与 `/mcp` transport host
- `apps/mcp/src`
  - 只负责 MCP tool 定义和 server 构造
- `apps/web/src`
  - 当前仍是小型单体界面；如果继续增长，优先拆成 `transport` / `use-cases` / `view-model` / `ui`

依赖方向约束：

- `apps/server` 可以依赖 `packages/control-plane`、`packages/core`、`apps/mcp`
- `apps/mcp` 可以依赖 `packages/control-plane` 和 `packages/core`
- `packages/control-plane` 可以依赖 `packages/core`
- `packages/core` 不能依赖任何 app

如果一个改动同时需要碰 domain、control-plane、transport、UI 四层，先停下来检查是不是边界被写混了。

## 当前建模风格

最近一轮 control-plane 重构已经把核心行为抽象统一成 class 风格，后续默认继续沿用，不要回退到 object-literal service 模式。

- 对外或跨模块复用的“行为抽象”：
  - 优先用 `abstract class`
  - 不再使用 `interface + plain object implementation` 作为正式实现
  - 典型例子：`BaseControlPlane` / `ComputerRuntimePort` / `SystemdRuntime` / `DockerRuntime` / `ImageProvider` / `ComputerMetadataStore`
- 具体实现：
  - 用明确命名的 concrete class
  - development / runtime / systemd / docker 等模式差异放在具体 class，不放在抽象层上做条件分支
  - 如果 production 实际是组合体，显式建组合类，例如 `CompositeComputerRuntime`
- 简单代理工厂：
  - 如果工厂函数只剩 `return new Xxx(...)`，应删除，不保留兼容层
  - 只有在确实承担装配价值时才保留工厂
- 依赖装配：
  - class 自己不同时接受“现成依赖实例”和“创建该依赖所需参数”两套入口
  - 依赖要正交：例如 `DefaultDockerRuntime` 只接收现成 `Docker` client，socket/path 等创建策略放在外层 wiring
- 方法使用方式：
  - 不做自动 `bind`
  - 禁止把实例方法直接解构或作为裸函数外传；调用方必须通过 `instance.method(...)` 使用
- `interface` 仍然可以保留，但只用于：
  - 参数 shape
  - 纯数据结构
  - 外部库返回值或代理类型
- 路径、spec、轻量纯 helper：
  - 可以继续返回 object literal
  - 不要为了“统一 class 风格”把纯数据 helper 硬改成 class

## 统一模型

当前统一对象模型固定为两组：

- managed object: `computer`
- read-only inspect object: `host-unit`

`computer` 当前核心语义：

- 逻辑对象名称是 `name`
- 底层 primary systemd object 名称是 `unitName`
- 当前支持 profile：
  - `terminal`
  - `browser`
- 默认是持久对象，不是 disposable session
- 当前默认一台 `computer` 对应一个 primary unit
- 后续可以扩展 helper units，但不要提前把 helper 扩散成新的顶层对象

当前明确不该做的事：

- 不要把项目重新带回 workload-first 模型
- 不要重新引入 `browser` / `vm` / `command-workload` 作为顶层 managed type
- 不要把 host inspect 发展成主要编辑入口
- 不要为了未来可能需要而提前引入数据库、多租户、RBAC、集群语义

## 当前技术约束

- 包管理器固定为 `pnpm`
- 工程工具固定为 `Vite + Vitest + oxfmt + oxlint + TypeScript`
- 整体采用 ESM
- `pnpm verify` 是唯一 CI 真源
- `postinstall` 会安装 `pre-push`，默认在本地推送前执行 `pnpm verify`
- `.github/workflows/verify.yml` 的检查矩阵固定为：
  - `pnpm install --frozen-lockfile`
  - `pnpm exec playwright install --with-deps chromium`
  - `pnpm verify`

`pnpm verify` 当前串行执行：

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm test:e2e`
6. `pnpm build`

`pnpm verify:quick` 当前串行执行：

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm smoke:dev`

## 工作方式

做实现前先检查：

- 当前改动是在收紧 `computer` 模型，还是又把 systemd/runtime 细节往 UI 层扩散
- 当前改动是否破坏了 Web / HTTP / MCP 的共享契约
- 当前改动是否让 host inspect 越权变成了主产品路径

做实现后至少验证：

- 首次本机跑 Playwright 时：`pnpm exec playwright install chromium`
- 小范围改动：至少跑受影响模块测试和 `pnpm verify:quick`
- 准备提 PR：跑 `pnpm verify`

验证汇报必须写清楚：

- 实际执行了哪些命令
- 成功 / 失败
- 若失败，卡在 `format` / `lint` / `typecheck` / `test` / `smoke:dev` / `test:e2e` / `build` 哪一步

## 下一步优先级

具体待办以文件顶部 `当前 TODO` 块为准；这里不再重复列出，避免出现两份待办逐渐漂移。
