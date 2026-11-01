import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { type AgentConversationMessage, Transcript } from "../src"

const reply: AgentConversationMessage = {
  key: "run:run",
  id: null,
  role: "assistant",
  status: "streaming",
  runId: "run",
  parts: [{ type: "text", text: "Reading the first chapters.", streaming: true }],
  context: [],
  diagnostics: [],
}

const responding = {
  kind: "responding" as const,
  runId: "run",
  waitingLonger: false,
  reconnecting: false,
  answeringFor: null,
  canStop: false,
  canRetry: false,
  canContinue: false,
  stopping: false,
  retrying: false,
  continuing: false,
}

// Reproduce: render nothing after a live reply in TranscriptView; a turn that compacts after it
// has streamed then shows no sign of it.
test("a turn that compacts after it streamed says so under its reply", () => {
  const queryClient = new QueryClient()
  const render = (compacting: boolean, contextFull = false) =>
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Transcript
            threadId="thread"
            messages={[reply]}
            turn={{ ...responding, compacting, contextFull }}
          />
        </MemoryRouter>
      </QueryClientProvider>
    )

  try {
    expect(render(true)).toContain("Condensing earlier conversation…")
    expect(render(false)).not.toContain("Condensing earlier conversation…")

    // Reproduce: drop `contextFull` from the marker; a refused request condenses like any other.
    expect(render(true, true)).toContain("Context is full — condensing to continue…")
    expect(render(true, true)).not.toContain("Condensing earlier conversation…")
  } finally {
    queryClient.clear()
  }
})
