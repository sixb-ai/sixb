import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as mount } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { latestWorkLabel } from "../src/agent/activity-label"
import { ArtifactPanelRoot } from "../src/agent/artifact-panel"
import { AssistantBody } from "../src/agent/components/message-parts"
import { type NormalizedTool, normalizeDurableParts } from "../src/agent/parts"
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

const input = { key: "compare-suppliers", text: "Skip Globex; focus on payment terms." }

describe("a message the Agent sends a child", () => {
  // Removal proof: drop the message_agent title from ToolCallRow; the row reads message_agent.
  test("reads as what it told which child", async () => {
    const parts = normalizeDurableParts([
      {
        type: "tool-call",
        toolCallId: "steer",
        toolName: "message_agent",
        state: "output-available",
        input,
        output: { runId: "run_child", status: "running", delivery: "next-step" },
      },
    ])
    const view = mount(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ArtifactPanelRoot scopeKey="thread">
            <AssistantBody parts={parts} />
          </ArtifactPanelRoot>
        </MemoryRouter>
      </QueryClientProvider>
    )
    const worked = view
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("Worked"))
    if (!worked) throw new Error("Expected the turn's work.")
    await act(async () => {
      fireEvent.click(worked)
    })

    expect(view.container.textContent).toContain(
      "Told compare-suppliers: Skip Globex; focus on payment terms."
    )
    expect(view.container.textContent).not.toContain("message_agent")
  })

  test("says which child it is messaging while the call runs", () => {
    const tool: NormalizedTool = { toolName: "message_agent", state: "input-available", input }

    expect(latestWorkLabel([{ kind: "tool", tool }])).toBe("Messaging compare-suppliers")
  })
})
