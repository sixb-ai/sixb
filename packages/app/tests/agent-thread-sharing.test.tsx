import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentChat } from "../src/agent/agent-chat"
import { useAgentConversation } from "../src/agent/hooks/use-agent-conversation"
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
])

const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })

/** Sockets the chat opens; a test plays the server by calling their handlers. */
const sockets: FakeSocket[] = []
const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")

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

// Radix picks its layout effect when it loads, a no-op without a `document`, and its dialogs then
// never mount. This file or another of the run loads it before the window exists, so it is given
// React's own, and its own back after the file.
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
  // A dialog's focus scope lets go a tick after it unmounts: unmount here, while the window is
  // still there, and let it.
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
  sockets.length = 0
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const
const at = "2026-10-21T09:00:00.000Z"

function account(principal: typeof alice | typeof bob, displayName: string) {
  return { id: principal.id, email: `${principal.id}@example.com`, displayName, groupIds: [] }
}

const users = {
  alice: account(alice, "Alice Martin"),
  bob: account(bob, "Bob Durand"),
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thr_1",
    projectId: "proj",
    ownerPrincipal: alice,
    owner: { ...alice, displayName: "Alice Martin" },
    participants: [
      { principal: { ...bob, displayName: "Bob Durand" }, addedAt: at, addedBy: alice },
    ],
    title: "Slipped deals",
    status: "active",
    messageCount: 3,
    activeRunId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

const message = {
  projectId: "proj",
  threadId: "thr_1",
  annotations: [],
  contentVersion: 1,
  createdAt: at,
}

const messages = [
  {
    ...message,
    id: "msg_1",
    runId: null,
    role: "user",
    authorPrincipal: alice,
    seq: 1,
    parts: [{ type: "text", text: "Which deals slipped?" }],
  },
  {
    ...message,
    id: "msg_2",
    runId: "run_1",
    role: "assistant",
    seq: 2,
    parts: [{ type: "text", text: "Three deals slipped." }],
  },
  {
    ...message,
    id: "msg_3",
    runId: null,
    role: "user",
    authorPrincipal: bob,
    seq: 3,
    parts: [{ type: "text", text: "Why did Acme slip?" }],
  },
]

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    projectId: "proj",
    threadId: "thr_1",
    triggerMessageId: "msg_1",
    status: "succeeded",
    attempt: 0,
    streamId: "stream_1",
    requestedBy: alice,
    createdAt: at,
    ...overrides,
  }
}

/** What the API answers; a test changes it between reads. */
interface Scenario {
  thread: Record<string, unknown>
  messages: readonly Record<string, unknown>[]
  runs: readonly Record<string, unknown>[]
  shared: readonly Record<string, unknown>[]
  sharedTotal?: number
  sharedHasMore: boolean
  sharedStatus: number
  ownHasMore: boolean
  threadStatus: number
  messagesStatus?: number
  /** How a posted message is refused, and what the thread looks like once it is. */
  postError: { readonly status: number; readonly code: string }
  afterPost?: () => void
  shareStatus: number
  retryStatus: number
  /** Holds the fork's answer until the test lets it go. */
  forkGate?: Promise<void>
}

function api(scenario: Scenario, requests: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const method = request.method
    const body = method === "GET" ? "" : await request.text()
    requests.push(`${method} ${url.pathname}${url.search}${body ? ` ${body}` : ""}`)

    if (url.pathname === "/api/agent") {
      return Response.json({ name: "Sixb", model: { provider: "test", modelId: "fast" } })
    }
    if (url.pathname === "/api/models") return Response.json({ language: [] })
    if (url.pathname === "/api/artifacts") return Response.json({ artifacts: [] })

    if (url.pathname === "/api/agent-threads") {
      if (url.searchParams.get("sharedWithMe") !== "true") {
        return Response.json({ threads: [], hasMore: scenario.ownHasMore, total: 0 })
      }
      if (scenario.sharedStatus !== 200) {
        return Response.json({ error: "[Sixb] unavailable" }, { status: scenario.sharedStatus })
      }
      return Response.json({
        threads: scenario.shared,
        hasMore: scenario.sharedHasMore,
        total: scenario.sharedTotal ?? scenario.shared.length,
      })
    }

    if (url.pathname === "/api/agent-threads/thr_1") {
      if (scenario.threadStatus !== 200) {
        return Response.json({ error: "Agent thread not found" }, { status: scenario.threadStatus })
      }
      return Response.json(scenario.thread)
    }

    if (url.pathname === "/api/agent-threads/thr_1/messages" && method === "GET") {
      if (scenario.messagesStatus !== undefined) {
        return Response.json({ error: "[Sixb] unavailable" }, { status: scenario.messagesStatus })
      }
      return Response.json({
        messages: scenario.messages,
        authors: [
          { ...alice, displayName: "Alice Martin" },
          { ...bob, displayName: "Bob Durand" },
        ],
        hasMore: false,
        total: scenario.messages.length,
      })
    }
    if (url.pathname === "/api/agent-threads/thr_1/messages") {
      scenario.afterPost?.()
      return Response.json(
        { error: "[Sixb] refused", code: scenario.postError.code },
        { status: scenario.postError.status }
      )
    }

    if (url.pathname === "/api/agent-threads/thr_1/runs") {
      return Response.json({ runs: scenario.runs, hasMore: false, total: scenario.runs.length })
    }
    if (url.pathname.startsWith("/api/agent-threads/thr_1/runs/")) {
      return Response.json(
        { error: "[Sixb] Only whoever asked can retry it.", code: "not_run_requester" },
        { status: scenario.retryStatus }
      )
    }

    if (url.pathname === "/api/agent-threads/thr_1/participants") {
      if (scenario.shareStatus === 400) {
        return Response.json(
          {
            error:
              "[Sixb] Agent thread participant references user 'dana@example.com', which does not exist.",
            code: "invalid_participant",
          },
          { status: 400 }
        )
      }
      if (scenario.shareStatus !== 200) {
        return Response.json({ error: "[Sixb] unavailable" }, { status: scenario.shareStatus })
      }
      return Response.json(thread())
    }
    if (url.pathname.startsWith("/api/agent-threads/thr_1/participants/")) {
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/agent-threads/thr_1/fork") {
      await scenario.forkGate
      return Response.json({ thread: thread({ id: "thr_2", participants: [] }) }, { status: 201 })
    }

    return Response.json({ error: "Not found" }, { status: 404 })
  }
}

/** Plays the API for a reader, as the scenario says; the test renders what reads it. */
function serve(as: "alice" | "bob" | null, scenario: Partial<Scenario>) {
  const state: Scenario = {
    thread: thread(),
    messages,
    runs: [run()],
    shared: [],
    sharedHasMore: false,
    sharedStatus: 200,
    ownHasMore: false,
    threadStatus: 200,
    postError: { status: 409, code: "active_run_exists" },
    shareStatus: 200,
    retryStatus: 403,
    ...scenario,
  }
  const requests: string[] = []
  client.setConfig({
    fetch: Object.assign(api(state, requests), { preconnect: fetch.preconnect }),
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getAuthSessionQueryKey(),
    as
      ? {
          authenticated: true,
          user: users[as],
          session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
        }
      : { authenticated: false, authEnabled: false }
  )

  return { state, requests, queryClient }
}

function renderChat(as: "alice" | "bob" | null, scenario: Partial<Scenario> = {}) {
  const { state, requests, queryClient } = serve(as, scenario)
  const onNavigateHome = mock(() => {})
  const onNavigateThread = mock((_threadId: string) => {})

  const chat = (threadId: string) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentChat
          threadId={threadId}
          onNavigateHome={onNavigateHome}
          onNavigateThread={onNavigateThread}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(chat("thr_1"))

  /** Open another thread, as the route does. */
  const openThread = (threadId: string) => view.rerender(chat(threadId))

  return { view, queryClient, state, requests, onNavigateHome, onNavigateThread, openThread }
}

/** Plays the server on the chat's sockets: they open, and the activity feed subscribes. */
async function subscribeActivity() {
  await act(async () => {
    for (const socket of sockets) socket.onopen?.()
  })

  const activity = sockets.find((socket) =>
    socket.sent.some((message) => message.includes('"subscribe.activity"'))
  )
  if (!activity) throw new Error("The chat opened no activity feed.")

  await act(async () => {
    activity.onmessage?.({ data: JSON.stringify({ type: "subscribed.activity" }) })
  })
  return activity
}

/** What the chat's sockets asked to follow. */
const subscriptions = () => sockets.flatMap((socket) => socket.sent)

function activityEvent(runId: string, status = "queued") {
  return {
    data: JSON.stringify({
      type: "activity",
      event: {
        schemaVersion: 1,
        type: "agent.run.activity",
        projectId: "proj",
        runId,
        threadId: "thr_1",
        status,
        attempt: 0,
        occurredAt: at,
      },
    }),
  }
}

const threadReads = (requests: readonly string[]) =>
  requests.filter((entry) => entry === "GET /api/agent-threads/thr_1").length

/**
 * React DOM was imported before Happy DOM, so it sees typing through its fallback: a keyup in the
 * field that has focus.
 */
function type(field: HTMLElement, value: string) {
  fireEvent.focusIn(field)
  fireEvent.input(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) })
}

/** Types an email in the share dialog and presses Enter, which stages it as a chip. */
function stageEmail(dialog: ReturnType<typeof within>, email: string) {
  const field = dialog.getByRole("textbox", { name: "Email" })
  type(field, email)
  fireEvent.keyDown(field, { key: "Enter" })
}

async function openPeople(view: ReturnType<typeof render>, name: RegExp) {
  fireEvent.click(await view.findByRole("button", { name }))
  return within(await view.findByRole("dialog"))
}

describe("a shared conversation", () => {
  // Removal proof: render every person in PeopleStack; the "+2" then never shows.
  test("the header stacks the first people's avatars, then counts the rest", async () => {
    const people = ["Chloé Petit", "Dana Roy", "Eli Moss", "Farah Ali"].map((name, index) => ({
      principal: { type: "user", id: `usr_${index}`, displayName: name },
      addedAt: at,
      addedBy: alice,
    }))
    const { view } = renderChat("alice", { thread: thread({ participants: people }) })

    const stack = await view.findByRole("button", { name: "5 people in this conversation" })
    expect(stack.textContent).toBe("AMCPDR+2")
  })

  test("a thread only its owner reads offers to share it", async () => {
    const { view } = renderChat("alice", { thread: thread({ participants: [] }) })

    expect(await view.findByRole("button", { name: "Share conversation" })).toBeDefined()
  })

  // Removal proof: pass continued={false} to every TranscriptMessage.
  test("messages one person sends in a row name them once", async () => {
    const followUp = {
      ...messages[0],
      id: "msg_4",
      seq: 4,
      parts: [{ type: "text", text: "And by how much?" }],
    }
    const { view } = renderChat("bob", {
      messages: [messages[0], followUp, messages[1], messages[2]],
    })

    expect(await view.findByText("And by how much?")).toBeDefined()
    // Alice's two questions in a row share one name.
    expect(view.getAllByText("Alice Martin", { selector: "span" })).toHaveLength(1)
    expect(view.getAllByText("You", { selector: "span" })).toHaveLength(1)
  })

  // Removal proof: drop the reset on assistant messages in continuedUserMessages.
  test("an answer in between names the author again", async () => {
    const afterAnswer = {
      ...messages[0],
      id: "msg_4",
      seq: 4,
      parts: [{ type: "text", text: "And Globex, is it on track?" }],
    }
    const { view } = renderChat("bob", { messages: [messages[0], messages[1], afterAnswer] })

    expect(await view.findByText("And Globex, is it on track?")).toBeDefined()
    expect(view.getAllByText("Alice Martin", { selector: "span" })).toHaveLength(2)
  })

  // Removal proof: return null from useConversationAuthors; neither name then shows.
  test("names each message's author, and the reader's own messages read You", async () => {
    const { view } = renderChat("bob")

    expect(await view.findByText("Why did Acme slip?")).toBeDefined()
    expect(view.getByText("Alice Martin")).toBeDefined()
    expect(view.getByText("You")).toBeDefined()
    expect(view.getByText("Alice Martin's conversation")).toBeDefined()
  })

  test("a conversation only its owner reads still names who wrote in it, as a copy does", async () => {
    const { view } = renderChat("alice", { thread: thread({ participants: [] }) })

    expect(await view.findByText("Three deals slipped.")).toBeDefined()
    // Bob wrote msg_3, so the page has two authors and still names them.
    expect(view.getByText("Bob Durand")).toBeDefined()
    expect(view.queryByText("Alice Martin's conversation")).toBeNull()
  })
})

describe("sharing", () => {
  // Removal proof: make AddPeople's region always ready; the warning then shows before anyone.
  test("the owner stages an email, sees the warning, then shares and is told so", async () => {
    const { view, requests } = renderChat("alice", { thread: thread({ participants: [] }) })
    const dialog = await openPeople(view, /^Share conversation$/)

    expect(dialog.queryByRole("note")).toBeNull()
    expect(dialog.queryByRole("button", { name: /^Share with/ })).toBeNull()

    stageEmail(dialog, "bob@example.com")

    const staged = within(dialog.getByRole("list", { name: "People to add" }))
    expect(staged.getByText("bob@example.com")).toBeDefined()
    expect(dialog.getByRole("note").textContent).toBe(
      "Participants will see the whole conversation, including data the agent read with your access, now and in future messages. Some of it may be data they cannot normally see."
    )
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false)

    fireEvent.click(dialog.getByRole("button", { name: "Share with 1 person" }))

    await waitFor(() =>
      expect(requests).toContain(
        'POST /api/agent-threads/thr_1/participants {"users":[{"email":"bob@example.com"}]}'
      )
    )
    expect(await view.findByText("Shared with Bob Durand")).toBeDefined()
  })

  // Removal proof: stage every entry in ParticipantInput.commit, valid or not.
  test("a malformed email is caught before it is staged", async () => {
    const { view, requests } = renderChat("alice", { thread: thread({ participants: [] }) })
    const dialog = await openPeople(view, /^Share conversation$/)

    stageEmail(dialog, "dana@")

    expect(dialog.getByText("Enter an email address, such as colleague@example.com.")).toBeDefined()
    expect(dialog.queryByRole("list", { name: "People to add" })).toBeNull()
    expect(dialog.queryByRole("note")).toBeNull()
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false)
  })

  test("several emails stage at once, and the button counts them", async () => {
    const { view } = renderChat("alice", { thread: thread({ participants: [] }) })
    const dialog = await openPeople(view, /^Share conversation$/)

    stageEmail(dialog, "bob@example.com, chloe@example.com")

    expect(dialog.getByRole("button", { name: "Share with 2 people" })).toBeDefined()
  })

  // Removal proof: return "failed" for every error from shareFailure; the line then reads generic.
  test("an email no active member has is refused in our words, never the server's", async () => {
    const { view } = renderChat("alice", { shareStatus: 400 })
    const dialog = await openPeople(view, /^2 people in this conversation$/)

    stageEmail(dialog, "dana@example.com")
    fireEvent.click(dialog.getByRole("button", { name: "Share with 1 person" }))

    expect(
      await dialog.findByText(
        "Couldn't add them: each email must belong to an active member other than you, up to 50 people."
      )
    ).toBeDefined()
    expect(dialog.queryByText(/dana@example\.com', which does not exist/)).toBeNull()
  })

  test("anything else that stops a share says so plainly", async () => {
    const { view } = renderChat("alice", { shareStatus: 500 })
    const dialog = await openPeople(view, /^2 people in this conversation$/)

    stageEmail(dialog, "dana@example.com")
    fireEvent.click(dialog.getByRole("button", { name: "Share with 1 person" }))

    expect(await dialog.findByText("Couldn't share this conversation.")).toBeDefined()
  })

  // Removal proof: render ParticipantActions for the owner too in ThreadPeople.
  test("the owner's dialog is about people: no copy to make there", async () => {
    const { view } = renderChat("alice")
    const dialog = await openPeople(view, /^2 people in this conversation$/)

    expect(dialog.getByText("Bob Durand")).toBeDefined()
    expect(dialog.queryByRole("button", { name: /^Continue in/ })).toBeNull()
    expect(dialog.queryByRole("button", { name: "Leave conversation" })).toBeNull()
  })

  test("the owner removes a participant", async () => {
    const { view, requests } = renderChat("alice")
    const dialog = await openPeople(view, /^2 people in this conversation$/)

    fireEvent.click(dialog.getByRole("button", { name: "Remove Bob Durand" }))

    await waitFor(() =>
      expect(requests).toContain("DELETE /api/agent-threads/thr_1/participants/usr_bob")
    )
    expect(await view.findByText("Removed Bob Durand")).toBeDefined()
  })

  // Removal proof: show AddPeople for every reader; the email field then shows for Bob.
  test("a participant sees who takes part, adds or removes nobody, and leaves", async () => {
    const { view, requests, onNavigateHome } = renderChat("bob")
    const dialog = await openPeople(view, /^2 people in this conversation$/)

    expect(dialog.getByText("Alice Martin")).toBeDefined()
    expect(dialog.getByText("Owner")).toBeDefined()
    expect(dialog.queryByPlaceholderText("colleague@example.com")).toBeNull()
    expect(dialog.queryByRole("button", { name: /^Remove / })).toBeNull()

    fireEvent.click(dialog.getByRole("button", { name: "Leave conversation" }))
    const confirm = within(await view.findByRole("alertdialog"))
    fireEvent.click(confirm.getByRole("button", { name: "Leave conversation" }))

    await waitFor(() => expect(onNavigateHome).toHaveBeenCalled())
    expect(requests).toContain("DELETE /api/agent-threads/thr_1/participants/usr_bob")
    expect(await view.findByText("You left the conversation")).toBeDefined()
  })

  test("a participant continues in a conversation of their own, then lands in it", async () => {
    const { view, requests, onNavigateThread } = renderChat("bob")

    fireEvent.click(await view.findByRole("button", { name: "Continue in my conversation" }))

    await waitFor(() => expect(onNavigateThread).toHaveBeenCalledWith("thr_2"))
    expect(requests).toContain("POST /api/agent-threads/thr_1/fork")
    expect(await view.findByText("Copied to your conversations")).toBeDefined()
  })

  // Removal proof: call onForked without checking the current thread in useThreadSharing.fork.
  test("a copy that finishes after the reader moved on does not pull them back", async () => {
    let release = () => {}
    const forkGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { view, requests, onNavigateThread, openThread } = renderChat("bob", { forkGate })

    fireEvent.click(await view.findByRole("button", { name: "Continue in my conversation" }))
    await waitFor(() => expect(requests).toContain("POST /api/agent-threads/thr_1/fork"))

    openThread("thr_9")
    await act(async () => release())

    await waitFor(() =>
      expect(requests.filter((entry) => entry.startsWith("GET /api/agent-threads?")).length).toBe(4)
    )
    expect(onNavigateThread).not.toHaveBeenCalled()
  })

  // Removal proof: render ThreadPeople for any current thread in AgentChat.
  test("nobody shares or leaves without a signed-in user", async () => {
    const { view } = renderChat(null)

    expect(await view.findByText("Why did Acme slip?")).toBeDefined()
    expect(
      view.queryByRole("button", { name: /in this conversation$|^Share conversation$/ })
    ).toBeNull()
    expect(view.queryByText("Continue in my conversation")).toBeNull()
  })
})

describe("who acts on a turn", () => {
  // Removal proof: disable the composer on every running turn in useAgentConversation; the field
  // is disabled.
  test("while someone else's answer streams, the reader keeps typing but cannot send yet", async () => {
    const { view } = renderChat("bob", {
      thread: thread({ activeRunId: "run_2" }),
      runs: [run({ id: "run_2", status: "running", triggerMessageId: "msg_3" })],
    })

    expect(await view.findByText("Alice Martin is getting an answer…")).toBeDefined()
    const composer = view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
    expect(composer.disabled).toBe(false)

    type(composer, "And Globex?")
    expect((view.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  // Removal proof: pass stop unconditionally as composerProps.onStop in useAgentConversation.
  test("a participant cannot stop someone else's answer, but stops their own", async () => {
    const running = (requestedBy: typeof alice | typeof bob) => ({
      thread: thread({ activeRunId: "run_2" }),
      runs: [run({ id: "run_2", status: "running", triggerMessageId: "msg_3", requestedBy })],
    })

    const others = renderChat("bob", running(alice))
    expect(await others.view.findByText("Why did Acme slip?")).toBeDefined()
    expect(others.view.queryByRole("button", { name: "Stop generating" })).toBeNull()
    others.view.unmount()

    const own = renderChat("bob", running(bob))
    expect(await own.view.findByRole("button", { name: "Stop generating" })).toBeDefined()
    own.view.unmount()

    const owner = renderChat("alice", running(bob))
    expect(await owner.view.findByRole("button", { name: "Stop generating" })).toBeDefined()
  })

  // Removal proof: drop the canRetry check from transcriptProps.onRetry in useAgentConversation.
  test("only whoever asked for a failed turn retries it", async () => {
    const failed = { runs: [run({ id: "run_2", status: "failed", requestedBy: alice })] }

    const participant = renderChat("bob", failed)
    expect(await participant.view.findByText("I couldn’t get a response started.")).toBeDefined()
    expect(participant.view.queryByRole("button", { name: /Retry|Try again/ })).toBeNull()
    participant.view.unmount()

    const requester = renderChat("alice", failed)
    expect(await requester.view.findByRole("button", { name: /Retry|Try again/ })).toBeDefined()
  })

  // Removal proof: drop the retry mutation's onError in useAgentConversation.
  test("a refused retry says so", async () => {
    const { view } = renderChat("alice", {
      runs: [run({ id: "run_2", status: "failed", requestedBy: alice })],
    })

    fireEvent.click(await view.findByRole("button", { name: /Retry|Try again/ }))

    expect(await view.findByText("Couldn't retry this answer. Try again.")).toBeDefined()
  })

  // Removal proof: let canRetryRun accept a run without requestedBy.
  test("a turn nobody asked for is retried by no signed-in reader", async () => {
    const { view } = renderChat("alice", {
      runs: [run({ id: "run_2", status: "failed", requestedBy: undefined })],
    })

    expect(await view.findByText("I couldn’t get a response started.")).toBeDefined()
    expect(view.queryByRole("button", { name: /Retry|Try again/ })).toBeNull()
  })

  // Removal proof: set sandboxRecoveryProps.canRecreate to true in useAgentConversation.
  test("only the owner starts a stuck conversation with a fresh sandbox", async () => {
    const stuck = {
      thread: thread({ sandboxState: { name: "sbx_1", status: "blocked", initialized: true } }),
    }

    const participant = renderChat("bob", stuck)
    expect(
      await participant.view.findByText(
        "Only Alice Martin can start this conversation with a fresh sandbox."
      )
    ).toBeDefined()
    expect(
      participant.view.queryByRole("button", { name: "Start with a fresh sandbox" })
    ).toBeNull()
    participant.view.unmount()

    const owner = renderChat("alice", stuck)
    expect(
      await owner.view.findByRole("button", { name: "Start with a fresh sandbox" })
    ).toBeDefined()
  })

  // Removal proof: return "send" for every 409 from sendFailure; the generic line shows instead.
  test("a message sent while someone else's answer streams says so", async () => {
    const answering = run({ id: "run_2", status: "running", triggerMessageId: "msg_3" })
    const { view, state } = renderChat("bob", {
      // The thread turns out busy with Alice's answer once it is read again.
      afterPost: () => {
        state.thread = thread({ activeRunId: "run_2" })
        state.runs = [answering]
      },
    })

    type(await view.findByRole("textbox"), "And Globex?")
    fireEvent.click(view.getByRole("button", { name: "Send message" }))

    expect(
      await view.findByText(
        "Someone else's message is being answered. Send yours when it finishes."
      )
    ).toBeDefined()
  })

  test("a busy thread whose answer the reader cannot place says only that", async () => {
    const { view } = renderChat("bob")

    type(await view.findByRole("textbox"), "And Globex?")
    fireEvent.click(view.getByRole("button", { name: "Send message" }))

    expect(
      await view.findByText("An answer is already in progress. Send yours when it finishes.")
    ).toBeDefined()
  })

  test("a thread whose sandbox needs recovery refuses a message with that reason", async () => {
    const { view } = renderChat("bob", {
      postError: { status: 409, code: "sandbox_execution_unavailable" },
    })

    type(await view.findByRole("textbox"), "And Globex?")
    fireEvent.click(view.getByRole("button", { name: "Send message" }))

    expect(
      await view.findByText("This conversation's sandbox must be recovered before another answer.")
    ).toBeDefined()
  })
})

/** A chat of the reader's own, which reads the conversation's turn and errors as data. */
function ConversationProbe() {
  const conversation = useAgentConversation({ threadId: "thr_1", onThreadCreated: () => {} })
  const { kind, canStop, canRetry, canContinue } = conversation.turn

  return (
    <>
      <output aria-label="turn">
        {JSON.stringify({
          kind,
          canStop,
          canRetry,
          canContinue,
          ...(conversation.turn.kind === "responding"
            ? { answeringFor: conversation.turn.answeringFor }
            : {}),
        })}
      </output>
      <output aria-label="errors">
        {JSON.stringify({ send: conversation.sendError, messages: conversation.messagesError })}
      </output>
      <button type="button" onClick={() => void conversation.send("And Globex?", [], [])}>
        Send
      </button>
    </>
  )
}

function renderConversation(as: "alice" | "bob", scenario: Partial<Scenario> = {}) {
  const { state, queryClient } = serve(as, scenario)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConversationProbe />
    </QueryClientProvider>
  )
  const read = (name: "turn" | "errors"): unknown =>
    JSON.parse(view.getByRole("status", { name }).textContent ?? "null")

  return { view, state, read }
}

describe("a turn as data", () => {
  const running = (requestedBy: typeof alice | typeof bob) => ({
    thread: thread({ activeRunId: "run_2" }),
    runs: [run({ id: "run_2", status: "running", triggerMessageId: "msg_3", requestedBy })],
  })

  // Removal proof: drop canStopRun from canStop in useAgentConversation; Bob may stop Alice's.
  test("an answer in flight says who asked for it, and whether the reader may stop it", async () => {
    const others = renderConversation("bob", running(alice))
    await waitFor(() =>
      expect(others.read("turn")).toEqual({
        kind: "responding",
        canStop: false,
        canRetry: false,
        canContinue: false,
        answeringFor: {
          type: "user",
          id: "usr_alice",
          displayName: "Alice Martin",
          isReader: false,
        },
      })
    )
    others.view.unmount()

    const own = renderConversation("bob", running(bob))
    await waitFor(() =>
      expect(own.read("turn")).toMatchObject({
        kind: "responding",
        canStop: true,
        answeringFor: null,
      })
    )
    own.view.unmount()

    const owner = renderConversation("alice", running(bob))
    await waitFor(() =>
      expect(owner.read("turn")).toMatchObject({
        kind: "responding",
        canStop: true,
        answeringFor: { id: "usr_bob", displayName: "Bob Durand" },
      })
    )
  })

  // Removal proof: drop canRetryRun from canRetry in useAgentConversation; Bob may retry it.
  test("a turn that failed is retried by whoever asked for it", async () => {
    const failed = { runs: [run({ id: "run_2", status: "failed", requestedBy: alice })] }

    const participant = renderConversation("bob", failed)
    await waitFor(() =>
      expect(participant.read("turn")).toEqual({
        kind: "failed",
        canStop: false,
        canRetry: false,
        canContinue: false,
      })
    )
    participant.view.unmount()

    const requester = renderConversation("alice", failed)
    await waitFor(() => expect(requester.read("turn")).toMatchObject({ canRetry: true }))
  })

  test("an answer cut short can be continued", async () => {
    const cutShort = {
      ...messages[1],
      annotations: [
        {
          code: "output_limit_reached",
          severity: "warning",
          scope: "run",
          message: "Developer copy.",
        },
      ],
    }
    const { read } = renderConversation("bob", { messages: [messages[0], cutShort] })

    await waitFor(() =>
      expect(read("turn")).toEqual({
        kind: "idle",
        canStop: false,
        canRetry: false,
        canContinue: true,
      })
    )
  })

  // Removal proof: return labels from the hook again; the errors read as sentences.
  test("errors are codes the chat words itself", async () => {
    const answering = run({ id: "run_2", status: "running", triggerMessageId: "msg_3" })
    const busy = renderConversation("bob", {
      afterPost: () => {
        busy.state.thread = thread({ activeRunId: "run_2" })
        busy.state.runs = [answering]
      },
    })
    await waitFor(() => expect(busy.read("turn")).toMatchObject({ kind: "idle" }))

    fireEvent.click(busy.view.getByRole("button", { name: "Send" }))

    await waitFor(() =>
      expect(busy.read("errors")).toEqual({
        send: { code: "busy", someoneElse: true },
        messages: null,
      })
    )
    busy.view.unmount()

    const unreadable = renderConversation("bob", { messagesStatus: 500 })
    await waitFor(() =>
      expect(unreadable.read("errors")).toEqual({ send: null, messages: { code: "load" } })
    )
  })
})

describe("live changes", () => {
  // Removal proof: drop the refreshThread call from the activity handler; the stream never opens.
  test("a participant follows another participant's turn live", async () => {
    const { view, state, requests } = renderChat("bob")
    expect(await view.findByText("Why did Acme slip?")).toBeDefined()
    const activity = await subscribeActivity()
    expect(subscriptions().some((message) => message.includes('"run_2"'))).toBe(false)

    // Alice asks; the server now says her run holds the thread.
    state.thread = thread({ activeRunId: "run_2" })
    state.runs = [run({ id: "run_2", status: "running", triggerMessageId: "msg_3" })]
    const before = threadReads(requests)
    await act(async () => activity.onmessage?.(activityEvent("run_2")))

    await waitFor(() => expect(threadReads(requests)).toBeGreaterThan(before))
    await subscribeActivity()
    await waitFor(() =>
      expect(
        subscriptions().some(
          (message) => message.includes('"type":"subscribe"') && message.includes('"run_2"')
        )
      ).toBe(true)
    )
  })

  // Removal proof: drop `event.runId !== activeRunId` from the activity handler.
  test("events of the run the reader already follows read only the lists again", async () => {
    const { view, requests } = renderChat("bob", {
      thread: thread({ activeRunId: "run_2" }),
      runs: [run({ id: "run_2", status: "running", triggerMessageId: "msg_3", requestedBy: bob })],
    })
    expect(await view.findByRole("button", { name: "Stop generating" })).toBeDefined()
    const activity = await subscribeActivity()

    const before = threadReads(requests)
    const lists = requests.filter((entry) => entry.startsWith("GET /api/agent-threads?")).length
    await act(async () => activity.onmessage?.(activityEvent("run_2", "running")))

    await waitFor(() =>
      expect(
        requests.filter((entry) => entry.startsWith("GET /api/agent-threads?")).length
      ).toBeGreaterThan(lists)
    )
    expect(threadReads(requests)).toBe(before)
  })

  // Removal proof: make onSubscribed refresh only the lists.
  test("a feed that subscribes again reads the open thread again", async () => {
    const { view, requests } = renderChat("bob")
    expect(await view.findByText("Why did Acme slip?")).toBeDefined()

    const before = threadReads(requests)
    await subscribeActivity()

    await waitFor(() => expect(threadReads(requests)).toBeGreaterThan(before))
  })

  // Removal proof: drop `!threadGone` from the thread selection in useAgentConversation; the last
  // copy then keeps showing.
  test("a participant removed while reading is told so", async () => {
    const { view, queryClient, state } = renderChat("bob")
    expect(await view.findByText("Why did Acme slip?")).toBeDefined()

    state.threadStatus = 404
    await act(() =>
      queryClient.refetchQueries({
        predicate: (query) => JSON.stringify(query.queryKey).includes('"_id":"getAgentThread"'),
      })
    )

    expect(await view.findByText("You no longer take part in this conversation.")).toBeDefined()
  })
})

describe("thread history", () => {
  const shared = [thread({ id: "thr_3", title: "Pipeline review", messageCount: 4 })]

  async function openHistory(view: ReturnType<typeof render>) {
    fireEvent.click(await view.findByRole("button", { name: /^Thread history/ }))
    return within(await view.findByRole("dialog"))
  }

  // Removal proof: drop the shared FilterButton from AgentThreadSwitcher.
  test("lists the conversations shared with the reader apart, with their owner", async () => {
    const { view } = renderChat("bob", { shared })

    const history = await openHistory(view)
    fireEvent.click(await history.findByRole("button", { name: "Shared with me 1" }))

    expect(history.getByText("Pipeline review")).toBeDefined()
    expect(history.getByText("Alice Martin · 4 messages")).toBeDefined()
  })

  // Removal proof: use the own list's error and paging under every filter in AgentThreadSwitcher.
  test("counts every shared conversation, and pages and fails on its own", async () => {
    const { view, requests } = renderChat("bob", {
      shared,
      sharedTotal: 51,
      sharedHasMore: true,
      ownHasMore: true,
    })

    const history = await openHistory(view)
    expect(history.getByRole("button", { name: "Load more threads" })).toBeDefined()

    fireEvent.click(await history.findByRole("button", { name: "Shared with me 51" }))
    fireEvent.click(history.getByRole("button", { name: "Load more threads" }))

    await waitFor(() =>
      expect(requests).toContain(
        "GET /api/agent-threads?sharedWithMe=true&limit=50&order=desc&offset=50"
      )
    )
  })

  // Removal proof: drop the shared error line from AgentThreadSwitcher.
  test("says when the shared conversations cannot be read", async () => {
    const { view } = renderChat("bob", { sharedStatus: 500, ownHasMore: true })

    expect(await view.findByText("Why did Acme slip?")).toBeDefined()
    const history = await openHistory(view)

    expect(history.getByText("Could not load the conversations shared with you.")).toBeDefined()
    expect(history.getByRole("button", { name: "Load more threads" })).toBeDefined()
  })

  // Removal proof: show messages.empty under every filter in AgentThreadSwitcher.
  test("an empty shared list says what will appear there", async () => {
    const { view } = renderChat("bob")

    const history = await openHistory(view)
    fireEvent.click(await history.findByRole("button", { name: "Shared with me" }))

    expect(history.getByText("Conversations others share with you appear here.")).toBeDefined()
  })

  test("nothing to share from, nothing shared with: no filter without a signed-in user", async () => {
    const { view } = renderChat(null)

    expect(await view.findByText("Why did Acme slip?")).toBeDefined()
    const history = await openHistory(view)

    expect(history.queryByRole("button", { name: /^Shared with me/ })).toBeNull()
  })
})

describe("on a phone", () => {
  afterEach(() => browser.happyDOM.setViewport({ width: 1024, height: 768 }))

  // Removal proof: always render the Dialog in ThreadPeople; no drawer then opens.
  test("who takes part opens in a bottom drawer, with the same actions", async () => {
    browser.happyDOM.setViewport({ width: 390, height: 844 })
    const { view } = renderChat("bob")

    const dialog = await openPeople(view, /^2 people in this conversation$/)

    expect(document.querySelector("[data-vaul-drawer]")).not.toBeNull()
    expect(dialog.getByText("Alice Martin")).toBeDefined()
    expect(dialog.getByRole("button", { name: "Leave conversation" })).toBeDefined()
    expect(dialog.getByRole("button", { name: "Continue in my conversation" })).toBeDefined()
  })
})
