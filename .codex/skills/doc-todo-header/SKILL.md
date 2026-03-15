---
name: doc-todo-header
description: Maintain markdown documents by extracting active todos, next steps, and follow-up work into a canonical TODO block at the very top of the document and keeping that block synchronized with the rest of the text. Use when Codex edits docs, plans, rationale docs, or AGENT.md files that mention TODO, 下一步, 后续, 待办, follow-up, or when the user asks what to do next, forgot current progress, or wants to resume work without re-exploring from scratch.
---

# Doc Todo Header

## Overview

维护 Markdown 文档时，把文中已经出现的待办、下一步和后续工作统一提升到文档最前面的固定 TODO 块，并把它当成唯一的行动索引。
当用户问“下一步是什么”“我忘了做到哪了”“继续做接下来该做的事”时，先读这个 TODO 块，再决定是否需要继续扫描正文。

## Canonical Block

对普通 Markdown 文档，使用这个固定模式，并把它放在文件最开头；如果文件有 YAML frontmatter，就把它放在 frontmatter 后面。

```md
<!-- DOC-TODO-START -->
## 当前 TODO
- [ ] P1: <最重要、最具体、可直接执行的下一步>
- [ ] P2: <第二优先级的下一步>
<!-- DOC-TODO-END -->
```

遵守这些规则：

- 只保留仍未完成的行动项，不要把已完成事项继续留在块里。
- 用 `P1`、`P2` 这类优先级标签开头；每条都写成具体动作，不写空泛方向。
- 把正文里出现的 `TODO`、`下一步`、`后续`、`follow-up`、`待办` 全部收敛到这个块，避免正文和头部各有一份。
- 完成某项后，立即更新头部 TODO 块，再决定正文是否需要同步删改。
- 如果当前没有待办，也保留这个块，并写成 `- [ ] 暂无开放待办。`

## Maintenance Workflow

按下面顺序维护文档：

1. 先通读文档里已经写出的开放事项、下一步、限制和未决问题。
2. 提取真正还有效的行动项，合并重复项，按优先级写进顶部 TODO 块。
3. 回头清理正文里已经被提升到顶部的重复待办；正文保留背景和理由，不再保留第二份行动列表。
4. 如果文档新增了新的后续工作，优先先改顶部 TODO 块，再补正文说明。
5. 如果用户只让你“更新文档”但没有特别指出 TODO，也主动检查这个块是否仍然准确。

## Resume Workflow

用户忘记当前进度，或者直接问“下一步做什么”时，先执行这个顺序：

1. 先读相关文档顶部的 `当前 TODO` 块。
2. 如果问题是仓库层面的，先读 [AGENT.md](/Users/timzhong/computerd/AGENT.md) 顶部 TODO 块，再读相关专题文档。
3. 只有在 TODO 块缺失、明显过期、或不足以回答问题时，才继续扫描正文并重建 TODO。
4. 回答时优先基于已有 TODO 给出下一步，避免重新做一轮已经做过的探索。

## Editing Guidance

遵守这些落地约束：

- 不要把 TODO 块放在文档底部、附录里，或者埋在“下一步”章节后面。
- 不要让“当前 TODO”块和正文中的“下一步优先级”并存且内容重复；头部块必须是唯一真源。
- 不要把原则、背景判断、长期愿景伪装成 TODO；TODO 只写可执行项。
- 如果正文仍然需要保留“下一步”章节，就把它改写成解释、约束或排序依据，并明确注明以顶部 TODO 块为准。

## Example Rewrite

如果正文末尾原本是：

```md
## 下一步

1. 接真实 runtime
2. 收紧 Web 分层
```

改写后应变成：

```md
<!-- DOC-TODO-START -->
## 当前 TODO
- [ ] P1: 用真实 runtime port 替换当前内存/fixture control plane。
- [ ] P2: 把 Web 代码继续收紧为 transport / use-case / view-model / ui 边界。
<!-- DOC-TODO-END -->

# 文档标题

## 下一步

本节只解释为什么当前优先级是这样；具体待办以文件顶部 `当前 TODO` 块为准。
```
