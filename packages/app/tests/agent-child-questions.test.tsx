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

const QUESTION = "Calendar year or the April–March fiscal year?"

/** A `wait_agent` result as the worker stores it: its JSON text in a rich tool result. */
function waited(questions: readonly { readonly key: string; readonly text: string }[]) {
  const answer = {
    results: [{ runId: "run_west", status: "running" }],
    questions: questions.map((question, index) => ({
      ...question,
      runId: `run_${question.key}`,
      id: `run_${question.key}:ask-${index}`,
    })),
  }
  return { kind: "agentToolResult", content: [{ type: "text", text: JSON.stringify(answer) }] }
}

async function openWork(parts: Parameters<typeof normalizeDurableParts>[0]) {
  const view = mount(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ArtifactPanelRoot scopeKey="thread">
          <AssistantBody parts={normalizeDurableParts(parts)} />
        </ArtifactPanelRoot>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const worked = view
    .getAllByRole("button")
    .find((button) => / steps?$/.test(button.textContent ?? ""))
  if (!worked) throw new Error("Expected the turn's work.")
  await act(async () => {
    fireEvent.click(worked)
  })
  return view
}

describe("a child's question in the Agent's work", () => {
  // Removal proofs: drop the wait_agent title from ToolCallRow; the row reads wait_agent. Drop the
  // other questions' rows; East's question is not shown. Drop the answer check from
  // describeMessageAgent; the answer reads as "Told west".
  test("reads as what each child asks, and the answer as what the Agent answered", async () => {
    const view = await openWork([
      {
        type: "tool-call",
        toolCallId: "wait",
        toolName: "wait_agent",
        state: "output-available",
        input: { runIds: ["run_west", "run_east"] },
        output: waited([
          { key: "west", text: QUESTION },
          { key: "east", text: "Which currency?" },
        ]),
      },
      {
        type: "tool-call",
        toolCallId: "answer",
        toolName: "message_agent",
        state: "output-available",
        input: { key: "west", text: "The April–March fiscal year." },
        output: { runId: "run_west", status: "running", delivery: "answer" },
      },
    ])
    const text = view.container.textContent

    expect(text).toContain(`west asks: ${QUESTION}`)
    expect(text).toContain("east asks: Which currency?")
    expect(text).toContain("Answered west: The April–March fiscal year.")
    expect(text).not.toContain("wait_agent")
  })

  test("is what the Agent is doing once its wait returned it", () => {
    const tool: NormalizedTool = {
      toolName: "wait_agent",
      state: "output-available",
      input: { runIds: ["run_west"] },
      output: waited([{ key: "west", text: QUESTION }]),
    }

    expect(latestWorkLabel([{ kind: "tool", tool }])).toBe(`west asks: ${QUESTION}`)
  })
})
