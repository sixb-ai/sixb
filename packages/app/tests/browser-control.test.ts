import { describe, expect, test } from "bun:test"
import { noopLogger } from "@sixb/core"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { createAppBrowserAgentToolProvider } from "../src/agent-tools"
import {
  appBrowserControlPath,
  appBrowserControlSecretHeader,
} from "../src/browser-control-protocol"
import { AppBrowserControlHub, handleAppBrowserControlRequest } from "../src/browser-control-server"
import { appAgentNavigationState, isAppAgentNavigation } from "../src/browser-navigation"

const sessionId = "browser_session_123456789"
const sessionSecret = "browser_secret_123456789"

function triggerMessage(browser: {
  readonly navigate: boolean
  readonly sessionId?: string
}): AgentMessageRecord {
  return {
    id: "message-1",
    projectId: "project-1",
    threadId: "thread-1",
    runId: null,
    role: "user",
    seq: 1,
    parts: [
      {
        type: "context",
        origin: "ambient",
        context: {
          kind: "app-state",
          id: "sixb-custom-app-route",
          label: "Test app",
          description: "Current app route",
          value: { browser },
        },
      },
    ],
    contentVersion: 1,
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
  }
}

test("agent navigation history state records and validates its source", () => {
  expect(isAppAgentNavigation(appAgentNavigationState())).toBe(true)
  expect(isAppAgentNavigation({ __sixbAgentNavigation: { source: "user" } })).toBe(false)
  expect(isAppAgentNavigation(null)).toBe(false)
})

describe("AppBrowserControlHub", () => {
  test("provides session-bound model tools only for a live triggering app tab", () => {
    const hub = new AppBrowserControlHub()
    const provideTools = createAppBrowserAgentToolProvider(hub)
    const message = triggerMessage({ sessionId, navigate: true })

    expect(provideTools({ triggerMessage: message })).toEqual({ tools: [], capabilities: [] })

    hub.register(sessionId, sessionSecret)
    const provision = provideTools({ triggerMessage: message })
    const tools = provision.tools
    expect(provision.capabilities).toEqual(["application-surface"])
    expect(tools.map((tool) => tool.name)).toEqual([
      "inspect_app",
      "navigate_app",
      "invoke_app_command",
    ])
    expect(tools[0]?.input).toEqual({})
    expect(tools[1]?.input).toEqual({ path: "string" })
  })

  test("does not provide tools from unrelated or non-controlling message context", () => {
    const hub = new AppBrowserControlHub()
    hub.register(sessionId, sessionSecret)
    const provideTools = createAppBrowserAgentToolProvider(hub)

    expect(provideTools({ triggerMessage: triggerMessage({ navigate: false }) })).toEqual({
      tools: [],
      capabilities: [],
    })
    expect(
      provideTools({
        triggerMessage: {
          ...triggerMessage({ sessionId, navigate: true }),
          parts: [{ type: "text", text: "Direct API request" }],
        },
      })
    ).toEqual({ tools: [], capabilities: [] })
  })

  test("dispatches a command to one tab and returns its result", async () => {
    const hub = new AppBrowserControlHub()
    hub.register(sessionId, sessionSecret)

    const resultPromise = hub.dispatch(sessionId, {
      kind: "navigate",
      path: "/customers/customer-1",
    })
    const command = await hub.poll(sessionId, sessionSecret)
    expect(command).toMatchObject({ kind: "navigate", path: "/customers/customer-1" })
    if (!command) throw new Error("Expected a browser command")

    hub.submit(sessionId, sessionSecret, {
      commandId: command.id,
      ok: true,
      value: { location: { pathname: "/customers/customer-1" } },
    })
    await expect(resultPromise).resolves.toEqual({
      location: { pathname: "/customers/customer-1" },
    })
  })

  test("delivers directly to an outstanding long poll", async () => {
    const hub = new AppBrowserControlHub()
    hub.register(sessionId, sessionSecret)

    const commandPromise = hub.poll(sessionId, sessionSecret)
    const resultPromise = hub.dispatch(sessionId, { kind: "inspect" })
    const command = await commandPromise
    expect(command?.kind).toBe("inspect")
    if (!command) throw new Error("Expected a browser command")

    hub.submit(sessionId, sessionSecret, {
      commandId: command.id,
      ok: true,
      value: { title: "Northline Operations" },
    })
    await expect(resultPromise).resolves.toEqual({ title: "Northline Operations" })
  })

  test("keeps commands isolated between browser tabs", async () => {
    const hub = new AppBrowserControlHub()
    const otherSessionId = "other_browser_session_123456"
    const otherSecret = "other_browser_secret_123456"
    hub.register(sessionId, sessionSecret)
    hub.register(otherSessionId, otherSecret)

    const firstResult = hub.dispatch(sessionId, { kind: "navigate", path: "/customers" })
    const secondResult = hub.dispatch(otherSessionId, { kind: "navigate", path: "/equipment" })
    const firstCommand = await hub.poll(sessionId, sessionSecret)
    const secondCommand = await hub.poll(otherSessionId, otherSecret)
    expect(firstCommand).toMatchObject({ kind: "navigate", path: "/customers" })
    expect(secondCommand).toMatchObject({ kind: "navigate", path: "/equipment" })
    if (!firstCommand || !secondCommand) throw new Error("Expected both browser commands")

    hub.submit(sessionId, sessionSecret, {
      commandId: firstCommand.id,
      ok: true,
      value: "/customers",
    })
    hub.submit(otherSessionId, otherSecret, {
      commandId: secondCommand.id,
      ok: true,
      value: "/equipment",
    })
    await expect(firstResult).resolves.toBe("/customers")
    await expect(secondResult).resolves.toBe("/equipment")
  })

  test("keeps the browser-only secret out of agent dispatch", async () => {
    const hub = new AppBrowserControlHub()
    hub.register(sessionId, sessionSecret)
    await expect(hub.poll(sessionId, "different_secret_123456")).rejects.toMatchObject({
      status: 401,
    })
  })

  test("does not execute a queued command after its caller cancels", async () => {
    const hub = new AppBrowserControlHub()
    hub.register(sessionId, sessionSecret)
    const controller = new AbortController()
    const pending = hub.dispatch(
      sessionId,
      {
        kind: "invoke",
        registrationId: "old-view",
        command: "setView",
        input: { view: "list" },
      },
      controller.signal
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 499 })
    // Guard check: remove the queuedIndex splice in dispatch's finishWithError.
    const pollAbort = new AbortController()
    pollAbort.abort()
    expect(await hub.poll(sessionId, sessionSecret, pollAbort.signal)).toBeNull()
  })

  test("forwards live commands and excludes omitted composer contexts from every app operation", async () => {
    const hub = new AppBrowserControlHub()
    hub.register(sessionId, sessionSecret)
    const base = triggerMessage({ sessionId, navigate: true })
    const message: AgentMessageRecord = {
      ...base,
      parts: [
        {
          type: "context",
          origin: "ambient",
          context: {
            kind: "app-state",
            id: "sixb-custom-app-route",
            label: "App",
            description: "Current app",
            value: {
              browser: { sessionId, navigate: true, offeredContext: ["app-state:dispatch"] },
            },
          },
        },
      ],
    }
    const provision = createAppBrowserAgentToolProvider(hub)({ triggerMessage: message })
    const cases = [
      { tool: "inspect_app", input: {}, kind: "inspect" },
      { tool: "navigate_app", input: { path: "/dispatch" }, kind: "navigate" },
      {
        tool: "invoke_app_command",
        input: {
          registrationId: "view-instance",
          command: "setView",
          inputJson: '{"view":"list"}',
        },
        kind: "invoke",
      },
    ]
    for (const entry of cases) {
      const tool = provision.tools.find((tool) => tool.name === entry.tool)
      if (!tool) throw new Error("Expected host tool")
      const result = tool.handler({
        input: entry.input,
        signal: new AbortController().signal,
        toolCallId: "call-1",
        run: { id: "run-1", agentId: "assistant" },
        connector: async () => {
          throw new Error("Unexpected connector")
        },
        logger: noopLogger,
        artifacts: {
          put: async () => {
            throw new Error("Unexpected artifact")
          },
        },
      })
      const command = await hub.poll(sessionId, sessionSecret)
      expect(command).toMatchObject({ kind: entry.kind, excludedContext: ["app-state:dispatch"] })
      if (!command) throw new Error("Expected command")
      if (command.kind === "invoke") expect(command.input).toEqual({ view: "list" })
      hub.submit(sessionId, sessionSecret, {
        commandId: command.id,
        ok: true,
        value: { contexts: [] },
      })
      await expect(result).resolves.toEqual({ contexts: [] })
    }
  })

  test("prunes stale browser tabs and rejects their pending commands", async () => {
    let now = 1_000
    const hub = new AppBrowserControlHub(() => now)
    hub.register(sessionId, sessionSecret)
    const pending = hub.dispatch(sessionId, { kind: "inspect" })

    now += 46_000
    hub.register("fresh_browser_session_123456", "fresh_browser_secret_123456")

    await expect(pending).rejects.toMatchObject({ status: 404 })
    await expect(hub.poll(sessionId, sessionSecret)).rejects.toMatchObject({ status: 401 })
  })
})

describe("browser control HTTP protocol", () => {
  test("registers and polls with the browser secret header", async () => {
    const hub = new AppBrowserControlHub()
    const headers = {
      "content-type": "application/json",
      [appBrowserControlSecretHeader]: sessionSecret,
    }
    const register = await handleAppBrowserControlRequest(
      new Request(`http://localhost${appBrowserControlPath}/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId }),
      }),
      hub
    )
    expect(register.status).toBe(200)

    const resultPromise = hub.dispatch(sessionId, { kind: "inspect" })
    const next = await handleAppBrowserControlRequest(
      new Request(
        `http://localhost${appBrowserControlPath}/next?sessionId=${encodeURIComponent(sessionId)}`,
        { headers }
      ),
      hub
    )
    expect(next.status).toBe(200)
    const command = (await next.json()) as { readonly id: string; readonly kind: string }
    expect(command.kind).toBe("inspect")

    const submit = await handleAppBrowserControlRequest(
      new Request(`http://localhost${appBrowserControlPath}/result`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId,
          commandId: command.id,
          ok: true,
          value: { width: 1440, height: 900 },
        }),
      }),
      hub
    )
    expect(submit.status).toBe(200)
    await expect(resultPromise).resolves.toEqual({ width: 1440, height: 900 })
  })
})
