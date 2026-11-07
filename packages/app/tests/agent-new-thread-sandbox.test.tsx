import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import type { DesktopComputerAccess } from "@sixb/client/hooks"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentChat, type AgentChatProps } from "../src/agent/agent-chat"
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
// Generated query keys carry the client's base URL, so it is set before any key is built.
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

// Radix picks its layout effect when it loads, a no-op without a `document`; see
// agent-model-auto.test.tsx.
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

const at = "2026-11-06T09:00:00.000Z"
const dana = { type: "user", id: "usr_dana" } as const
const REPOSITORY = { repositoryId: "github:repo:acme/portal", branch: "feature/login" }

function thread(id: string) {
  return {
    id,
    projectId: "proj",
    ownerPrincipal: dana,
    owner: { ...dana, displayName: "Dana Reyes" },
    participants: [],
    title: "Portal",
    status: "active",
    messageCount: 0,
    activeRunId: null,
    createdAt: at,
    updatedAt: at,
    approvalMode: "manual",
    approvalModeSource: "fallback",
  }
}

/** The bodies the chat sent: the conversations it created and the messages it posted. */
interface Sent {
  readonly threads: Record<string, unknown>[]
  readonly messages: Record<string, unknown>[]
}

function api(sent: Sent) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    const method = request.method

    if (path === "/api/agent") {
      return Response.json({ name: "Sixb", model: { provider: "gateway", modelId: "sonnet" } })
    }
    if (path === "/api/models") {
      return Response.json({
        language: [
          {
            provider: "gateway",
            modelId: "sonnet",
            name: "Sonnet",
            isDefault: true,
            publisher: { id: "anthropic", name: "Anthropic" },
            capabilities: { input: ["text"], output: ["text"], reasoning: false },
            reasoningLevels: ["provider-default"],
          },
        ],
        image: [],
        audio: { speech: [], transcription: [] },
        capabilities: { run: false },
      })
    }
    if (path === "/api/agent/preferences") {
      return Response.json({ approvalMode: "manual", approvalModeSource: "fallback" })
    }
    if (path === "/api/agent-approvals" || /^\/api\/agent-threads\/[^/]+\/approvals$/.test(path)) {
      return Response.json({ approvals: [], hasMore: false, total: 0 })
    }
    if (path === "/api/agent-threads" && method === "POST") {
      sent.threads.push((await request.json()) as Record<string, unknown>)
      return Response.json({ thread: thread("thr_new") }, { status: 201 })
    }
    if (path === "/api/agent-threads") {
      return Response.json({ threads: [], hasMore: false, total: 0 })
    }

    const [, threadId, part] = path.match(/^\/api\/agent-threads\/([^/]+)(?:\/(.+))?$/) ?? []
    if (threadId && part === undefined) return Response.json(thread(threadId))
    if (threadId && part === "messages" && method === "POST") {
      sent.messages.push((await request.json()) as Record<string, unknown>)
      return Response.json(
        {
          run: {
            id: "run_1",
            projectId: "proj",
            threadId,
            triggerMessageId: "msg_1",
            status: "queued",
            attempt: 0,
            streamId: "stream_1",
            requestedBy: dana,
            createdAt: at,
          },
        },
        { status: 202 }
      )
    }
    if (threadId && part === "messages") {
      return Response.json({ messages: [], authors: [], hasMore: false, total: 0 })
    }
    if (threadId && part === "runs") return Response.json({ runs: [], hasMore: false, total: 0 })
    if (path === "/api/object-types") return Response.json([])

    return Response.json({ error: "Not found" }, { status: 404 })
  }
}

function renderChat(props: Partial<AgentChatProps> = {}) {
  const sent: Sent = { threads: [], messages: [] }
  client.setConfig({ fetch: Object.assign(api(sent), { preconnect: fetch.preconnect }) })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: { id: dana.id, email: "dana@acme.test", displayName: "Dana Reyes", groupIds: [] },
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentChat
          threadId={null}
          onNavigateHome={() => {}}
          onNavigateThread={() => {}}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { view, sent }
}

/**
 * React DOM was imported before Happy DOM, so it sees typing through its fallback: a keyup in the
 * field that has focus.
 */
async function send(view: ReturnType<typeof render>, sent: Sent, text: string) {
  const input = await view.findByRole("textbox", { name: "Message" })
  fireEvent.focusIn(input)
  fireEvent.input(input, { target: { value: text } })
  fireEvent.keyUp(input, { key: text.at(-1) })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(sent.messages).toHaveLength(1))
}

/** A desktop app around the page that can run the agent here, with a folder chosen before. */
function desktopApp() {
  let asked = 0
  const computer: DesktopComputerAccess = {
    about: async () => ({ id: "cmp_1", name: "Ava's Mac" }),
    folders: async () => ["/work/portal"],
    pickFolder: async () => {
      asked += 1
      return null
    },
    allowFolder: async () => true,
    forgetFolder: async () => {},
  }
  browser.localStorage.setItem(
    "sixb.agent.new-thread-place",
    JSON.stringify({ cloud: false, folder: "/work/portal" })
  )
  Object.assign(globalThis, { sixbDesktop: { platform: "darwin", computer } })
  return { asked: () => asked }
}

describe("a new conversation's sandbox", () => {
  // Guard proof: drop `...(sandbox ? { sandbox } : {})` from the create body in
  // useAgentConversation; the thread is created without its repository.
  test("is created with the sandbox params the page passes", async () => {
    const { view, sent } = renderChat({ newThreadSandbox: REPOSITORY })

    await send(view, sent, "Fix the login form")

    expect(sent.threads).toEqual([{ title: "Fix the login form", sandbox: REPOSITORY }])
    expect(sent.messages[0]).toMatchObject({ text: "Fix the login form" })
  })

  test("is left out without params, as before", async () => {
    const { view, sent } = renderChat()

    await send(view, sent, "Which invoices are due?")

    expect(sent.threads).toEqual([{ title: "Which invoices are due?" }])
  })

  // Guard proof: resolve the place body whatever the sandbox; the thread is created to run on the
  // computer, which the API rejects with a sandbox.
  test("runs in the cloud, so a desktop app neither offers nor sends a folder", async () => {
    const app = desktopApp()
    const { view, sent } = renderChat({ newThreadSandbox: REPOSITORY })

    await send(view, sent, "Fix the login form")

    expect(sent.threads).toEqual([{ title: "Fix the login form", sandbox: REPOSITORY }])
    expect(app.asked()).toBe(0)
    expect(view.container.querySelector('[data-slot="composer-place"] [aria-haspopup]')).toBeNull()
  })
})

describe("a new conversation's controls", () => {
  // Guard proof: render the place line only with a place, as before; the controls never show.
  test("show under the input of a conversation not created yet", async () => {
    const { view } = renderChat({ newThreadControls: <button type="button">acme/portal</button> })

    expect(await view.findByRole("button", { name: "acme/portal" })).toBeDefined()
  })

  // Guard proof: pass the controls whatever the thread in AgentChat; they show in an open thread,
  // whose sandbox can no longer change.
  test("are gone once the conversation exists", async () => {
    const { view } = renderChat({
      threadId: "thr_1",
      newThreadControls: <button type="button">acme/portal</button>,
    })

    await view.findByRole("textbox", { name: "Message" })
    expect(view.queryByRole("button", { name: "acme/portal" })).toBeNull()
  })
})
