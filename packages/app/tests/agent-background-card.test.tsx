import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render as mount } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { ArtifactPanelRoot } from "../src/agent/artifact-panel"
import { BackgroundCardsContext, type TranscriptBackground } from "../src/agent/background/context"
import { readThreadBackground } from "../src/agent/background/interpret"
import { AssistantBody } from "../src/agent/components/message-parts"
import { normalizeDurableParts } from "../src/agent/parts"
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

// A running card's clock ticks: nothing of it may outlive its test.
afterEach(cleanup)

const STATE = {
  id: "bg_1a2b3c",
  command: "bun run dev --port 3000",
  status: "running",
  startedAt: "2026-11-04T10:00:00.000Z",
  outputPath: "/tmp/.sixb/agent/background/bg_1a2b3c.log",
}

const parts = [
  {
    type: "tool-call",
    toolCallId: "start",
    toolName: "bash",
    state: "output-available",
    input: { command: STATE.command, run_in_background: true },
    output: STATE,
  },
  {
    type: "tool-call",
    toolCallId: "read",
    toolName: "bash_output",
    state: "output-available",
    input: { id: STATE.id },
    output: { ...STATE, output: "ready on http://localhost:3000\n" },
  },
  { type: "text", text: "The docs are served on port 3000." },
] as Parameters<typeof normalizeDurableParts>[0]

function render(background: TranscriptBackground) {
  const messages = [
    {
      role: "assistant" as const,
      runId: "run_1",
      parts: parts.map((part) => ({
        ...part,
        type: part.type === "tool-call" ? "tool" : part.type,
      })),
    },
  ] as unknown as Parameters<typeof readThreadBackground>[0]
  const context = { ...background, thread: readThreadBackground(messages), liveRunId: null }

  return mount(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ArtifactPanelRoot scopeKey="thread">
          <BackgroundCardsContext.Provider value={context}>
            <AssistantBody parts={normalizeDurableParts(parts)} />
          </BackgroundCardsContext.Provider>
        </ArtifactPanelRoot>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** Open the work's steps, as a reader who wants the detail does. */
async function openSteps(view: ReturnType<typeof render>) {
  const steps = view
    .getAllByRole("button")
    .find((button) => / steps?$/.test(button.textContent ?? ""))
  if (!steps) throw new Error("Expected the turn's work.")
  await act(async () => {
    fireEvent.click(steps)
  })
}

describe("a background command's card", () => {
  // Removal proofs: render the card under the work again (it shows while the steps are closed);
  // render the start's quiet line instead of BackgroundCommandStep (opened, nothing says it runs).
  test("shows in the opened steps what runs, and its owner stops it there", async () => {
    const stops: unknown[] = []
    const view = render({
      source: {
        onComputer: true,
        online: true,
        live: [{ ...STATE, status: "running" }],
      },
      stop: async (command) => {
        stops.push(command)
      },
    })

    // Closed, the work says nothing of it.
    const name = `Background command: ${STATE.command}`
    expect(view.queryByRole("region", { name })).toBeNull()
    expect(view.container.textContent).not.toContain("Running")

    await openSteps(view)
    const card = view.getByRole("region", { name })
    expect(card.textContent).toContain("Running")
    expect(card.getAttribute("data-background-status")).toBe("running")

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop" }))
    })
    expect(stops).toEqual([{ id: STATE.id, startedAt: STATE.startedAt }])
    expect(card.textContent).toContain("Stopping…")
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull()

    // What the agent read is a click away.
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Output/ }))
    })
    expect(card.textContent).toContain("ready on http://localhost:3000")
  })

  test("says how it ended, with no Stop", async () => {
    const view = render({
      source: {
        onComputer: true,
        online: true,
        live: [{ ...STATE, status: "exited", exitCode: 1, endedAt: "2026-11-04T10:00:12.000Z" }],
      },
      stop: async () => {},
    })

    await openSteps(view)
    const card = view.getByRole("region", { name: `Background command: ${STATE.command}` })
    expect(card.textContent).toContain("Failed · exit code 1")
    expect(card.textContent).toContain("12s")
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull()
  })
})
