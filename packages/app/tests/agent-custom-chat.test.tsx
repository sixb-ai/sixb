import { expect, test } from "bun:test"
import {
  getAgentOptions,
  getAgentThreadOptions,
  listAgentThreadMessagesOptions,
  listAgentThreadRunsOptions,
  listModelsOptions,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import {
  type AgentConversationMessage,
  type AgentMessage,
  AgentMessageBody,
  type AgentRun,
  type AgentThread,
  AgentToolPart,
  ArtifactPanelRoot,
  Composer,
  defineAgentToolView,
  Transcript,
  useAgentConversation,
} from "../src"
import { AgentToolViewsProvider } from "../src/agent/tool-views/registry"

const thread: AgentThread = {
  id: "thread",
  projectId: "project",
  kind: "conversation",
  ownerPrincipal: { type: "user", id: "user" },
  owner: { type: "user", id: "user" },
  participants: [],
  title: "Overdue invoices",
  status: "active",
  activeRunId: null,
  messageCount: 1,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
}

const question: AgentMessage = {
  id: "message-user",
  projectId: "project",
  threadId: thread.id,
  runId: null,
  role: "user",
  seq: 1,
  parts: [{ type: "text", text: "Which invoices are overdue?" }],
  annotations: [],
  contentVersion: 1,
  createdAt: "2026-10-01T12:00:00.000Z",
}

const failedRun: AgentRun = {
  id: "run",
  projectId: "project",
  kind: "conversation",
  threadId: thread.id,
  triggerMessageId: question.id,
  requestedBy: { type: "user", id: "user" },
  attempt: 0,
  streamId: "agents.runs.run",
  status: "failed",
  createdAt: "2026-10-01T12:00:00.000Z",
}

// A chat built only from `@sixb/app`: the conversation's two prop sets wire the transcript and the
// composer completely, down to retrying a run that failed before it answered.
function CustomChat({ threadId }: { readonly threadId: string | null }) {
  const conversation = useAgentConversation({ threadId, onThreadCreated: () => {} })
  return (
    <ArtifactPanelRoot scopeKey={threadId ?? "draft"}>
      <Transcript {...conversation.transcriptProps} />
      <Composer {...conversation.composerProps} placeholder="Ask about invoices" />
    </ArtifactPanelRoot>
  )
}

/** A query cache holding the thread as the API would answer it. */
function seeded(messages: readonly AgentMessage[], runs: readonly AgentRun[]): QueryClient {
  // Fresh data, so mounting does not refetch: the transcript holds its run markers while it loads.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  queryClient.setQueryData(getAgentOptions().queryKey, {
    name: "Assistant",
    model: { provider: "test", modelId: "test-model" },
  })
  queryClient.setQueryData(listModelsOptions().queryKey, {
    language: [],
    image: [],
    audio: { speech: [], transcription: [] },
    capabilities: { run: false },
  })
  queryClient.setQueryData(
    getAgentThreadOptions({ path: { threadId: thread.id } }).queryKey,
    thread
  )
  queryClient.setQueryData(
    listAgentThreadMessagesOptions({ path: { threadId: thread.id }, query: { order: "asc" } })
      .queryKey,
    { messages: [...messages], authors: [], hasMore: false, total: messages.length }
  )
  queryClient.setQueryData(
    listAgentThreadRunsOptions({
      path: { threadId: thread.id },
      query: { limit: "50", order: "desc" },
    }).queryKey,
    { runs: [...runs], hasMore: false, total: runs.length }
  )
  return queryClient
}

test("a custom chat renders a thread from the conversation's transcript and composer props", () => {
  // Removal proof: drop `onRetry` from `transcriptProps` in useAgentConversation; "Retry" is gone.
  const queryClient = seeded([question], [failedRun])

  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CustomChat threadId={thread.id} />
      </QueryClientProvider>
    )

    expect(html).toContain("Which invoices are overdue?")
    expect(html).toContain("I couldn’t get a response started.")
    expect(html).toContain("Retry")
    expect(html).toContain('placeholder="Ask about invoices"')
  } finally {
    queryClient.clear()
  }
})

test("a conversation too long for its model says how to go on, and offers no retry", () => {
  // Removal proof: drop the error-code check from canRetry in useAgentConversation; "Retry" then
  // runs again a turn that fails the same way.
  const tooLong: AgentRun = {
    ...failedRun,
    error: {
      code: "agent.context_limit_exceeded",
      message: "This conversation is too long for the model's context window.",
      retryable: false,
      at: "2026-10-01T12:00:01.000Z",
    },
  }
  const queryClient = seeded([question], [tooLong])

  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <CustomChat threadId={thread.id} />
      </QueryClientProvider>
    )

    expect(html).toContain(
      "This conversation is too long for this model. Start a new thread, or pick a model with a larger context."
    )
    expect(html).not.toContain("I couldn’t get a response started.")
    expect(html).not.toContain("Retry")
  } finally {
    queryClient.clear()
  }
})

const answer: AgentMessage = {
  ...question,
  id: "message-answer",
  runId: "run",
  role: "assistant",
  seq: 2,
  parts: [
    {
      type: "tool-call",
      toolCallId: "call-invoices",
      toolName: "list_overdue_invoices",
      state: "output-available",
      input: { days: 30 },
      output: { count: 2 },
    },
    {
      type: "tool-call",
      toolCallId: "call-customers",
      toolName: "lookup_customer",
      state: "output-available",
      input: { id: "cus_1" },
      output: { name: "Acme" },
    },
    { type: "text", text: "Two invoices are overdue." },
  ],
}

const answeredRun: AgentRun = { ...failedRun, status: "succeeded" }

/** Draws each message in a bubble of its own; a failed turn, from the turn. */
function Bubbles({ draw }: { readonly draw: (message: AgentConversationMessage) => ReactNode }) {
  const conversation = useAgentConversation({ threadId: thread.id, onThreadCreated: () => {} })
  return (
    <ArtifactPanelRoot scopeKey={thread.id}>
      {conversation.messages.map((message) => (
        <article key={message.key} data-bubble={message.role === "user" ? "mine" : "agent"}>
          {draw(message)}
        </article>
      ))}
      {conversation.turn.kind === "failed" ? <p>The agent could not answer.</p> : null}
    </ArtifactPanelRoot>
  )
}

const views = [
  defineAgentToolView("list_overdue_invoices", { placement: "answer" }).render(({ output }) => (
    <strong>{`${(output as { count: number } | undefined)?.count} overdue`}</strong>
  )),
]

function renderBubbles(
  draw: (message: AgentConversationMessage) => ReactNode,
  runs: readonly AgentRun[] = [answeredRun]
) {
  const queryClient = seeded([question, answer], runs)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgentToolViewsProvider views={views}>
            <Bubbles draw={draw} />
          </AgentToolViewsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  } finally {
    queryClient.clear()
  }
}

const userText = (message: AgentConversationMessage) =>
  message.parts.map((part, index) => (part.type === "text" ? <p key={index}>{part.text}</p> : null))

test("a custom chat draws its own bubbles, with the agent's replies as the chat draws them", () => {
  // Removal proof: return null from AgentMessageBody; the reply's text and work are gone.
  const html = renderBubbles((message) =>
    message.role === "assistant" ? <AgentMessageBody message={message} /> : userText(message)
  )

  expect(html).toContain('<article data-bubble="mine"><p>Which invoices are overdue?</p></article>')
  const reply = html.slice(html.indexOf('<article data-bubble="agent">'))
  expect(reply).toContain("2 steps")
  expect(reply).toContain("Two invoices are overdue.")
  // The project's view placed in the answer comes with the reply.
  expect(reply).toContain("<strong>2 overdue</strong>")
  expect(html).not.toContain("The agent could not answer.")

  // A turn that failed before answering is the chat's to tell, from the turn.
  const failed = renderBubbles(
    (message) => userText(message),
    [{ ...failedRun, id: "run-next", triggerMessageId: "message-next" }]
  )
  expect(failed).toContain("The agent could not answer.")
})

test("a custom chat draws a reply's parts itself, each tool call through AgentToolPart", () => {
  // Removal proof: render BuiltInToolRow alone in AgentToolPart; the project's view is gone.
  const html = renderBubbles((message) =>
    message.parts.map((part, index) => {
      if (part.type === "text") return <p key={index}>{part.text}</p>
      if (part.type === "tool") return <AgentToolPart key={part.toolCallId} part={part} />
      return null
    })
  )

  // The project's view of a tool, wherever its placement says the chat puts it.
  expect(html).toContain("<strong>2 overdue</strong>")
  // Any other tool: the framework's row to inspect it.
  expect(html).toContain("lookup_customer")
  expect(html).toContain("<p>Two invoices are overdue.</p>")
  expect(html).not.toContain("2 steps")
})
