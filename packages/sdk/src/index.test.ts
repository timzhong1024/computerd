import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ComputerdHttpError, createComputerdClient, runBrowserCli } from "./index";

describe("createComputerdClient", () => {
  test("parses browser automation sessions", async () => {
    const client = createComputerdClient({
      baseUrl: "http://computerd.test",
      fetch: vi.fn(async () =>
        createJsonResponse({
          computerName: "research-browser",
          protocol: "cdp",
          connect: {
            mode: "relative-websocket-path",
            url: "/api/computers/research-browser/automation/ws",
          },
          authorization: {
            mode: "none",
          },
        }),
      ) as typeof fetch,
    });

    await expect(client.createBrowserAutomationSession("research-browser")).resolves.toMatchObject({
      protocol: "cdp",
      authorization: {
        mode: "none",
      },
    });
  });

  test("parses browser monitor sessions and screenshots", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          computerName: "research-browser",
          protocol: "vnc",
          connect: {
            mode: "relative-websocket-path",
            url: "/api/computers/research-browser/monitor/ws",
          },
          authorization: {
            mode: "none",
          },
          viewport: {
            width: 1440,
            height: 900,
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          computerName: "research-browser",
          format: "png",
          mimeType: "image/png",
          capturedAt: "2026-03-10T00:00:00.000Z",
          width: 1440,
          height: 900,
          dataBase64: Buffer.from("png").toString("base64"),
        }),
      );

    const client = createComputerdClient({
      baseUrl: "http://computerd.test",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.createBrowserMonitorSession("research-browser")).resolves.toMatchObject({
      protocol: "vnc",
      viewport: {
        width: 1440,
        height: 900,
      },
    });

    await expect(client.captureBrowserScreenshot("research-browser")).resolves.toMatchObject({
      mimeType: "image/png",
      width: 1440,
    });
  });

  test("updates browser viewport through the HTTP api", async () => {
    const client = createComputerdClient({
      baseUrl: "http://computerd.test",
      fetch: vi.fn(async () =>
        createJsonResponse({
          name: "research-browser",
          unitName: "computerd-research-browser.service",
          profile: "browser",
          state: "running",
          createdAt: "2026-03-10T00:00:00.000Z",
          access: {
            display: {
              mode: "virtual-display",
            },
          },
          capabilities: {
            canInspect: true,
            canStart: false,
            canStop: true,
            canRestart: true,
            consoleAvailable: false,
            browserAvailable: true,
            automationAvailable: true,
            screenshotAvailable: true,
            audioAvailable: true,
          },
          resources: {},
          storage: {
            rootMode: "persistent",
          },
          network: {
            mode: "host",
          },
          lifecycle: {},
          status: {
            lastActionAt: "2026-03-10T00:00:00.000Z",
            primaryUnit: "computerd-research-browser.service",
          },
          runtime: {
            browser: "chromium",
            persistentProfile: true,
            runtimeUser: "computerd-b-research-browser",
            profileDirectory: "/var/lib/computerd/computers/research-browser/profile",
            runtimeDirectory: "/run/computerd/computers/research-browser",
            display: {
              protocol: "x11",
              mode: "virtual-display",
              viewport: {
                width: 1600,
                height: 1000,
              },
            },
            automation: {
              protocol: "cdp",
              available: true,
            },
            audio: {
              protocol: "pipewire",
              isolation: "host-pipewire-user",
              available: true,
            },
            screenshot: {
              format: "png",
              available: true,
            },
          },
        }),
      ) as typeof globalThis.fetch,
    });

    await expect(
      client.updateBrowserViewport("research-browser", {
        width: 1600,
        height: 1000,
      }),
    ).resolves.toMatchObject({
      profile: "browser",
      runtime: {
        display: {
          viewport: {
            width: 1600,
            height: 1000,
          },
        },
      },
    });
  });

  test("resolves relative websocket paths against http and https base urls", () => {
    const httpClient = createComputerdClient({
      baseUrl: "http://127.0.0.1:3000/base/",
      fetch: vi.fn() as typeof globalThis.fetch,
    });
    const httpsClient = createComputerdClient({
      baseUrl: "https://computerd.example",
      fetch: vi.fn() as typeof globalThis.fetch,
    });

    expect(
      httpClient.resolveWebSocketUrl({
        connect: {
          mode: "relative-websocket-path",
          url: "/api/computers/research-browser/automation/ws",
        },
      }),
    ).toBe("ws://127.0.0.1:3000/api/computers/research-browser/automation/ws");

    expect(httpsClient.resolveWebSocketUrl("/api/computers/research-browser/monitor/ws")).toBe(
      "wss://computerd.example/api/computers/research-browser/monitor/ws",
    );
  });

  test("throws ComputerdHttpError with payload details for non-2xx responses", async () => {
    const client = createComputerdClient({
      baseUrl: "http://computerd.test",
      fetch: vi.fn(async () =>
        createJsonResponse(
          {
            error: "browser computer is stopped",
          },
          {
            status: 409,
            statusText: "Conflict",
          },
        ),
      ) as typeof globalThis.fetch,
    });

    await expect(client.createBrowserAutomationSession("research-browser")).rejects.toMatchObject({
      name: "ComputerdHttpError",
      status: 409,
      statusText: "Conflict",
      payload: {
        error: "browser computer is stopped",
      },
    } satisfies Partial<ComputerdHttpError>);
  });

  test("connectPlaywright resolves the websocket url before calling connectOverCDP", async () => {
    const connectOverCDP = vi.fn(async () => ({ browserType: "stub" }) as unknown);
    const client = createComputerdClient({
      baseUrl: "http://computerd.test",
      fetch: vi.fn(async () =>
        createJsonResponse({
          computerName: "research-browser",
          protocol: "cdp",
          connect: {
            mode: "relative-websocket-path",
            url: "/api/computers/research-browser/automation/ws",
          },
          authorization: {
            mode: "none",
          },
        }),
      ) as typeof globalThis.fetch,
    });

    await client.connectPlaywright("research-browser", {
      connectOverCDP: connectOverCDP as never,
    });

    expect(connectOverCDP).toHaveBeenCalledWith(
      "ws://computerd.test/api/computers/research-browser/automation/ws",
      undefined,
    );
  });
});

describe("runBrowserCli", () => {
  test("browser-info prints browser detail summary", async () => {
    const output = createMemoryWriter();
    const error = createMemoryWriter();
    const fetch = vi.fn(async () =>
      createJsonResponse({
        name: "chrome1",
        unitName: "computerd-chrome1.service",
        profile: "browser",
        state: "running",
        createdAt: "2026-03-10T00:00:00.000Z",
        access: {
          display: {
            mode: "virtual-display",
          },
        },
        capabilities: {
          canInspect: true,
          canStart: false,
          canStop: true,
          canRestart: true,
          consoleAvailable: false,
          browserAvailable: true,
          automationAvailable: true,
          screenshotAvailable: true,
          audioAvailable: true,
        },
        resources: {},
        storage: {
          rootMode: "persistent",
        },
        network: {
          mode: "host",
        },
        lifecycle: {},
        status: {
          lastActionAt: "2026-03-10T00:00:00.000Z",
          primaryUnit: "computerd-chrome1.service",
        },
        runtime: {
          browser: "chromium",
          persistentProfile: true,
          runtimeUser: "computerd-b-chrome1",
          profileDirectory: "/var/lib/computerd/computers/chrome1/profile",
          runtimeDirectory: "/run/computerd/computers/chrome1",
          display: {
            protocol: "x11",
            mode: "virtual-display",
            viewport: {
              width: 1440,
              height: 900,
            },
          },
          automation: {
            protocol: "cdp",
            available: true,
          },
          audio: {
            protocol: "pipewire",
            isolation: "host-pipewire-user",
            available: true,
          },
          screenshot: {
            format: "png",
            available: true,
          },
        },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch as typeof globalThis.fetch;

    try {
      const exitCode = await runBrowserCli({
        argv: ["browser-info", "chrome1", "--base-url", "http://computerd.test"],
        stdout: output,
        stderr: error,
      });

      expect(exitCode).toBe(0);
      expect(output.value).toContain("name: chrome1");
      expect(output.value).toContain("viewport: 1440x900");
      expect(error.value).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("browser-connect prints the CDP websocket url", async () => {
    const output = createMemoryWriter();
    const error = createMemoryWriter();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      createJsonResponse({
        computerName: "chrome1",
        protocol: "cdp",
        connect: {
          mode: "relative-websocket-path",
          url: "/api/computers/chrome1/automation/ws",
        },
        authorization: {
          mode: "none",
        },
      }),
    ) as typeof globalThis.fetch;

    try {
      const exitCode = await runBrowserCli({
        argv: ["browser-connect", "chrome1", "--base-url", "https://computerd.example"],
        stdout: output,
        stderr: error,
      });

      expect(exitCode).toBe(0);
      expect(output.value).toContain("wss://computerd.example/api/computers/chrome1/automation/ws");
      expect(output.value).toContain("chromium.connectOverCDP");
      expect(error.value).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("browser-screenshot writes the PNG data to disk", async () => {
    const output = createMemoryWriter();
    const error = createMemoryWriter();
    const originalFetch = globalThis.fetch;
    const tempDir = await mkdtemp(join(tmpdir(), "computerd-sdk-"));
    const outputPath = join(tempDir, "chrome1.png");
    globalThis.fetch = vi.fn(async () =>
      createJsonResponse({
        computerName: "chrome1",
        format: "png",
        mimeType: "image/png",
        capturedAt: "2026-03-10T00:00:00.000Z",
        width: 1440,
        height: 900,
        dataBase64: Buffer.from("png-bytes").toString("base64"),
      }),
    ) as typeof globalThis.fetch;

    try {
      const exitCode = await runBrowserCli({
        argv: [
          "browser-screenshot",
          "chrome1",
          "--base-url",
          "http://computerd.test",
          "--out",
          outputPath,
        ],
        stdout: output,
        stderr: error,
      });

      expect(exitCode).toBe(0);
      await expect(readFile(outputPath, "utf8")).resolves.toBe("png-bytes");
      expect(output.value).toContain(`Saved screenshot to ${outputPath}`);
      expect(error.value).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns a non-zero exit code for missing computers", async () => {
    const output = createMemoryWriter();
    const error = createMemoryWriter();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      createJsonResponse(
        {
          error: "Computer missing not found.",
        },
        {
          status: 404,
          statusText: "Not Found",
        },
      ),
    ) as typeof globalThis.fetch;

    try {
      const exitCode = await runBrowserCli({
        argv: ["browser-info", "missing", "--base-url", "http://computerd.test"],
        stdout: output,
        stderr: error,
      });

      expect(exitCode).toBe(1);
      expect(error.value).toContain("Computer missing not found.");
      expect(output.value).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns a non-zero exit code for missing arguments", async () => {
    const output = createMemoryWriter();
    const error = createMemoryWriter();

    const exitCode = await runBrowserCli({
      argv: ["browser-connect"],
      stdout: output,
      stderr: error,
    });

    expect(exitCode).toBe(1);
    expect(error.value).toContain("Usage:");
    expect(output.value).toBe("");
  });
});

function createJsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: {
      "content-type": "application/json",
    },
  });
}

function createMemoryWriter() {
  let value = "";
  return {
    get value() {
      return value;
    },
    write(chunk: string) {
      value += chunk;
      return true;
    },
  };
}
