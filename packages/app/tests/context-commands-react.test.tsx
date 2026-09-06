import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { AgentContextProvider, useAgentContext } from "@sixb/agent-ui"
import { useAgentContextRegistry, useRegisteredAgentContext } from "@sixb/agent-ui/internal/context"
import { type AgentContextInput, agentContext, noopLogger, stringEnum } from "@sixb/core"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { Window } from "happy-dom"
import { StrictMode, useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { createAppBrowserAgentToolProvider } from "../src/agent-tools"
import { AppAgentContextProvider } from "../src/browser-control-react"
import { AppBrowserControlHub, handleAppBrowserControlRequest } from "../src/browser-control-server"

const browser = new Window({ url: "https://app.sixb.test/" })
const globals = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()

beforeAll(() => {
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window"
          ? browser
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : Reflect.get(browser, key),
    })
  }
})
afterEach(cleanup)
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})

describe("component-owned agent commands", () => {
  test("host tools operate the rendered view through browser polling and return its committed state", async () => {
    const hub = new AppBrowserControlHub()
    const request = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (typeof url !== "string") throw new Error("Expected a browser-control URL")
          return handleAppBrowserControlRequest(
            new Request(new URL(url, browser.location.href), init),
            hub
          )
        },
        { preconnect: fetch.preconnect }
      )
    )
    let contexts: readonly AgentContextInput[] = []
    function Bridge() {
      contexts = useRegisteredAgentContext()
      return null
    }
    function View() {
      const [availableOnly, setAvailableOnly] = useState(false)
      useAgentContext(
        agentContext.appState("dispatch", {
          label: "Dispatch",
          description: "Schedule filter",
          value: { availableOnly },
        }),
        {
          commands: {
            filter: {
              description: "Filter available technicians",
              input: { availableOnly: "boolean" },
              run: (input) => setAvailableOnly(input.availableOnly),
            },
          },
        }
      )
      return <output data-testid="filter">{String(availableOnly)}</output>
    }
    try {
      const page = render(
        <MemoryRouter>
          <AppAgentContextProvider browserControl routePaths={["/"]}>
            <Bridge />
            <View />
          </AppAgentContextProvider>
        </MemoryRouter>
      )
      const message = (): AgentMessageRecord => ({
        id: "message",
        projectId: "project",
        threadId: "thread",
        runId: null,
        role: "user",
        seq: 1,
        contentVersion: 1,
        createdAt: new Date("2026-09-05T12:00:00Z"),
        parts: contexts.map((context) => ({ type: "context", origin: "ambient", context })),
      })
      const provide = createAppBrowserAgentToolProvider(hub)
      await waitFor(() => expect(provide({ triggerMessage: message() }).tools).toHaveLength(3))
      const route = contexts.find(
        (context) => context.kind === "app-state" && context.id === "sixb-custom-app-route"
      )
      expect(route).toMatchObject({
        value: { browser: { offeredContext: ["app-state:dispatch"] } },
      })
      const tools = provide({ triggerMessage: message() }).tools
      const call = (name: string, input: Record<string, unknown>) => {
        const tool = tools.find((tool) => tool.name === name)
        if (!tool) throw new Error("Expected a host tool")
        return tool.handler({
          input,
          signal: new AbortController().signal,
          toolCallId: "call",
          run: { id: "run", agentId: "assistant" },
          logger: noopLogger,
          connector: async () => {
            throw new Error("Unexpected connector")
          },
          artifacts: {
            put: async () => {
              throw new Error("Unexpected artifact")
            },
          },
        })
      }
      const inspected = await call("inspect_app", {})
      // This crosses the real JSON transport; narrow just the fields needed for the next command.
      const entries = Reflect.get(inspected as object, "contexts") as {
        registrationId: string
        identity: string
      }[]
      const dispatch = entries.find((entry) => entry.identity === "app-state:dispatch")
      if (!dispatch) throw new Error("Expected mounted Dispatch context")
      const pending = call("invoke_app_command", {
        registrationId: dispatch.registrationId,
        command: "filter",
        inputJson: '{"availableOnly":true}',
      })
      await waitFor(() => expect(page.getByTestId("filter").textContent).toBe("true"))
      const result = await pending
      expect(result).toMatchObject({
        contexts: expect.arrayContaining([
          expect.objectContaining({
            identity: "app-state:dispatch",
            context: expect.objectContaining({ value: { availableOnly: true } }),
          }),
        ]),
      })
    } finally {
      cleanup()
      await Bun.sleep(0)
      request.mockRestore()
    }
  })

  test("manual and agent changes share state, handlers see current props, and unmount revokes the binding", async () => {
    let registry: ReturnType<typeof useAgentContextRegistry> | undefined
    function Bridge() {
      registry = useAgentContextRegistry()
      const context = useRegisteredAgentContext()
      return <output data-testid="context">{JSON.stringify(context)}</output>
    }
    function View({ suffix }: { suffix: string }) {
      const [view, setView] = useState("timeline")
      const [lastLabel, setLastLabel] = useState("")
      useAgentContext(
        agentContext.appState("dispatch", {
          label: "Dispatch",
          description: "Current schedule",
          value: { view },
        }),
        {
          commands: {
            setView: {
              description: "Set the view",
              input: { view: stringEnum(["timeline", "list"]) },
              run(input) {
                setView(input.view)
                setLastLabel(`${input.view}:${suffix}`)
              },
            },
          },
        }
      )
      return (
        <>
          <button type="button" onClick={() => setView("list")}>
            List
          </button>
          <output data-testid="view">{view}</output>
          <output data-testid="label">{lastLabel}</output>
        </>
      )
    }
    const tree = (suffix: string, mounted = true) => (
      <StrictMode>
        <AgentContextProvider>
          <Bridge />
          {mounted && <View suffix={suffix} />}
        </AgentContextProvider>
      </StrictMode>
    )
    const page = render(tree("first"))
    if (!registry) throw new Error("Expected a context registry")
    const live = registry
    const registrationId = live.inspect()[0]!.registrationId
    fireEvent.click(page.getByText("List"))
    expect(live.inspect()[0]?.context).toMatchObject({ value: { view: "list" } })
    expect(live.inspect()[0]?.registrationId).toBe(registrationId)

    // Guard check: capture the initial handler instead of reading optionsRef.current in the hook.
    page.rerender(tree("updated"))
    await act(async () => {
      await live.invoke({
        registrationId,
        command: "setView",
        input: { view: "timeline" },
        excluded: [],
        signal: new AbortController().signal,
      })
    })
    expect(page.getByTestId("view").textContent).toBe("timeline")
    expect(page.getByTestId("label").textContent).toBe("timeline:updated")
    expect(page.getByTestId("context").textContent).not.toContain("commands")

    page.rerender(tree("updated", false))
    expect(live.inspect()).toEqual([])
    await expect(
      live.invoke({
        registrationId,
        command: "setView",
        input: { view: "list" },
        excluded: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("no longer available")
  })
})
