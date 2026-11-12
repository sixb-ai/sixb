import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import {
  type AgentMessage,
  ArtifactPanelRoot,
  Composer,
  QuestionComposer,
  Transcript,
  useAgentConversation,
} from "../src"
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

beforeAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  })
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const at = "2026-11-10T09:00:00.000Z"
const dana = { type: "user", id: "usr_dana" } as const

const thread = {
  id: "thr_1",
  projectId: "proj",
  kind: "conversation",
  ownerPrincipal: dana,
  owner: { ...dana, displayName: "Dana Reyes" },
  participants: [],
  title: "Revenue report",
  status: "active",
  messageCount: 2,
  activeRunId: null,
  createdAt: at,
  updatedAt: at,
}

const message = (id: string, role: "user" | "assistant", parts: AgentMessage["parts"]) => ({
  id,
  projectId: "proj",
  threadId: thread.id,
  runId: role === "assistant" ? "run_1" : null,
  role,
  seq: role === "user" ? 1 : 2,
  parts,
  annotations: [],
  contentVersion: 1,
  createdAt: at,
})

// The Agent's reply ends on its question: the conversation waits for Dana's answer.
const messages = [
  message("msg_1", "user", [{ type: "text", text: "Build the revenue report" }]),
  message("msg_2", "assistant", [
    {
      type: "tool-call",
      toolCallId: "ask_1",
      toolName: "ask",
      state: "output-available",
      input: { questions: [{ question: "Which year?", choices: ["2025", "2026"] }] },
      output: { status: "asked" },
    },
  ]),
]

/** The API as the conversation reads it, keeping the messages the chat posts. */
function api(sent: Record<string, unknown>[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname

    if (path === "/api/agent") {
      return Response.json({ name: "Sixb", model: { provider: "gateway", modelId: "sonnet" } })
    }
    if (path === "/api/models") {
      return Response.json({
        language: [],
        image: [],
        audio: { speech: [], transcription: [] },
        capabilities: { run: false },
      })
    }
    if (path === `/api/agent-threads/${thread.id}`) return Response.json(thread)
    if (path === `/api/agent-threads/${thread.id}/messages` && request.method === "POST") {
      sent.push((await request.json()) as Record<string, unknown>)
      return Response.json(
        {
          run: {
            id: "run_2",
            projectId: "proj",
            threadId: thread.id,
            triggerMessageId: "msg_3",
            status: "queued",
            attempt: 0,
            streamId: "stream_2",
            requestedBy: dana,
            createdAt: at,
          },
        },
        { status: 202 }
      )
    }
    if (path === `/api/agent-threads/${thread.id}/messages`) {
      return Response.json({ messages, authors: [], hasMore: false, total: messages.length })
    }
    if (path === `/api/agent-threads/${thread.id}/runs`) {
      return Response.json({ runs: [], hasMore: false, total: 0 })
    }

    return Response.json({ error: "Not found" }, { status: 404 })
  }
}

// The custom chat the models docs show: the question takes the composer's place while it asks.
function CustomChat() {
  const conversation = useAgentConversation({ threadId: thread.id, onThreadCreated: () => {} })
  return (
    <ArtifactPanelRoot scopeKey={thread.id}>
      <Transcript
        {...conversation.transcriptProps}
        onAnswer={conversation.questionProps?.onAnswer}
      />
      {conversation.questionProps && <QuestionComposer {...conversation.questionProps} />}
      <div hidden={conversation.questionProps !== null}>
        <Composer {...conversation.composerProps} placeholder="Ask about revenue" />
      </div>
    </ArtifactPanelRoot>
  )
}

// A chat built before QuestionComposer: the transcript and the composer alone.
function TranscriptAndComposerChat() {
  const conversation = useAgentConversation({ threadId: thread.id, onThreadCreated: () => {} })
  return (
    <ArtifactPanelRoot scopeKey={thread.id}>
      <Transcript {...conversation.transcriptProps} />
      <Composer {...conversation.composerProps} placeholder="Ask about revenue" />
    </ArtifactPanelRoot>
  )
}

function renderChat(Chat: () => ReactNode = CustomChat) {
  const sent: Record<string, unknown>[] = []
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
        <Chat />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { view, sent }
}

// Reproduce: drop QuestionComposer from @sixb/app's index; the chat cannot render it. Drop
// `questionProps` from useAgentConversation; the question has nothing to show it.
test("a custom chat asks the Agent's question in the composer's place, and sends the answer", async () => {
  const { view, sent } = renderChat()

  const question = await view.findByRole("region", { name: "The agent's question" })
  expect(question.textContent).toContain("Which year?")
  // The reply leaves the question to the composer: it is asked once.
  expect(view.getAllByText("Which year?")).toHaveLength(1)

  fireEvent.click(view.getByRole("button", { name: /2026/ }))
  await waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({ text: "2026" })
})

// Reproduce: drop the set-aside check from `asking` in useAgentConversation; Escape then leaves the
// question in the composer's place.
test("a question set aside reads in the reply, and the composer comes back", async () => {
  const { view } = renderChat()

  const question = await view.findByRole("region", { name: "The agent's question" })
  fireEvent.keyDown(question, { key: "Escape" })

  await waitFor(() =>
    expect(view.queryByRole("region", { name: "The agent's question" })).toBeNull()
  )
  expect(view.getByText("Which year?")).toBeDefined()
  expect(view.getByRole("textbox", { name: "Message" }).closest("[hidden]")).toBeNull()
})

// Reproduce: give transcriptProps `onAnswer` in useAgentConversation; the reply then leaves the
// question to a composer this chat never shows, and it is nowhere on screen.
test("a chat with the transcript and the composer alone shows the question in the reply", async () => {
  const { view } = renderChat(TranscriptAndComposerChat)

  expect(await view.findByText("Which year?")).toBeDefined()
  expect(view.getByText("Waiting for an answer")).toBeDefined()
})
