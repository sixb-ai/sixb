import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import {
  type DesktopComputerAccess,
  getAuthSessionQueryKey,
  listAgentComputersQueryKey,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentChat } from "../src/agent/agent-chat"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
])

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })

const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")

class FakeSocket {
  static readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

beforeAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  })
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
  browser.localStorage.clear()
  delete (globalThis as { sixbDesktop?: unknown }).sixbDesktop
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const ava = { type: "user", id: "usr_ava" } as const
const LAPTOP = {
  id: "cmp_laptop",
  name: "Ava's MacBook Pro",
  folders: ["/Users/ava/code/sixb", "/Users/ava/code/docs"],
}

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thr_1",
    projectId: "proj",
    kind: "conversation",
    ownerPrincipal: ava,
    owner: { ...ava, displayName: "Ava Chen" },
    participants: [],
    title: "Refactor auth",
    status: "active",
    messageCount: 2,
    activeRunId: null,
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:05:00.000Z",
    approvalMode: "manual",
    approvalModeSource: "fallback",
    ...overrides,
  }
}

function renderHandoffChat(
  options: {
    thread?: Record<string, unknown>
    computers?: readonly (typeof LAPTOP)[]
    messages?: readonly Record<string, unknown>[]
    runs?: readonly Record<string, unknown>[]
  } = {}
) {
  let currentThread: Record<string, unknown> = options.thread ?? makeThread()
  const requests: string[] = []
  let computerReads = 0

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const { pathname } = new URL(request.url)
    const method = request.method
    const rawBody = method === "GET" || method === "DELETE" ? "" : await request.text()
    requests.push(`${method} ${pathname}${rawBody ? ` ${rawBody}` : ""}`)

    if (pathname === "/api/agent") {
      return Response.json({ name: "Sixb", model: { provider: "gateway", modelId: "sonnet" } })
    }
    if (pathname === "/api/models") {
      return Response.json({
        language: [],
        image: [],
        audio: { speech: [], transcription: [] },
        capabilities: { run: false },
      })
    }
    if (pathname === "/api/agent/preferences") {
      return Response.json({ approvalMode: "manual", approvalModeSource: "fallback" })
    }
    if (pathname === "/api/agent-computers") {
      computerReads += 1
      return Response.json({ computers: options.computers ?? [LAPTOP] })
    }
    if (pathname === "/api/agent-approvals" || pathname === "/api/agent-threads/thr_1/approvals") {
      return Response.json({ approvals: [], hasMore: false, total: 0 })
    }
    if (pathname === "/api/agent-threads") {
      return Response.json({ threads: [currentThread], hasMore: false, total: 1 })
    }
    if (pathname === "/api/agent-threads/thr_1") {
      return Response.json(currentThread)
    }
    if (pathname === "/api/agent-threads/thr_1/messages") {
      return Response.json({
        messages: options.messages ?? [
          {
            id: "msg_1",
            projectId: "proj",
            threadId: "thr_1",
            runId: null,
            role: "user",
            authorPrincipal: ava,
            seq: 1,
            parts: [{ type: "text", text: "Start in cloud" }],
            annotations: [],
            contentVersion: 1,
            createdAt: "2026-11-14T10:00:00.000Z",
          },
          {
            id: "msg_2",
            projectId: "proj",
            threadId: "thr_1",
            runId: "run_1",
            role: "assistant",
            seq: 2,
            parts: [{ type: "text", text: "Ready." }],
            annotations: [],
            contentVersion: 1,
            createdAt: "2026-11-14T10:01:00.000Z",
          },
        ],
        authors: [],
        hasMore: false,
        total: 2,
      })
    }
    if (pathname === "/api/agent-threads/thr_1/runs") {
      return Response.json({
        runs: options.runs ?? [
          {
            id: "run_1",
            projectId: "proj",
            kind: "conversation",
            threadId: "thr_1",
            triggerMessageId: "msg_1",
            status: "succeeded",
            attempt: 1,
            streamId: "stream_1",
            requestedBy: ava,
            createdAt: "2026-11-14T10:00:00.000Z",
          },
        ],
        hasMore: false,
        total: 1,
      })
    }
    if (pathname === "/api/agent-threads/thr_1/computer" && method === "POST") {
      const { computer } = JSON.parse(rawBody) as {
        computer: { id: string; name: string; folder: string }
      }
      currentThread = {
        ...currentThread,
        runsOn: "computer",
        computer: { ...computer, online: true },
        movedAt: "2026-11-14T10:10:00.000Z",
      }
      return Response.json(currentThread)
    }
    if (pathname === "/api/agent-threads/thr_1/computer" && method === "DELETE") {
      const { runsOn: _runsOn, computer: _computer, ...cloud } = currentThread
      currentThread = { ...cloud, movedAt: "2026-11-14T10:15:00.000Z" }
      return Response.json(currentThread)
    }
    if (pathname === "/api/object-types") return Response.json([])
    return Response.json({ error: "Not found" }, { status: 404 })
  }

  client.setConfig({ fetch: Object.assign(fetchMock, { preconnect: fetch.preconnect }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: { id: ava.id, email: "ava@sixb.test", displayName: "Ava Chen", groupIds: [] },
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentChat threadId="thr_1" onNavigateHome={() => {}} onNavigateThread={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { view, requests, queryClient, computerReads: () => computerReads }
}

describe("moving an existing conversation between cloud and local computer", () => {
  // Guard proof: enable listAgentComputers eagerly in useThreadPlace; mounting any open thread in a
  // browser queries /api/agent-computers before the user opens the place menu.
  test("queries connected computers lazily and moves Cloud -> Computer -> Cloud -> Computer", async () => {
    const { view, requests, queryClient, computerReads } = renderHandoffChat()

    expect(await view.findByText("Ready.")).toBeDefined()
    expect(computerReads()).toBe(0)
    expect(queryClient.getQueryState(listAgentComputersQueryKey())?.fetchStatus ?? "idle").toBe(
      "idle"
    )

    // Open the Cloud pill in the header -> fetches connected computers and lists folders.
    const cloudButton = view.getByRole("button", { name: /Runs in Cloud/ })
    fireEvent.click(cloudButton)
    await waitFor(() => expect(computerReads()).toBe(1))

    const dialog = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    fireEvent.click(dialog.getByTitle("~/code/sixb"))

    await waitFor(() =>
      expect(
        requests.some((entry) => entry.startsWith("POST /api/agent-threads/thr_1/computer "))
      ).toBe(true)
    )
    expect(await view.findByText("Ava's MacBook Pro")).toBeDefined()
    expect(view.getByText("· ~/…/sixb")).toBeDefined()
    expect(
      await view.findByText("Moved to ~/code/sixb. Files from before stayed in the cloud.")
    ).toBeDefined()

    // Move Computer -> Cloud from the header control.
    fireEvent.click(view.getByRole("button", { name: /Runs in Ava's MacBook Pro/ }))
    const onComputerMenu = within(
      await view.findByRole("dialog", { name: "Where this conversation runs" })
    )
    fireEvent.click(onComputerMenu.getByText("Cloud"))

    await waitFor(() => expect(requests).toContain("DELETE /api/agent-threads/thr_1/computer"))
    expect(await view.findByRole("button", { name: /Runs in Cloud/ })).toBeDefined()

    // Move Cloud -> Computer (another folder) again.
    fireEvent.click(view.getByRole("button", { name: /Runs in Cloud/ }))
    const thirdMenu = within(
      await view.findByRole("dialog", { name: "Where this conversation runs" })
    )
    fireEvent.click(thirdMenu.getByTitle("~/code/docs"))
    expect(await view.findByText("· ~/…/docs")).toBeDefined()
  })

  test("lets Sixb Desktop pick a new folder and move a cloud conversation into it", async () => {
    const desktop: DesktopComputerAccess = {
      about: async () => ({ id: "cmp_mac", name: "Ava's Mac" }),
      folders: async () => [],
      pickFolder: async () => "/Users/ava/projects/api",
      allowFolder: async () => true,
      forgetFolder: async () => {},
    }
    Object.assign(globalThis, { sixbDesktop: { platform: "darwin", computer: desktop } })

    const { view, requests } = renderHandoffChat()
    expect(await view.findByText("Ready.")).toBeDefined()

    fireEvent.click(view.getByRole("button", { name: /Runs in Cloud/ }))
    const menu = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    fireEvent.click(menu.getByText("Choose a folder…"))

    await waitFor(() =>
      expect(requests).toContain(
        'POST /api/agent-threads/thr_1/computer {"computer":{"id":"cmp_mac","name":"Ava\'s Mac","folder":"/Users/ava/projects/api"}}'
      )
    )
    expect(await view.findByText("Ava's Mac")).toBeDefined()
    expect(view.getByText("· ~/…/api")).toBeDefined()
  })

  test("shows every handoff marker across multi-hop cloud and computer turns", async () => {
    const { view } = renderHandoffChat({
      thread: makeThread({
        runsOn: "computer",
        computer: {
          id: "cmp_laptop",
          name: "Ava's MacBook Pro",
          folder: "/Users/ava/code/sixb",
          online: true,
        },
        movedAt: "2026-11-14T10:08:00.000Z",
      }),
      messages: [
        {
          id: "msg_1",
          projectId: "proj",
          threadId: "thr_1",
          runId: null,
          role: "user",
          authorPrincipal: ava,
          seq: 1,
          parts: [{ type: "text", text: "Turn 1 in cloud" }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:00:00.000Z",
        },
        {
          id: "msg_2",
          projectId: "proj",
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          seq: 2,
          parts: [{ type: "text", text: "Cloud answer." }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:01:00.000Z",
        },
        {
          id: "msg_3",
          projectId: "proj",
          threadId: "thr_1",
          runId: null,
          role: "user",
          authorPrincipal: ava,
          seq: 3,
          parts: [{ type: "text", text: "Turn 2 on laptop" }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:03:00.000Z",
        },
        {
          id: "msg_4",
          projectId: "proj",
          threadId: "thr_1",
          runId: "run_2",
          role: "assistant",
          seq: 4,
          parts: [{ type: "text", text: "Laptop answer." }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:04:00.000Z",
        },
        {
          id: "msg_5",
          projectId: "proj",
          threadId: "thr_1",
          runId: null,
          role: "user",
          authorPrincipal: ava,
          seq: 5,
          parts: [{ type: "text", text: "Turn 3 back in cloud" }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:06:00.000Z",
        },
        {
          id: "msg_6",
          projectId: "proj",
          threadId: "thr_1",
          runId: "run_3",
          role: "assistant",
          seq: 6,
          parts: [{ type: "text", text: "Second cloud answer." }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:07:00.000Z",
        },
      ],
      runs: [
        {
          id: "run_3",
          projectId: "proj",
          kind: "conversation",
          threadId: "thr_1",
          triggerMessageId: "msg_5",
          status: "succeeded",
          attempt: 1,
          streamId: "s3",
          requestedBy: ava,
          createdAt: "2026-11-14T10:06:00.000Z",
        },
        {
          id: "run_2",
          projectId: "proj",
          kind: "conversation",
          threadId: "thr_1",
          triggerMessageId: "msg_3",
          runsOn: "computer",
          status: "succeeded",
          attempt: 1,
          streamId: "s2",
          requestedBy: ava,
          createdAt: "2026-11-14T10:03:00.000Z",
        },
        {
          id: "run_1",
          projectId: "proj",
          kind: "conversation",
          threadId: "thr_1",
          triggerMessageId: "msg_1",
          status: "succeeded",
          attempt: 1,
          streamId: "s1",
          requestedBy: ava,
          createdAt: "2026-11-14T10:00:00.000Z",
        },
      ],
    })

    expect(
      await view.findByText("Moved to the computer. Files from before stayed in the cloud.")
    ).toBeDefined()
    expect(
      view.getByText("Moved to the cloud. Files from before stayed on the computer.")
    ).toBeDefined()
    expect(
      view.getByText("Moved to ~/code/sixb. Files from before stayed in the cloud.")
    ).toBeDefined()
  })
})
