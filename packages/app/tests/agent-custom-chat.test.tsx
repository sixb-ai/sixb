import { expect, test } from "bun:test"
import {
  getAgentOptions,
  getAgentThreadOptions,
  listAgentThreadMessagesOptions,
  listAgentThreadRunsOptions,
  listModelsOptions,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import {
  type AgentMessage,
  type AgentRun,
  type AgentThread,
  ArtifactPanelRoot,
  Composer,
  Transcript,
  useAgentConversation,
} from "../src"

const thread: AgentThread = {
  id: "thread",
  projectId: "project",
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

test("a custom chat renders a thread from the conversation's transcript and composer props", () => {
  // Removal proof: drop `onRetry` from `transcriptProps` in useAgentConversation; "Retry" is gone.
  // Fresh data, so mounting does not refetch: the transcript holds its run markers while it loads.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  queryClient.setQueryData(getAgentOptions().queryKey, {
    name: "Assistant",
    model: { provider: "test", modelId: "test-model" },
  })
  queryClient.setQueryData(listModelsOptions().queryKey, { language: [] })
  queryClient.setQueryData(
    getAgentThreadOptions({ path: { threadId: thread.id } }).queryKey,
    thread
  )
  queryClient.setQueryData(
    listAgentThreadMessagesOptions({ path: { threadId: thread.id }, query: { order: "asc" } })
      .queryKey,
    { messages: [question] }
  )
  queryClient.setQueryData(
    listAgentThreadRunsOptions({
      path: { threadId: thread.id },
      query: { limit: "50", order: "desc" },
    }).queryKey,
    { runs: [failedRun] }
  )

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
