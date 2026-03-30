# Frontend Selection

## Goal

为 `apps/web` 确定一个足够窄、能继续演进的前端基线，优先服务当前的 control plane 工作台，而不是为未知场景提前堆框架。

## Current State

仓库当前已经具备以下前端基线：

- `React 19`
- `Vite 7`
- `TypeScript`
- `Vitest + Testing Library`
- `Playwright`
- 共享领域契约来自 `@computerd/core`

这说明“前端框架”层面的选型已经完成，当前真正要定的是后续演进策略。

## Decision

### 1. Runtime Framework

保留 `React 19 + Vite 7`，不切到 `Next.js`、`Nuxt` 或其他 SSR 框架。

原因：

- 当前产品是内部工作台形态，核心是控制面板交互，不是内容站点。
- 现有服务端已经提供独立 HTTP API，前后端边界清晰，没有引入全栈框架的必要。
- 当前 monorepo 已经围绕 `Vite + Vitest` 建立验证链路，切栈成本高且收益不明显。

### 2. Data Layer

下一步推荐引入 `@tanstack/react-query` 作为服务端状态层。

适用原因：

- 当前 UI 已经有列表、详情、刷新、创建、启动、停止、重启等典型远程状态场景。
- 现在的 `useEffect + useState` 能跑，但继续增长后会把加载、失效、并发刷新逻辑堆进组件。
- React Query 能把“远程数据状态”与“本地交互状态”拆开，比较符合后续 `transport / use-cases / view-model / ui` 分层。

约束：

- 只管理 API 数据，不拿它替代领域模型。
- Query key 和 fetch/parse 逻辑应收敛到 `transport` 或 `use-cases` 层，不直接散落在 UI 组件里。

### 3. Routing

当前先不引入路由库。

原因：

- 现阶段是单工作台界面，没有多页信息架构压力。
- 过早引入 router 只会增加文件组织复杂度。

触发条件：

- 当出现独立信息架构，例如 `/computers/:name`、`/host-units/:unitName`、`/settings` 时，再引入 `TanStack Router`。

选择 `TanStack Router` 而不是 `React Router` 的前提：

- 需要更强的类型约束；
- 希望路由参数、loader、搜索参数和 TS 配合更紧。

### 4. Forms

当前先继续使用 React 原生受控表单，不急着引入 `react-hook-form`。

原因：

- 现在只有一个创建表单，字段数量有限。
- 共享契约已经在 `@computerd/core`，当前的主要问题不是表单库能力不足，而是组件边界还没拆开。

触发条件：

- 当创建/编辑表单明显增多；
- 当需要复杂校验、字段数组、局部重置、复用表单逻辑时，再引入 `react-hook-form`。

### 5. UI Styling

保持“自定义样式 + 设计 token”路线，不引入 `Tailwind CSS` 或重型组件库作为默认基线。

原因：

- 当前样式已经是手写 CSS，视觉方向明确，不存在必须依赖 utility-first 的问题。
- 控制面板类产品的核心复杂度在信息结构和状态流，不在通用营销组件。
- 过早接入组件库容易把产品语义让位给库语义。

建议：

- 继续使用 CSS 变量管理颜色、间距、圆角、阴影。
- 当组件开始复用时，优先抽自有 UI 组件。
- 若后续确实需要无样式可访问 primitives，再补 `Radix UI`，但只按需引入。

### 6. Frontend Structure

按照 `AGENT.md` 约束，优先把 `apps/web/src` 从单体组件收紧为以下结构：

- `transport`: API 调用、解析、query key、错误映射
- `use-cases`: 面向页面动作的组合逻辑
- `view-model`: 将领域对象转换为 UI 直接消费的数据
- `ui`: 纯展示组件

这比继续做“库选型”更优先，因为当前主要风险是组件把 API、状态、表单、展示混在一起。

## Recommended Near-Term Stack

当前建议的前端栈是：

- Framework: `React 19`
- Build: `Vite 7`
- Language: `TypeScript`
- Server state: `@tanstack/react-query`
- Local state: React state
- Forms: 原生受控表单，暂不加库
- Routing: 暂不引入
- Styling: CSS + design tokens
- Testing: `Vitest + Testing Library + Playwright`

## Not Recommended Now

当前不建议引入：

- `Next.js`
- `Tailwind CSS`
- 全量 UI 组件库
- `Redux` / `Zustand`
- 以“未来可能用到”为理由的复杂前端基础设施

这些工具并非不能用，而是当前阶段没有足够强的收益来覆盖复杂度。

## Execution Order

建议按这个顺序推进：

1. 先把 `apps/web/src/App.tsx` 拆层。
2. 在拆层过程中引入 `@tanstack/react-query`。
3. 等出现稳定多页结构后再决定是否接入 `TanStack Router`。
4. 等表单复杂度上来后再决定是否接入 `react-hook-form`。
