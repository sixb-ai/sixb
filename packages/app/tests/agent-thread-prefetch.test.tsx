import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentThreads } from "../src/agent/components/agent-threads"
import { threadQueryOptions, usePrefetchAgentThread } from "../src/agent/hooks/thread-queries"
import { useAgentConversation } from "../src/agent/hooks/use-agent-conversation"
import type { AgentThread } from "../src/agent/types"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })

/** Sockets the app opens; a test plays the server by calling their handlers. */
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

beforeAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  })
})

afterEach(() => {
  jest.useRealTimers()
  focusManager.setFocused(undefined)
  cleanup()
  sockets.length = 0
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const listed: AgentThread = {
  id: "thr_1",
  projectId: "demo",
  kind: "conversation",
  title: "Release notes",
  status: "active",
  ownerPrincipal: { type: "user", id: "usr_1" },
  owner: { type: "user", id: "usr_1", displayName: "Dana Reyes" },
  participants: [],
  approvalMode: "manual",
  approvalModeSource: "fallback",
  activeRunId: null,
  messageCount: 4,
  lastMessageAt: "2026-11-14T10:00:00.000Z",
  createdAt: "2026-11-14T09:00:00.000Z",
  updatedAt: "2026-11-14T10:00:00.000Z",
}

/** Answers every read the thread list, a prefetch and an open make, and records each one. */
function serve(thread: AgentThread = listed): string[] {
  const requests: string[] = []
  const answer = async (input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push(`${url.pathname}${url.search}`)
    const body = (() => {
      const read = /^\/api\/agent-threads\/([^/]+)$/.exec(url.pathname)
      if (read) return { ...thread, id: read[1] }
      if (url.pathname.endsWith("/messages"))
        return { messages: [], authors: [], hasMore: false, total: 0 }
      if (url.pathname.endsWith("/runs")) return { runs: [], hasMore: false, total: 0 }
      if (url.pathname === "/api/agent-threads") {
        return { threads: url.searchParams.get("shared") ? [] : [thread], hasMore: false, total: 1 }
      }
      if (url.pathname.includes("approvals")) return { approvals: [], hasMore: false, total: 0 }
      if (url.pathname.endsWith("/inbox")) return { items: [] }
      return null
    })()
    // What else opening reads, such as models and preferences, is left unanswered.
    return body === null
      ? Response.json({ error: "Not found" }, { status: 404 })
      : Response.json(body)
  }
  client.setConfig({ fetch: Object.assign(answer, { preconnect: fetch.preconnect }) })
  return requests
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

const opens = (requests: readonly string[]) =>
  requests.filter((request) => request.startsWith("/api/agent-threads/thr_1"))

/** A cache with Dana signed in, as the app has it once the session loads. */
function signedIn(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: { id: "usr_1", email: "dana@example.test", displayName: "Dana" },
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })
  return queryClient
}

/** Prefetches a thread, as resting on its row does, and waits for its three reads to arrive. */
async function prefetched(queryClient: QueryClient, threadId: string) {
  const { result } = renderHook(() => usePrefetchAgentThread(), { wrapper: wrapper(queryClient) })
  act(() => result.current(threadId))

  const reads = threadQueryOptions(threadId)
  await waitFor(() => {
    for (const read of [reads.thread, reads.messages, reads.runs]) {
      expect(queryClient.getQueryState(read.queryKey)?.status).toBe("success")
    }
  })
  return reads
}

/** Plays the server on the activity feed: its socket opens and subscribes. */
async function subscribeActivity() {
  await act(async () => {
    for (const socket of sockets) socket.onopen?.()
  })
  const feed = sockets.find((socket) =>
    socket.sent.some((sent) => sent.includes('"subscribe.activity"'))
  )
  if (!feed) throw new Error("Nothing opened the activity feed.")

  const deliver = (message: object) =>
    act(() => feed.onmessage?.({ data: JSON.stringify(message) }))
  deliver({ type: "subscribed.activity" })

  return {
    /** A run in this thread ended, as the feed reports it. */
    runEnded: (threadId: string) =>
      deliver({
        type: "activity",
        event: {
          schemaVersion: 1,
          type: "agent.run.activity",
          projectId: "demo",
          runId: `run_${threadId}`,
          threadId,
          status: "succeeded",
          attempt: 0,
          occurredAt: "2026-11-14T10:05:00.000Z",
        },
      }),
    /** The feed came back after a gap, and subscribed again. */
    resubscribed: () => deliver({ type: "subscribed.activity" }),
  }
}

/** Whether each of a thread's reads is marked stale, and whether any is being read. */
function readsState(queryClient: QueryClient, threadId: string) {
  const reads = threadQueryOptions(threadId)
  const states = [reads.thread, reads.messages, reads.runs].map((read) =>
    queryClient.getQueryState(read.queryKey)
  )
  return {
    stale: states.map((state) => state?.isInvalidated),
    reading: states.some((state) => state?.fetchStatus === "fetching"),
  }
}

/** Opens a thread with the conversation the app's chat runs on. */
function open(queryClient: QueryClient, threadId: string) {
  return renderHook(() => useAgentConversation({ threadId, onThreadCreated: () => {} }), {
    wrapper: wrapper(queryClient),
  })
}

// Opening a thread reads it, its messages and its runs. A prefetch that read anything else, or by
// other keys, would leave the open to fetch again. Removal proof: prefetch the messages without
// `order: "asc"`; the opened thread's messages query finds nothing cached.
test("prefetches exactly the reads opening a thread makes, and leaves a fresh one alone", async () => {
  const requests = serve()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result } = renderHook(() => usePrefetchAgentThread(), { wrapper: wrapper(queryClient) })

  await act(async () => {
    result.current("thr_1")
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const reads = threadQueryOptions("thr_1")

  expect(opens(requests).sort()).toEqual([
    "/api/agent-threads/thr_1",
    "/api/agent-threads/thr_1/messages?order=asc",
    "/api/agent-threads/thr_1/runs?order=desc",
  ])
  expect(queryClient.getQueryData(reads.messages.queryKey)).toEqual({
    messages: [],
    authors: [],
    hasMore: false,
    total: 0,
  })
  expect(queryClient.getQueryData(reads.thread.queryKey)).toBeDefined()
  expect(queryClient.getQueryData(reads.runs.queryKey)).toBeDefined()

  await act(async () => {
    result.current("thr_1")
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(opens(requests)).toHaveLength(3)
})

// Passing over the list must not load every thread it crosses, with the pointer or holding an
// arrow key down it. A started prefetch is in the cache at once, so the cache is what each step
// reads. Removal proof: prefetch in onPointerEnter, or in onFocus, without the intent delay; the
// brief pass loads the thread.
test("loads a thread its row is rested on, by the pointer or the focus, and none either only crosses", async () => {
  serve()
  const queryClient = signedIn()
  const view = render(<AgentThreads onSelectThread={() => {}} onNewThread={() => {}} />, {
    wrapper: wrapper(queryClient),
  })
  const row = await view.findByRole("button", { name: /Release notes/ })
  const messages = threadQueryOptions("thr_1").messages.queryKey
  const loading = () => queryClient.getQueryState(messages) !== undefined

  jest.useFakeTimers()
  for (const [rest, leave] of [
    [() => fireEvent.pointerEnter(row), () => fireEvent.pointerLeave(row)],
    [() => fireEvent.focus(row), () => fireEvent.blur(row)],
  ] as const) {
    queryClient.removeQueries({ queryKey: messages })

    act(() => {
      rest()
      jest.advanceTimersByTime(40)
      leave()
      jest.advanceTimersByTime(200)
    })
    expect(loading()).toBe(false)

    act(() => {
      rest()
      jest.advanceTimersByTime(100)
    })
    expect(loading()).toBe(true)
  }
})

// Opening a thread its prefetch just read shows what it read and reads nothing again: the
// thread's messages are its heaviest read. A refetch starts as the conversation mounts, so the
// reads' fetch status says it at once. Removal proof: drop `staleTime` from the reads in
// threadQueryOptions and give it to the prefetch alone; opening reads all three again.
test("opens a thread its prefetch just read without reading it again", async () => {
  serve()
  const queryClient = signedIn()
  const reads = await prefetched(queryClient, "thr_1")

  const { result } = open(queryClient, "thr_1")

  for (const read of [reads.thread, reads.messages, reads.runs]) {
    expect(queryClient.getQueryState(read.queryKey)?.fetchStatus).toBe("idle")
  }
  expect(result.current.currentThread?.id).toBe("thr_1")
})

// A shared thread can lose its reader without an event, so coming back to the window reads it
// again even while its last read is fresh. Removal proof: answer `true` instead of "always" from
// the thread's refetchOnWindowFocus; the fresh read is kept and the wait below times out.
test("reads a shared thread again when the window comes back, however recent its read", async () => {
  const requests = serve({
    ...listed,
    participants: [
      {
        principal: { type: "user", id: "usr_2", displayName: "Lee" },
        addedAt: "2026-11-14T09:30:00.000Z",
        addedBy: { type: "user", id: "usr_1" },
      },
    ],
  })
  const queryClient = signedIn()
  await prefetched(queryClient, "thr_1")
  open(queryClient, "thr_1")
  const threadReads = () => requests.filter((request) => request === "/api/agent-threads/thr_1")
  expect(threadReads()).toHaveLength(1)

  act(() => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })

  await waitFor(() => expect(threadReads()).toHaveLength(2))
})

// A thread a row prefetched keeps its fresh reads until it opens, and nothing reads them again by
// itself. A change the feed reports, or a gap in the feed, marks them stale, reading nothing, so
// that the open reads them. Removal proof: drop markThreadReadsStale from the thread list's
// onActivity, or from its onSubscribed; the reads stay fresh and the open shows them as they were.
test("the thread list marks a prefetched thread stale when the feed reports a change or a gap", async () => {
  serve()
  const queryClient = signedIn()
  render(<AgentThreads onSelectThread={() => {}} onNewThread={() => {}} />, {
    wrapper: wrapper(queryClient),
  })
  const feed = await subscribeActivity()
  await prefetched(queryClient, "thr_1")

  feed.runEnded("thr_2")
  expect(readsState(queryClient, "thr_1")).toEqual({ stale: [false, false, false], reading: false })

  feed.runEnded("thr_1")
  expect(readsState(queryClient, "thr_1")).toEqual({ stale: [true, true, true], reading: false })

  await prefetched(queryClient, "thr_1")
  await waitFor(() => expect(readsState(queryClient, "thr_1").stale).toEqual([false, false, false]))
  feed.resubscribed()
  expect(readsState(queryClient, "thr_1")).toEqual({ stale: [true, true, true], reading: false })
})

// The open conversation hears of every thread's runs too, and marks another thread's reads the
// same way. Removal proof: drop markThreadReadsStale from the conversation's onActivity, or from
// its onSubscribed; the other thread's reads stay fresh.
test("an open conversation marks another thread it has read stale when the feed reports a change or a gap", async () => {
  serve()
  const queryClient = signedIn()
  open(queryClient, "thr_1")
  const feed = await subscribeActivity()
  await prefetched(queryClient, "thr_2")
  expect(readsState(queryClient, "thr_2")).toEqual({ stale: [false, false, false], reading: false })

  feed.runEnded("thr_2")
  expect(readsState(queryClient, "thr_2")).toEqual({ stale: [true, true, true], reading: false })

  await prefetched(queryClient, "thr_2")
  await waitFor(() => expect(readsState(queryClient, "thr_2").stale).toEqual([false, false, false]))
  feed.resubscribed()
  expect(readsState(queryClient, "thr_2")).toEqual({ stale: [true, true, true], reading: false })
})
