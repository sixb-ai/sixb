import { afterAll, afterEach, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentThreads } from "../src/agent/components/agent-threads"
import { threadQueryOptions, usePrefetchAgentThread } from "../src/agent/hooks/thread-queries"
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

afterEach(() => {
  cleanup()
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
})

const listed = {
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

/** Answers every read the thread list and a prefetch make, and records each one. */
function serve(): string[] {
  const requests: string[] = []
  const answer = async (input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push(`${url.pathname}${url.search}`)
    const body = (() => {
      if (url.pathname === "/api/agent-threads/thr_1") return listed
      if (url.pathname.endsWith("/messages"))
        return { messages: [], authors: [], hasMore: false, total: 0 }
      if (url.pathname.endsWith("/runs")) return { runs: [], hasMore: false, total: 0 }
      if (url.pathname === "/api/agent-threads") {
        return { threads: url.searchParams.get("shared") ? [] : [listed], hasMore: false, total: 1 }
      }
      if (url.pathname.includes("approvals")) return { approvals: [], hasMore: false, total: 0 }
      return {}
    })()
    return Response.json(body)
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

// Passing over the list must not load every thread it crosses. Removal proof: prefetch in
// onPointerEnter without the intent delay; the brief pass loads the thread.
test("loads a thread its row is rested on or focused, and none the pointer only crosses", async () => {
  const requests = serve()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: { id: "usr_1", email: "dana@example.test", displayName: "Dana" },
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })
  const view = render(<AgentThreads onSelectThread={() => {}} onNewThread={() => {}} />, {
    wrapper: wrapper(queryClient),
  })
  const row = await view.findByRole("button", { name: /Release notes/ })

  await act(async () => {
    fireEvent.pointerEnter(row)
    await new Promise((resolve) => setTimeout(resolve, 40))
    fireEvent.pointerLeave(row)
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  expect(opens(requests)).toEqual([])

  await act(async () => {
    fireEvent.pointerEnter(row)
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  expect(opens(requests)).toContain("/api/agent-threads/thr_1/messages?order=asc")

  queryClient.clear()
  requests.length = 0
  await act(async () => {
    fireEvent.focus(row)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(opens(requests)).toContain("/api/agent-threads/thr_1/messages?order=asc")
})
