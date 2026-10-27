import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as mount } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { ArtifactPanelRoot } from "../src/agent/artifact-panel"
import { AssistantBody } from "../src/agent/components/message-parts"
import { normalizeDurableParts } from "../src/agent/parts"
import type { AgentFileRef, AgentMessagePart } from "../src/agent/types"
import { messageFileSource } from "../src/artifacts/file-source"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const chart: AgentFileRef = {
  blobId: `blob_${"b".repeat(64)}`,
  digest: `sha256:${"b".repeat(64)}`,
  sizeBytes: 2_048,
  fileName: "margins.png",
  mediaType: "image/png",
}

/** A project tool's answer and its chart, as a rich result. */
const waited: AgentMessagePart = {
  type: "tool-call",
  toolCallId: "call-margins",
  toolName: "chart_margins",
  input: { quarter: "Q3" },
  state: "output-available",
  output: {
    kind: "agentToolResult",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          results: [{ runId: "agt_run_child", status: "succeeded", text: "Margins fell." }],
        }),
      },
      { type: "file", fileRef: chart },
    ],
  },
}

describe("a tool's files in the work trace", () => {
  test("a tool without a view of its own shows its result as JSON, and its files", async () => {
    // Removal proof: render tool.output as it is in ToolCallRow, and the result reads as an
    // escaped string; drop the file cards, and the chart is not there.
    const parts = normalizeDurableParts([waited], {
      fileSource: (fileRef, path) =>
        messageFileSource({
          threadId: "thread",
          messageId: "message",
          path,
          fileRef,
          baseUrl: "https://example.test",
        }),
    })
    const view = mount(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ArtifactPanelRoot scopeKey="thread">
            <AssistantBody parts={parts} />
          </ArtifactPanelRoot>
        </MemoryRouter>
      </QueryClientProvider>
    )
    // Open the turn's work, then the call.
    for (const label of ["1 step", "chart_margins"]) {
      const trigger = view
        .getAllByRole("button")
        .find((button) => button.textContent?.includes(label))
      if (!trigger) throw new Error(`Expected the ${label} trigger.`)
      await act(async () => {
        fireEvent.click(trigger)
      })
    }

    const html = view.container.innerHTML
    expect(html).toContain('"status": "succeeded"')
    expect(html).not.toContain("agentToolResult")
    expect(view.getByLabelText("Preview margins.png")).toBeDefined()
  })
})
