---
name: dev-task-loop
description: End-to-end software development workflow from requirement intake through implementation, local verification, GitHub pull request creation, and pull request follow-up. Use only when the user explicitly asks for a closed-loop development task such as “闭环开发任务”, “从需求做到提 PR”, “做到 PR 为止”, or explicitly mentions $dev-task-loop / this skill. In that case, Codex should continue autonomously through scope clarification, implementation, local checks, branch and PR creation, and PR status follow-up until the PR is opened or a concrete blocker prevents further progress.
---

# Dev Task Loop

## Overview

只有在用户明确要求“闭环开发任务”，或者明确点名 `$dev-task-loop` / 这个 skill 时才使用它。使用这个 skill 时，把任务当成一个必须闭环的工程交付，而不是只产出代码片段；默认持续推进“需求 -> 改动 -> 本地验证 -> GitHub PR -> PR 跟进”，直到 PR 已提出，或者出现明确阻塞点。

## Execution Checklist

按下面顺序执行；除非用户明确只要某一段，否则不要停在中间。默认目标不是“完成代码修改”，而是“完成到 PR 已提出并确认首轮 CI 状态”为止。

### 1. Clarify Scope

- 先读用户请求，再读仓库内的 `AGENTS.md`、`AGENT.md`、`README.md`、相关设计文档。
- 产出一句话任务定义，格式固定为：`目标 / 约束 / 验证标准`。
- 如果需求有空缺，先判断能否做最小合理假设。
- 只有当不同假设会导向不同实现时才提问；问题保持 1 个，且必须可直接决策。

### 2. Build Context

先建立实现上下文，再改代码。至少执行这些检查：

```bash
git status --short
rg -n "<feature|symbol|route|test-name>" .
rg --files | rg "(test|spec|package.json|playwright|vitest|workflow|ci)"
```

- 找到入口文件、调用链、测试文件、构建脚本、CI 工作流。
- 确认仓库现有分层和边界，不要跨层随意塞逻辑。
- 如果工作树已有用户改动，只在当前任务相关文件中编辑，不要回滚别人的变更。

### 3. Implement

- 先遵循现有代码风格、类型建模、测试模式，再考虑额外抽象。
- 默认直接落地代码，不只输出方案。
- 代码改动完成前，至少自查一次：

```bash
git diff --stat
git diff -- <path>
```

检查点：

- 改动是否刚好对应需求，没有顺手混入无关重构。
- 测试是否随行为变化同步更新。
- 文档或配置是否因为这次改动而失真。

### 4. Verify Locally

先跑与改动最接近的验证，再决定是否扩到全量验证。

执行顺序：

1. 跑单测或单模块验证。
2. 跑仓库定义的聚合验证命令。
3. 如果 PR 会触发特定 CI，再尽量在本地复现对应命令。

常用检查方式：

```bash
cat package.json
rg -n "\"(verify|test|lint|typecheck|build|smoke|e2e)\"" package.json apps packages
rg -n "name:|run:" .github/workflows
```

报告验证结果时必须包含：

- 实际执行的命令
- 成功 / 失败
- 失败时的第一个有效报错
- 是否已定位到根因

不要写“已验证”除非命令真的跑过。

## Computerd Default Validation Matrix

在这个仓库里，默认按下面矩阵决定验证范围，不要每次重新发明一套：

### Baseline Facts

- 包管理器固定为 `pnpm`。
- CI workflow 只有一个主检查：`.github/workflows/verify.yml` 中的 `Verify` job。
- 这个 job 在 GitHub Actions 里的顺序是：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm verify
```

- `pnpm verify` 实际串行执行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

- `pnpm verify:quick` 实际串行执行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke:dev
```

### What To Run By Default

如果用户没有指定验证范围，默认这样做：

1. 小范围代码修复，且改动不涉及构建、前端渲染、启动链路：

```bash
pnpm test --filter <target-if-supported>
pnpm typecheck --filter <target-if-supported>
```

如果没有现成 filter 或命令不支持，就退回仓库聚合命令：

```bash
pnpm verify:quick
```

2. 改动涉及 `apps/server` API、`apps/web` 页面、启动流程、fixture、端到端行为时：

```bash
pnpm verify:quick
```

因为它会额外跑 `smoke:dev`，验证 server 和 web 能否同时启动并返回基础页面与 API。

3. 准备提 PR，或者用户明确要求“按 CI 标准验证”时：

```bash
pnpm exec playwright install chromium
pnpm verify
```

如果本机是首次执行 Playwright，先装浏览器；如果已装过且环境稳定，可以直接跑 `pnpm verify`。

4. 改动触及 e2e、构建配置、Vite、Playwright、工作流脚本时：

```bash
pnpm exec playwright install chromium
pnpm verify
```

不要只跑 `verify:quick`，因为它不包含 `test:e2e` 和 `build`。

### How To Choose Fast

按下面规则快速选命令：

- 只改纯类型、纯映射、纯工具函数：先跑最相关 test/typecheck，再视情况补 `pnpm verify:quick`。
- 改 `apps/server` 的 HTTP 行为、fixture fallback、inventory 逻辑：至少跑 `pnpm verify:quick`。
- 改 `apps/web` 的页面加载、API 接入、渲染入口：至少跑 `pnpm verify:quick`。
- 改 monorepo 配置、Vite、TypeScript、Playwright、CI 脚本：直接跑 `pnpm verify`。
- 准备推 PR 时，如果时间允许，优先对齐 CI，跑 `pnpm verify` 而不是只跑 `verify:quick`。

### How To Report Computerd Verification

在这个仓库里，验证汇报优先写成下面这种格式：

1. `pnpm verify:quick` 通过 / 失败。
2. 如果失败，指出挂在 `format` / `lint` / `typecheck` / `test` / `smoke:dev` 哪一步。
3. 如果跑了 `pnpm verify`，单独说明是否覆盖了 `test:e2e` 和 `build`。
4. 如果没跑 `pnpm verify`，明确写“尚未按 CI 全量矩阵验证”。

### CI Reproduction Rule

如果 PR 的 GitHub check 失败，而且失败项属于 `Verify` workflow，默认本地复现顺序是：

```bash
pnpm exec playwright install chromium
pnpm verify
```

只有在已经明确知道失败阶段时，才可以缩小到单步，例如：

```bash
pnpm test
pnpm test:e2e
pnpm build
```

但回答用户时要说明这是“针对失败阶段的局部复现”，不是完整 CI 复现。

### 5. Prepare Git State

做 PR 之前，先整理 Git 状态：

```bash
git status
git diff --stat
git branch --show-current
git remote -v
```

- 需要新分支时，按仓库规则命名；如果要求 `codex/` 前缀，就遵守。
- 提交前确认没有意外生成物、密钥、日志、临时文件。
- 提交信息格式优先用：`type: action target`，例如 `feat: bootstrap computerd foundation`。

### 6. Create PR

先确认 GitHub 能力可用：

```bash
gh --version
gh auth status
```

然后按顺序执行：

```bash
git push -u origin <branch>
gh pr status
gh pr create --base <base> --head <branch> --title "<title>" --body-file <file>
```

PR 描述至少写清楚四件事：

- 改了什么
- 为什么这样改
- 本地怎么验证的
- 剩余风险或未覆盖项

如果仓库已经有对应 PR，改为更新现有 PR，不要重复创建。

### 7. Follow PR Until Stable

PR 创建后不要只看是否 open，要继续检查：

- CI 是否通过
- `reviewDecision` 是否为空、approved、changes requested
- 是否有 review comments / line comments
- 是否可 merge

优先用 `gh`，并按下面顺序查：

```bash
gh pr view <pr> --json number,title,state,isDraft,headRefName,baseRefName,url,reviewDecision,statusCheckRollup
gh pr checks <pr>
```

如果 checks 失败，继续往下钻：

```bash
gh run view <run-id> --json name,displayTitle,headBranch,headSha,status,conclusion,jobs,url
gh run view <run-id> --job <job-id> --log-failed
```

分析失败日志时，不要整段转述。提炼成四项：

- 失败工作流 / job 名称
- 失败阶段或命令
- 第一个有效报错
- 根因与计划修复动作
