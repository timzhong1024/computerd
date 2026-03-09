# Browser Computer Implementation Plan

## Goal

在当前 `computerd` 仓库里，把 `browser` 从“schema 已存在但 runtime 未支持”的 profile，推进成一个真正可创建、可启动、可停止、可监看、可被 WebUI 和 MCP 使用的 managed `computer`。

目标 / 约束 / 验证标准：

- 目标：实现第一个可用的 browser computer vertical slice
- 约束：保持 `computer` 为唯一顶层 managed object，不引入新的顶层 `browser` 类型；继续沿用现有 `packages/core -> packages/control-plane -> apps/server/apps/mcp/apps/web` 分层
- 验证标准：本地 `pnpm verify` 通过，且 browser computer 可通过 WebUI/API/MCP 创建、启动、停止，并能打开 monitor session

## Current State

当前仓库已经具备这些前提：

- `packages/core` 已定义 `browser` profile 的 schema、detail、create input
- `apps/web` 已经有 browser create form 和 detail 渲染
- `apps/server` / `apps/mcp` 已经把 browser 当成 `computer` 返回
- `packages/control-plane` 当前只对 `terminal` profile 接入了真实 DBus/runtime 行为
- `packages/control-plane` 对 `browser` profile 仍然显式报 “not supported in the DBus runtime yet”

因此，这次任务的核心不是改产品模型，而是把 control-plane/runtime/monitoring 补齐到 browser profile。

## Implementation Changes

### 1. Stabilize browser runtime contract in `packages/core`

确认并收紧 browser computer 的运行时契约：

- 保持 `profile: "browser"` 不变
- 保持 `runtime.browser`, `runtime.startUrl`, `runtime.persistentProfile`
- 如果需要 browser-specific monitor access data，补到 `ComputerDetail` 的 browser 分支里，不要污染 terminal 分支
- 不要引入 VM、display mode matrix、expert mode 等额外复杂度

如需新增字段，优先只加以下这类最小字段：

- browser engine executable / logical engine choice
- profile/state directory path 的派生表达
- monitor capability 所需的只读 session metadata

避免新增：

- 通用 workload kind
- 容器/VM 共用 runtime 抽象
- 还未落地的 browser automation capability schema

### 2. Extend control-plane to support browser profile

在 `packages/control-plane` 中补齐 browser profile 的真实行为：

- `createComputer` 支持 browser record 落库/落 metadata
- `startComputer` / `stopComputer` / `restartComputer` 支持 browser primary unit
- `getComputer` / `listComputers` 返回 browser runtime state 和 capability
- 不再对 browser 返回 “not supported in the DBus runtime yet”

实现原则：

- 保持 `terminal` 和 `browser` 在同一 `computer` 模型下
- profile-specific 逻辑放到窄函数里，不要写一个继续膨胀的总 `switch`
- systemd/unit rendering 可以分 profile，但 metadata store / summary/detail 语义保持统一

如果当前 runtime 已有 terminal-specific port，扩展方式优先是：

- 为 runtime port 增加 browser 所需的最小能力
- 或引入 profile-specific helper function，在 control-plane 内部按 profile 路由

不要：

- 把 browser runtime 逻辑塞回 `apps/server`
- 用大而全的 “executeComputerAction(record)” 一类入口把所有 profile 混在一起

### 3. Add browser unit rendering and runtime adapter support

在 `packages/control-plane/src/systemd` 下补 browser 对应的 unit/rendering：

- 为 browser computer 渲染 primary unit
- 约定 browser profile 的工作目录 / runtime 目录 / 持久 profile 目录
- 启动命令至少支持：
  - 浏览器引擎选择
  - `startUrl`
  - headful / monitor-compatible 启动模式

如果 monitor 依赖额外 helper：

- 允许渲染 browser primary unit + helper unit(s)
- 但产品层仍只暴露一个 `computer`
- helper 只作为实现细节，不出现在 top-level list/create API 里

本阶段不要求：

- 完整 Playwright automation
- 多浏览器后端兼容矩阵
- GPU / passthrough / SPICE / VM display 语义

### 4. Implement browser monitor sessions end-to-end

把 browser profile 的 monitor path 补成真实可用链路：

- control-plane 能创建 browser monitor session
- server 暴露 monitor session create/attach endpoint
- WebUI 能从 browser computer detail 进入 monitor 页面
- monitor 页面至少能展示已建立的 browser monitor connection，而不是占位态

如果当前已有 monitor session 测试壳子，优先补全既有调用链，不要另开第二套 route。

这一步的最低完成标准：

- browser computer 运行后能拿到 monitor session descriptor
- monitor session attach URL/WS URL 正常返回
- WebUI 从 `/computers/:name/monitor` 可进入可见的 browser monitor 页面

### 5. Update WebUI and MCP only where behavior changes

WebUI：

- 保持 browser create form 不变或仅做最小修正
- 在 computer detail 中正确显示 browser runtime state
- monitor action 只对 browser computer 可用
- terminal console action 继续只对 terminal 可用

MCP：

- 继续复用 `computer` 语义，不新增顶层 browser object tool
- 如果 browser 可监看需要新的 action，再新增最小 browser-monitor 相关 tool
- 若现有 inspect 返回的信息已足够，则不新增 tool

### 6. Keep host inspect and terminal behavior stable

本次实现必须保证：

- host inspect 仍是 read-only
- terminal console session 行为不回退
- terminal 的 create/start/stop/restart/console attach 测试继续通过
- browser 的引入不会破坏 `computer` 统一列表/详情契约

## Files Most Likely To Change

- [index.ts](/Users/timzhong/computerd/packages/core/src/index.ts)
- [index.ts](/Users/timzhong/computerd/packages/control-plane/src/index.ts)
- [create-app.ts](/Users/timzhong/computerd/apps/server/src/transport/http/create-app.ts)

以及与 systemd runtime、web monitor 页面、MCP tool 定义相关的对应文件。

## Test Plan

至少补齐并跑通下面这些测试：

### Core / domain

- browser `CreateComputerInput` 解析
- browser `ComputerDetail` / capability 派生
- browser monitor/session descriptor schema

### Control-plane

- `createComputer` 支持 browser profile
- `startComputer` / `stopComputer` / `restartComputer` 支持 browser profile
- `getComputer` / `listComputers` 返回 browser runtime state
- browser monitor session create/attach 成功
- terminal console 路径无回退

### Server / MCP

- browser 相关 API route 返回 200/201
- browser monitor session route 正常返回 descriptor
- MCP inspect / lifecycle tool 能处理 browser computer

### Web

- 创建 browser computer 后可在列表与详情中看到
- browser detail 中 monitor action 可用
- `/computers/:name/monitor` 可加载 browser monitor 页面
- terminal console 页面行为保持不变

### E2E

至少覆盖：

1. 创建 browser computer
2. 启动 browser computer
3. 进入 browser monitor 页面
4. 停止 browser computer

并继续保留当前 terminal computer e2e。

### Full verification

最终必须执行：

```bash
pnpm verify
```

如果首次本机缺 Playwright 浏览器，先执行：

```bash
pnpm exec playwright install chromium
```

## Acceptance Criteria

满足以下条件才算完成：

- browser computer 不再是 “schema 存在但 runtime 不支持”
- browser 与 terminal 仍然共享统一 `computer` 模型
- browser monitor 链路从 control-plane 到 WebUI 可用
- terminal console 链路无回退
- `pnpm verify` 通过

## Explicit Non-Goals

这次不做：

- VM computer
- browser automation / Playwright agent control
- expert mode
- container/image model
- GPU / passthrough / SPICE / 安装盘 / 磁盘镜像 provisioning
- 把 browser 提升为新的顶层 object kind
