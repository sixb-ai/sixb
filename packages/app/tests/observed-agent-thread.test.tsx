import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { observedThreadPollMs, observedTranscriptPollMs } from "../src/agent/observed-conversation"
import { messageFileSource } from "../src/artifacts/file-source"
import { SectionsProvider } from "../src/pages"
import { SettingsActivityThreadPage } from "../src/pages/settings/activity/thread"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"
import { settingsManagerSession } from "./helpers/session"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
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
let sockets: ReturnType<typeof stubWebSockets> | undefined

beforeAll(() => {
  sockets = stubWebSockets()
})

afterEach(() => {
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  sockets?.restore()
})

const thread = {
  id: "thr_1",
  projectId: "proj",
  ownerPrincipal: { type: "user", id: "usr_1" },
  title: "Overdue invoices",
  status: "idle",
  messageCount: 2,
  createdAt: "2026-10-02T09:03:00.000Z",
  updatedAt: "2026-10-02T09:04:00.000Z",
}

const message = {
  projectId: "proj",
  threadId: "thr_1",
  annotations: [],
  contentVersion: 1,
  createdAt: "2026-10-02T09:03:00.000Z",
}

const question = {
  ...message,
  id: "msg_1",
  runId: null,
  role: "user",
  authorPrincipal: { type: "user", id: "usr_1" },
  seq: 1,
  parts: [{ type: "text", text: "Which invoices are late?" }],
}

const answer = {
  ...message,
  id: "msg_2",
  runId: "run_1",
  role: "assistant",
  seq: 2,
  parts: [{ type: "text", text: "Three invoices are past due." }],
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    projectId: "proj",
    threadId: "thr_1",
    triggerMessageId: "msg_1",
    status: "succeeded",
    attempt: 0,
    streamId: "stream_1",
    createdAt: "2026-10-02T09:03:00.000Z",
    ...overrides,
  }
}

const version = {
  artifactId: "art_0000000001",
  version: 1,
  title: "Late invoices",
  entry: "document.md",
  files: [],
  outline: { kind: "document", headings: [] },
  references: [],
  author: { type: "user", id: "usr_1" },
  createdAt: "2026-10-02T09:04:00.000Z",
}

/** What the observer's routes answer; a test changes it between reads. */
interface Scenario {
  thread: Record<string, unknown>
  messages: readonly Record<string, unknown>[]
  runs: readonly Record<string, unknown>[]
  status: number
}

function threadApi(scenario: Scenario, requests: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url)
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`)
    if (scenario.status !== 200) {
      return Response.json({ error: "[Sixb] not allowed" }, { status: scenario.status })
    }

    switch (url.pathname) {
      case "/api/observed-agent-threads/thr_1":
        return Response.json(scenario.thread)
      case "/api/observed-agent-threads/thr_1/messages":
        return Response.json({
          messages: scenario.messages,
          hasMore: false,
          total: scenario.messages.length,
          authors: [{ type: "user", id: "usr_1", displayName: "Alex" }],
        })
      case "/api/observed-agent-threads/thr_1/runs":
        return Response.json({ runs: scenario.runs, hasMore: false, total: scenario.runs.length })
      case "/api/artifacts":
        return Response.json({
          artifacts:
            url.searchParams.get("thread") === "thr_1"
              ? [
                  {
                    id: "art_0000000001",
                    projectId: "proj",
                    kind: "document",
                    title: "Late invoices",
                    owner: { type: "user", id: "usr_1" },
                    latestVersion: 1,
                    createdAt: version.createdAt,
                    updatedAt: version.createdAt,
                  },
                ]
              : [],
          hasMore: false,
        })
      case "/api/artifacts/art_0000000001":
        return Response.json({
          artifact: {
            id: "art_0000000001",
            projectId: "proj",
            kind: "document",
            title: "Late invoices",
            owner: { type: "user", id: "usr_1" },
            latestVersion: 1,
            createdAt: version.createdAt,
            updatedAt: version.createdAt,
          },
          versions: [version],
          access: "read",
        })
      case "/api/artifacts/art_0000000001/versions/1":
        return Response.json(version)
      default:
        return Response.json({ error: "Not found" }, { status: 404 })
    }
  }
}

function renderThread(scenario: Partial<Scenario> = {}) {
  const state: Scenario = {
    thread,
    messages: [question, answer],
    runs: [],
    status: 200,
    ...scenario,
  }
  const requests: string[] = []
  client.setConfig({
    fetch: Object.assign(threadApi(state, requests), { preconnect: fetch.preconnect }),
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), settingsManagerSession)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SectionsProvider>
        <MemoryRouter initialEntries={["/settings/activity/threads/thr_1"]}>
          <Routes>
            <Route
              path="/settings/activity/threads/:threadId"
              element={<SettingsActivityThreadPage />}
            />
          </Routes>
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )
  return { view, queryClient, state, requests }
}

/** Reads the thread again, as its poll does. */
async function pollThread(queryClient: QueryClient) {
  await act(() =>
    queryClient.refetchQueries({
      predicate: (query) =>
        JSON.stringify(query.queryKey).includes('"_id":"getObservedAgentThread"'),
    })
  )
}

describe("an observed conversation", () => {
  // Removal proof: drop the author line from UserMessage; "Alex" then shows only in the header.
  test("reads someone else's thread with its authors, and offers nothing that writes", async () => {
    const { view, queryClient, requests } = renderThread()

    expect(await view.findByText("Three invoices are past due.")).toBeDefined()
    expect(view.getByRole("heading", { name: "Overdue invoices" })).toBeDefined()
    expect(view.getByText("Alex's conversation")).toBeDefined()
    expect(view.getAllByText("Alex")).toHaveLength(1)
    expect(view.getByText("Which invoices are late?")).toBeDefined()
    expect(view.getByText(/^Read-only\. You see everything the agent showed/)).toBeDefined()

    // The conversation's artifacts are listed for the observer too. Reproduce by dropping the
    // menu from the page's header: the button never shows.
    expect(
      await view.findByRole("button", { name: "1 artifact in this conversation" })
    ).toBeDefined()

    // No composer, no thread list: only the observer's reads.
    expect(view.queryByRole("textbox")).toBeNull()
    expect(
      requests.every(
        (request) =>
          request.startsWith("GET /api/observed-agent-threads/") ||
          request === "GET /api/artifacts?thread=thr_1"
      )
    ).toBe(true)
    view.unmount()
    queryClient.clear()
  })

  // Removal proof: pass onRetry or onContinue to the observed Transcript; its buttons then show.
  test("shows a failed or cut-short turn without retrying or continuing it", async () => {
    for (const [runs, marker] of [
      [[run({ status: "failed" })], "I couldn’t get a response started."],
      [
        [run({ status: "failed", finishReason: "timeout" })],
        "The response reached the time limit before producing an answer.",
      ],
    ] as const) {
      const { view, queryClient } = renderThread({ messages: [question], runs })

      expect(await view.findByText(marker)).toBeDefined()
      for (const name of ["Retry", "Try again", "Continue"]) {
        expect(view.queryByRole("button", { name })).toBeNull()
      }
      view.unmount()
      queryClient.clear()
    }
  })

  // Removal proof: drop `pageLinks={false}` from ObservedConversation; the viewer then offers the
  // artifact's own page, which is its owner's.
  test("opens an artifact the agent published, without a way to its page", async () => {
    const published = {
      ...answer,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "publish_artifact",
          state: "output-available",
          input: { kind: "document", title: "Late invoices" },
          output: {
            artifactId: "art_0000000001",
            version: 1,
            kind: "document",
            title: "Late invoices",
            warnings: [],
          },
        },
      ],
    }
    const { view, queryClient } = renderThread({ messages: [question, published] })

    fireEvent.click(await view.findByRole("button", { name: "Open Late invoices" }))
    expect(await view.findByRole("heading", { name: "Late invoices" })).toBeDefined()
    expect(view.queryByRole("link", { name: "Open full page" })).toBeNull()
    expect(view.queryByRole("button", { name: "Copy link" })).toBeNull()
    expect(view.queryByRole("textbox")).toBeNull()
    view.unmount()
    queryClient.clear()
  })

  // Removal proof: compare `wasAnswering.current && !answering` again in ObservedConversation; the
  // new question then waits for a poll that never comes.
  test("reads the transcript again when a turn starts and when it ends", async () => {
    const { view, queryClient, state } = renderThread({ messages: [question, answer] })
    expect(await view.findByText("Three invoices are past due.")).toBeDefined()

    state.thread = { ...thread, activeRunId: "run_2" }
    state.messages = [
      question,
      answer,
      {
        ...question,
        id: "msg_3",
        seq: 3,
        parts: [{ type: "text", text: "And the ones due this week?" }],
      },
    ]
    state.runs = [run({ id: "run_2", status: "running", triggerMessageId: "msg_3" })]
    await pollThread(queryClient)
    expect(await view.findByText("And the ones due this week?")).toBeDefined()
    expect(view.getByText(/The agent is answering/)).toBeDefined()

    state.thread = thread
    state.messages = [
      ...state.messages,
      {
        ...answer,
        id: "msg_4",
        runId: "run_2",
        seq: 4,
        parts: [{ type: "text", text: "Two more are due on Friday." }],
      },
    ]
    state.runs = [run({ id: "run_2", triggerMessageId: "msg_3" })]
    await pollThread(queryClient)
    expect(await view.findByText("Two more are due on Friday.")).toBeDefined()
    await waitFor(() => expect(view.queryByText(/The agent is answering/)).toBeNull())
    view.unmount()
    queryClient.clear()
  })

  // Removal proof: drop `|| threadQuery.isError` from the page; the conversation stays on screen.
  test("stops at the refusal once the grant is revoked", async () => {
    const { view, queryClient, state } = renderThread()
    expect(await view.findByText("Three invoices are past due.")).toBeDefined()

    state.status = 403
    await pollThread(queryClient)
    expect(
      await view.findByText(
        "Reading other users' conversations takes can.observe(agent.threads) in one of your roles."
      )
    ).toBeDefined()
    expect(view.queryByText("Three invoices are past due.")).toBeNull()
    view.unmount()
    queryClient.clear()
  })

  test("polls a thread slowly while idle, often while answering, and never once refused", () => {
    expect(observedThreadPollMs("success", null)).toBe(15_000)
    expect(observedThreadPollMs("success", "run_1")).toBe(5_000)
    expect(observedThreadPollMs("error", "run_1")).toBe(false)
    expect(observedTranscriptPollMs("success", true)).toBe(5_000)
    expect(observedTranscriptPollMs("success", false)).toBe(false)
    expect(observedTranscriptPollMs("error", true)).toBe(false)
  })

  // Removal proof: drop `denied` from the page's useLoadFailure call; the generic refusal shows.
  test("tells a refused person which grant reads conversations", async () => {
    const { view, queryClient } = renderThread({ status: 403 })

    expect(
      await view.findByText(
        "Reading other users' conversations takes can.observe(agent.threads) in one of your roles."
      )
    ).toBeDefined()
    view.unmount()
    queryClient.clear()
  })

  test("reads a message's files through the observer's route", () => {
    const fileRef = { blobId: "blob", digest: "a".repeat(64), sizeBytes: 1, fileName: "late.csv" }
    const input = { threadId: "thr_1", messageId: "msg_1", path: "/parts/1/fileRef", fileRef }

    expect(messageFileSource({ ...input, observed: true }).inlineUrl).toStartWith(
      "https://api.sixb.test/api/observed-agent-threads/thr_1/messages/msg_1/files/content?"
    )
    expect(messageFileSource(input).inlineUrl).toStartWith(
      "https://api.sixb.test/api/agent-threads/thr_1/messages/msg_1/files/content?"
    )
  })
})
