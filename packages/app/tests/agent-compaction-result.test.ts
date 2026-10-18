import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageView } from "../src/agent/components/message-view"
import type { AgentMessage } from "../src/agent/types"

test("only durable compacted responses expose their continuation summary", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: assistantMessage({
        checkpointId: "checkpoint-1",
        summary: "The user asked for organization research.",
        createdAt: "2026-08-28T10:00:00.000Z",
      }),
    })
  )

  expect(html).toContain("Condensed conversation")
  expect(html).not.toContain("View summary")
  expect(html).toContain("group-hover:opacity-100")
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain("Here is the completed research.")

  const ordinary = renderToStaticMarkup(createElement(MessageView, { message: assistantMessage() }))
  expect(ordinary).not.toContain("Condensed conversation")
})

function assistantMessage(compaction?: AgentMessage["compaction"]): AgentMessage {
  return {
    id: "message-1",
    projectId: "project-1",
    threadId: "thread-1",
    runId: "run-1",
    role: "assistant",
    seq: 4,
    parts: [{ type: "text", text: "Here is the completed research." }],
    annotations: [],
    ...(compaction ? { compaction } : {}),
    contentVersion: 1,
    createdAt: "2026-08-28T10:00:01.000Z",
  }
}
