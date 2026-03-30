# Playwright With Browser Computer

## Summary

browser computer 的 automation 面当前直接暴露底层 CDP websocket。

推荐接入方式不是让 computerd 转译 Playwright 动作，而是：

1. 启动 browser computer
2. 创建 automation session
3. 用 `chromium.connectOverCDP(...)` 直接 attach

这让 browser computer 继续保持“长期存在的真实浏览器环境”，而 Playwright 只作为客户端接入这个环境。

当前仓库同时提供两种推荐入口：

- TypeScript SDK：`@computerd/sdk`
- 示例 CLI：`examples/browser-cli.ts`

## Why CDP Attach

当前 browser computer 的产品边界是：

- computerd 负责 lifecycle
- computerd 负责 monitor/noVNC
- computerd 负责暴露 automation attach endpoint
- Playwright 负责 page/tab/context 级自动化

这样可以避免在 computerd 里重复建模大量高阶 browser actions。

## Current Contract

### Preconditions

- 目标 computer 必须是 `profile = "browser"`
- 目标 computer 必须处于 `running`
- 当前 browser engine 只支持 `chromium`

### Session creation

automation session 通过下面的 API 创建：

- `POST /api/computers/:name/automation-sessions`

返回结果的关键字段：

- `protocol = "cdp"`
- `connect.mode = "relative-websocket-path"`
- `connect.url = "/api/computers/:name/automation/ws"`

### Attach path

真正的 CDP attach 走：

- `GET /api/computers/:name/automation/ws`

这个 websocket bridge 会把客户端直接接到 Chromium DevTools websocket。

## Recommended Client Flow

### 1. Start the computer

先确保 browser computer 已启动：

```bash
curl -X POST http://127.0.0.1:3000/api/computers/chrome1/start
```

### 2. Create an automation session

```bash
curl -X POST http://127.0.0.1:3000/api/computers/chrome1/automation-sessions
```

示例返回：

```json
{
  "computerName": "chrome1",
  "protocol": "cdp",
  "connect": {
    "mode": "relative-websocket-path",
    "url": "/api/computers/chrome1/automation/ws"
  },
  "authorization": {
    "mode": "none"
  }
}
```

### 3. Connect Playwright

```ts
import { createComputerdClient } from "@computerd/sdk";

const client = createComputerdClient({
  baseUrl: "http://127.0.0.1:3000",
});

const browser = await client.connectPlaywright("chrome1");

const contexts = browser.contexts();
const context = contexts[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://example.com");
console.log(await page.title());
```

如果你不想通过 SDK helper，也可以直接使用返回的 websocket URL：

```ts
import { chromium } from "playwright";
import { createComputerdClient } from "@computerd/sdk";

const client = createComputerdClient({
  baseUrl: "http://127.0.0.1:3000",
});

const session = await client.createBrowserAutomationSession("chrome1");
const websocketUrl = client.resolveWebSocketUrl(session);
const browser = await chromium.connectOverCDP(websocketUrl);
```

## Notes On Existing State

browser computer 是长期状态浏览器，不是临时 Playwright browser。

因此 attach 后应假设：

- 可能已经有人类用户在 noVNC 中操作
- 可能已经存在 tab / window / cookie / local storage
- agent 生命周期结束后，这个 browser 仍可能继续存在

推荐做法：

- 优先 attach 到现有 browser，而不是期望“全新空白上下文”
- 自动化前先检查已有 pages/context
- 人类和 agent 并发时，尽量避免激进地重建 context 或关闭全部 tabs

## Screenshot Guidance

当前有两层截图语义：

- page screenshot: 用 Playwright 的 `page.screenshot()`
- fullscreen screenshot: 用 computerd 的 `POST /api/computers/:name/screenshots`

推荐原则：

- 如果你要 DOM/page 级截图，用 Playwright
- 如果你要“人类看到的整块屏幕”，用 computerd screenshot

## Viewport Updates

browser computer 现在支持显式 viewport 更新：

- `POST /api/computers/:name/viewport`

WebUI popup monitor 会在窗口尺寸变化时自动调用这个接口，把当前可视区同步回 browser computer。

如果你从 SDK/脚本侧控制，也可以手动调用：

```ts
const client = createComputerdClient({
  baseUrl: "http://127.0.0.1:3000",
});

await client.updateBrowserViewport("chrome1", {
  width: 1600,
  height: 1000,
});
```

## Errors To Expect

### Computer not running

如果 browser computer 还没启动，创建 automation session 会返回冲突错误。

### Unsupported profile

host computer 不支持 automation session。

### Auth model

当前 automation session 默认：

- `authorization.mode = "none"`

这只是当前最小实现；后续可能扩展为 ticket/token 模式。

## Current Limits

- 当前只支持 Chromium CDP
- 当前 SDK 只覆盖 browser automation / monitor / screenshot
- 当前没有 page/tab 级 server-side action API
- 当前没有 automation attach 的额外鉴权层

## MCP Mapping

如果从 MCP 使用，当前对应工具是：

- `create_browser_automation_session`

这个工具返回的也是同一套 CDP session descriptor。后续 Playwright client 仍应直接连 websocket attach URL。

## CLI Helpers

如果你只需要快速连通 browser computer，而不是在应用代码里嵌入 SDK，可以直接运行示例 CLI：

```bash
pnpm exec vite-node examples/browser-cli.ts browser-info chrome1
pnpm exec vite-node examples/browser-cli.ts browser-connect chrome1
pnpm exec vite-node examples/browser-cli.ts browser-screenshot chrome1 --out ./chrome1.png
```
