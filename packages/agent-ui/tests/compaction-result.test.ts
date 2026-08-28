import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageView } from "../src/components/MessageView"
import type { AgentMessage } from "../src/types"

test("durable compacted responses expose their continuation summary", () => {
  const html = renderToStaticMarkup(
    createElement(MessageView, {
      message: assistantMessage({
        checkpointId: "checkpoint-1",
        summary: "The user asked for organization research.",
        createdAt: "2026-08-28T10:00:00.000Z",
      }),
    })
  )

  expect(html).toContain("Earlier conversation condensed")
  expect(html).toContain("View summary")
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain("Here is the completed research.")
})

test("ordinary responses do not render a compaction disclosure", () => {
  const html = renderToStaticMarkup(createElement(MessageView, { message: assistantMessage() }))

  expect(html).not.toContain("Earlier conversation condensed")
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
