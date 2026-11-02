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

describe("a call's saved output", () => {
  // Removal proof: leave outputFile out of normalizeDurableParts' tool, or SavedOutputLink out of
  // ToolCallRow; the whole output can then no longer be opened from the conversation.
  test("opens beside the conversation from a quiet link under its call", async () => {
    const log: AgentFileRef = {
      blobId: `blob_${"c".repeat(64)}`,
      digest: `sha256:${"c".repeat(64)}`,
      sizeBytes: 421_888,
      fileName: "call-build.txt",
      mediaType: "text/plain",
    }
    const build: AgentMessagePart = {
      type: "tool-call",
      toolCallId: "call-build",
      toolName: "run_build",
      input: { target: "all" },
      state: "output-available",
      output: "The first 30 KB of the build log…",
      outputFile: { fileRef: log, path: "tool-outputs/call-build.txt" },
    }
    const parts = normalizeDurableParts([build], {
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
    const work = view
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("1 step"))
    if (!work) throw new Error("Expected the work's trigger.")
    await act(async () => {
      fireEvent.click(work)
    })

    const link = view.getByRole("button", { name: /Full output/ })
    expect(link.textContent).toContain("412 KB")
    expect(link.getAttribute("aria-pressed")).toBe("false")
    await act(async () => {
      fireEvent.click(link)
    })
    expect(link.getAttribute("aria-pressed")).toBe("true")
  })
})
