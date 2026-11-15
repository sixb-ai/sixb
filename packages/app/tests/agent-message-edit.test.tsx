import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentChat } from "../src/agent/agent-chat"
import { formatMessageTimeAgo } from "../src/agent/format"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
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
])

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })

const sockets: FakeSocket[] = []
const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor() {
    sockets.push(this)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
  }

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

const copiedText: string[] = []

beforeAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copiedText.push(text)
      },
    },
  })
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
  sockets.length = 0
  copiedText.length = 0
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
  if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard)
})

const dana = { type: "user", id: "usr_dana" } as const
const sam = { type: "user", id: "usr_sam" } as const

const users = {
  dana: { id: dana.id, email: "dana@acme.test", displayName: "Dana Reyes", groupIds: [] },
  sam: { id: sam.id, email: "sam@acme.test", displayName: "Sam Ortiz", groupIds: [] },
}

const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString()
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000).toISOString()

const baseMsg = { projectId: "proj", threadId: "thr_1", annotations: [], contentVersion: 1 }

function defaultMessages() {
  return [
    {
      ...baseMsg,
      id: "msg_1",
      runId: null,
      role: "user",
      authorPrincipal: dana,
      seq: 1,
      createdAt: threeDaysAgo,
      parts: [
        {
          type: "context",
          origin: "explicit",
          context: {
            kind: "object",
            ref: { objectTypeId: "Organization", primaryId: "org_acme" },
            label: "Acme Corp",
          },
        },
        {
          type: "text",
          text: "outlook message from unknow people blocks the images and attachments. how can i resolve this?",
        },
      ],
    },
    {
      ...baseMsg,
      id: "msg_2",
      runId: "run_1",
      role: "assistant",
      seq: 2,
      createdAt: threeDaysAgo,
      parts: [{ type: "text", text: "Outlook blocks external images by default." }],
    },
    {
      ...baseMsg,
      id: "msg_3",
      runId: null,
      role: "user",
      authorPrincipal: dana,
      seq: 3,
      createdAt: oneHourAgo,
      parts: [{ type: "text", text: "Can we whitelist one domain?" }],
    },
    {
      ...baseMsg,
      id: "msg_4",
      runId: "run_2",
      role: "assistant",
      seq: 4,
      createdAt: oneHourAgo,
      parts: [{ type: "text", text: "Yes, add the domain to Safe Senders." }],
    },
  ]
}

interface Scenario {
  thread: Record<string, unknown>
  messages: Record<string, unknown>[]
  runs: Record<string, unknown>[]
  failEditStatus?: number
  editGate?: Promise<void>
}

function renderChat(as: "dana" | "sam" = "dana", overrides: Partial<Scenario> = {}) {
  const state: Scenario = {
    thread: {
      id: "thr_1",
      projectId: "proj",
      kind: "conversation",
      ownerPrincipal: dana,
      owner: { ...dana, displayName: "Dana Reyes" },
      participants: [],
      title: "Outlook images",
      status: "active",
      messageCount: 4,
      activeRunId: null,
      createdAt: threeDaysAgo,
      updatedAt: oneHourAgo,
      approvalMode: "auto",
      approvalModeSource: "fallback",
    },
    messages: defaultMessages(),
    runs: [
      {
        id: "run_2",
        projectId: "proj",
        kind: "conversation",
        threadId: "thr_1",
        triggerMessageId: "msg_3",
        status: "succeeded",
        attempt: 1,
        streamId: "stream_2",
        requestedBy: dana,
        createdAt: oneHourAgo,
      },
    ],
    ...overrides,
  }

  const requests: { method: string; path: string; body: unknown }[] = []
  client.setConfig({
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        const method = req.method
        const text = method === "GET" ? "" : await req.text()
        const parsed = text ? JSON.parse(text) : undefined
        requests.push({ method, path: url.pathname, body: parsed })

        if (url.pathname === "/api/agent") {
          return Response.json({ name: "Sixb", model: { provider: "test", modelId: "fast" } })
        }
        if (url.pathname === "/api/models") {
          return Response.json({
            language: [],
            audio: { speech: [], transcription: [] },
            capabilities: { run: false },
          })
        }
        if (url.pathname === "/api/agent/preferences") {
          return Response.json({ approvalMode: "auto", approvalModeSource: "fallback" })
        }
        if (url.pathname === "/api/agent-approvals") {
          return Response.json({ approvals: [], hasMore: false, total: 0 })
        }
        if (url.pathname === "/api/agent-threads") {
          return Response.json({ threads: [state.thread], hasMore: false, total: 1 })
        }
        if (url.pathname === "/api/agent-threads/thr_1") {
          return Response.json(state.thread)
        }
        if (url.pathname === "/api/agent-threads/thr_1/messages" && method === "GET") {
          return Response.json({
            messages: state.messages,
            authors: [
              { ...dana, displayName: "Dana Reyes" },
              { ...sam, displayName: "Sam Ortiz" },
            ],
            hasMore: false,
            total: state.messages.length,
          })
        }
        if (url.pathname === "/api/agent-threads/thr_1/runs") {
          return Response.json({ runs: state.runs, hasMore: false, total: state.runs.length })
        }
        if (url.pathname === "/api/agent-threads/thr_1/approvals") {
          return Response.json({ approvals: [], hasMore: false, total: 0 })
        }
        if (url.pathname === "/api/agent-threads/thr_1/cancel") {
          state.thread = { ...state.thread, activeRunId: null }
          state.runs = state.runs.map((r) => ({ ...r, status: "cancelled" }))
          return Response.json({ run: state.runs[0] }, { status: 202 })
        }
        const editMatch = url.pathname.match(
          /^\/api\/agent-threads\/thr_1\/messages\/([^/]+)\/edit$/
        )
        if (editMatch && method === "POST") {
          if (state.editGate) await state.editGate
          if (state.failEditStatus) {
            return Response.json(
              { error: "Server refused edit", code: "invalid_message" },
              { status: state.failEditStatus }
            )
          }
          const editedId = editMatch[1]!
          const cutIndex = state.messages.findIndex((m) => m.id === editedId)
          const kept = cutIndex === -1 ? state.messages : state.messages.slice(0, cutIndex)
          const bodyObj = parsed as { text?: string; context?: unknown[] }
          const nextMsgId = `${editedId}_edited`
          state.messages = [
            ...kept,
            {
              ...baseMsg,
              id: nextMsgId,
              runId: null,
              role: "user",
              authorPrincipal: users[as] ? { type: "user", id: users[as].id } : dana,
              seq: kept.length + 1,
              createdAt: new Date().toISOString(),
              parts: [
                ...((bodyObj.context ?? []).map((entry) => ({
                  type: "context",
                  ...(entry as object),
                })) as unknown[]),
                ...(bodyObj.text ? [{ type: "text", text: bodyObj.text }] : []),
              ],
            },
          ]
          const newRun = {
            id: "run_edited",
            projectId: "proj",
            kind: "conversation",
            threadId: "thr_1",
            triggerMessageId: nextMsgId,
            status: "queued",
            attempt: 0,
            streamId: "stream_edited",
            requestedBy: dana,
            createdAt: new Date().toISOString(),
          }
          state.runs = [newRun, ...state.runs]
          state.thread = { ...state.thread, activeRunId: "run_edited" }
          return Response.json({ run: newRun }, { status: 202 })
        }
        if (url.pathname === "/api/object-types") return Response.json([])

        return Response.json({ error: "Not found" }, { status: 404 })
      },
      { preconnect: fetch.preconnect }
    ),
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: users[as],
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentChat
          threadId="thr_1"
          onNavigateHome={() => {}}
          onNavigateThread={() => {}}
          onOpenThreads={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { view, state, requests }
}

function typeIn(field: HTMLElement, value: string) {
  fireEvent.focusIn(field)
  fireEvent.input(field, { target: { value } })
  fireEvent.change(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) ?? "a" })
}

describe("user message hover actions and in-place rewind UX", () => {
  test("formats spoken relative message timestamps", () => {
    const now = new Date().toISOString()
    expect(formatMessageTimeAgo(now, "en", "just now")).toBe("just now")
    expect(formatMessageTimeAgo(threeDaysAgo, "en", "just now")).toBe("3 days ago")
    expect(formatMessageTimeAgo(threeDaysAgo, "fr", "à l’instant")).toContain("3")
  })

  test("renders time ago, edit, and copy actions under user messages and copies text cleanly", async () => {
    // Guard proof: omit data-user-message-actions or copy handler in UserMessage.
    const { view } = renderChat("dana")
    await view.findByText(/outlook message from unknow people/)

    const times = view.container.querySelectorAll("[data-user-message-age]")
    expect(times[0]?.textContent).toBe("3 days ago")
    expect(times[1]?.textContent).toBe("1 hour ago")

    const copyButtons = view.getAllByRole("button", { name: "Copy message" })
    expect(copyButtons).toHaveLength(2)

    await act(async () => {
      fireEvent.click(copyButtons[0]!)
    })
    await waitFor(() =>
      expect(copiedText).toEqual([
        "outlook message from unknow people blocks the images and attachments. how can i resolve this?",
      ])
    )
    expect(view.getByRole("button", { name: "Copied" })).toBeDefined()
  })

  test("edits an earlier message inline, preserves bottom draft, and rewinds later turns immediately", async () => {
    // Guard proof: omit replacesMessageId slicing in conversationMessages; "Safe Senders" stays on
    // screen after saving the edit on msg_1.
    let releaseEdit!: () => void
    const editGate = new Promise<void>((resolve) => {
      releaseEdit = resolve
    })
    const { view, requests } = renderChat("dana", { editGate })
    await view.findByText("Yes, add the domain to Safe Senders.")

    // Type an unsent draft in the bottom composer first: inline editing above must not clobber it.
    const bottomComposer = view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
    typeIn(bottomComposer, "My unsent bottom draft")
    expect(bottomComposer.value).toBe("My unsent bottom draft")

    const editButtons = view.getAllByRole("button", { name: "Edit message" })
    expect(editButtons).toHaveLength(2)

    // Open inline editor on msg_1, press Escape to cancel, then reopen and submit.
    fireEvent.click(editButtons[0]!)
    const inlineInput = (await view.findByRole("textbox", {
      name: "Edit message",
    })) as HTMLTextAreaElement
    expect(inlineInput.value).toContain("unknow people")

    fireEvent.keyDown(inlineInput, { key: "Escape" })
    expect(view.queryByRole("textbox", { name: "Edit message" })).toBeNull()

    fireEvent.click(view.getAllByRole("button", { name: "Edit message" })[0]!)
    const reopened = (await view.findByRole("textbox", {
      name: "Edit message",
    })) as HTMLTextAreaElement
    typeIn(
      reopened,
      "outlook message from unknown people blocks images and attachments. how can i resolve this?"
    )

    fireEvent.click(view.getByRole("button", { name: "Save" }))

    // Optimistic rewind happens immediately before the API gate even resolves!
    expect(view.queryByText("Yes, add the domain to Safe Senders.")).toBeNull()
    expect(view.queryByText("Can we whitelist one domain?")).toBeNull()
    expect(
      view.getByText(
        "outlook message from unknown people blocks images and attachments. how can i resolve this?"
      )
    ).toBeDefined()
    expect(bottomComposer.value).toBe("My unsent bottom draft")

    await act(async () => {
      releaseEdit()
    })

    await waitFor(() =>
      expect(
        requests.find((r) => r.path === "/api/agent-threads/thr_1/messages/msg_1/edit")
      ).toMatchObject({
        method: "POST",
        body: {
          text: "outlook message from unknown people blocks images and attachments. how can i resolve this?",
          context: [
            {
              origin: "explicit",
              context: {
                kind: "object",
                ref: { objectTypeId: "Organization", primaryId: "org_acme" },
                label: "Acme Corp",
              },
            },
          ],
        },
      })
    )
  })

  test("stops an active run automatically when saving an edit on an earlier message", async () => {
    // Guard proof: omit stoppedActive cancelRun in editMessage; POST /edit fires without /cancel.
    const { view, requests } = renderChat("dana", {
      thread: {
        id: "thr_1",
        projectId: "proj",
        kind: "conversation",
        ownerPrincipal: dana,
        owner: { ...dana, displayName: "Dana Reyes" },
        participants: [],
        title: "Outlook images",
        status: "active",
        messageCount: 3,
        activeRunId: "run_active",
        createdAt: threeDaysAgo,
        updatedAt: oneHourAgo,
        approvalMode: "auto",
        approvalModeSource: "fallback",
      },
      runs: [
        {
          id: "run_active",
          projectId: "proj",
          kind: "conversation",
          threadId: "thr_1",
          triggerMessageId: "msg_3",
          status: "running",
          attempt: 1,
          streamId: "stream_active",
          requestedBy: dana,
          createdAt: oneHourAgo,
        },
      ],
    })

    await view.findByText(/outlook message from unknow people/)
    const editButtons = view.getAllByRole("button", { name: "Edit message" })
    fireEvent.click(editButtons[0]!)

    const editor = await view.findByRole("textbox", { name: "Edit message" })
    typeIn(editor, "Updated first question while streaming")
    fireEvent.keyDown(editor, { key: "Enter" })

    await waitFor(() => {
      const paths = requests.filter((r) => r.method === "POST").map((r) => r.path)
      expect(paths).toEqual([
        "/api/agent-threads/thr_1/cancel",
        "/api/agent-threads/thr_1/messages/msg_1/edit",
      ])
    })
  })

  test("restores the inline editor draft and transcript when an edit request fails", async () => {
    const { view } = renderChat("dana", { failEditStatus: 500 })
    await view.findByText("Yes, add the domain to Safe Senders.")

    fireEvent.click(view.getAllByRole("button", { name: "Edit message" })[0]!)
    const editor = await view.findByRole("textbox", { name: "Edit message" })
    typeIn(editor, "Draft that must not be lost")
    fireEvent.click(view.getByRole("button", { name: "Save" }))

    const restored = (await view.findByRole("textbox", {
      name: "Edit message",
    })) as HTMLTextAreaElement
    expect(restored.value).toBe("Draft that must not be lost")
    expect(view.getByText("Yes, add the domain to Safe Senders.")).toBeDefined()
    expect(view.getByRole("alert").textContent).toContain("Couldn't edit your message.")
  })

  test("shows edit only on messages a shared-thread participant is allowed to rewind", async () => {
    const { view } = renderChat("sam", {
      thread: {
        id: "thr_1",
        projectId: "proj",
        kind: "conversation",
        ownerPrincipal: dana,
        owner: { ...dana, displayName: "Dana Reyes" },
        participants: [
          { principal: { ...sam, displayName: "Sam Ortiz" }, addedAt: oneHourAgo, addedBy: dana },
        ],
        title: "Shared thread",
        status: "active",
        messageCount: 3,
        activeRunId: null,
        createdAt: threeDaysAgo,
        updatedAt: oneHourAgo,
        approvalMode: "auto",
        approvalModeSource: "fallback",
      },
      messages: [
        {
          ...baseMsg,
          id: "m_sam_early",
          runId: null,
          role: "user",
          authorPrincipal: sam,
          seq: 1,
          createdAt: threeDaysAgo,
          parts: [{ type: "text", text: "Sam early message" }],
        },
        {
          ...baseMsg,
          id: "m_dana_mid",
          runId: null,
          role: "user",
          authorPrincipal: dana,
          seq: 2,
          createdAt: oneHourAgo,
          parts: [{ type: "text", text: "Dana middle message" }],
        },
        {
          ...baseMsg,
          id: "m_sam_last",
          runId: null,
          role: "user",
          authorPrincipal: sam,
          seq: 3,
          createdAt: oneHourAgo,
          parts: [{ type: "text", text: "Sam trailing message" }],
        },
      ],
    })

    await view.findByText("Sam trailing message")
    // Sam can copy all 3 messages, but can only edit his own trailing message (not Dana's, nor his
    // early message before Dana's).
    expect(view.getAllByRole("button", { name: "Copy message" })).toHaveLength(3)
    const editButtons = view.getAllByRole("button", { name: "Edit message" })
    expect(editButtons).toHaveLength(1)

    fireEvent.click(editButtons[0]!)
    const editor = (await view.findByRole("textbox", {
      name: "Edit message",
    })) as HTMLTextAreaElement
    expect(editor.value).toBe("Sam trailing message")
  })
})
