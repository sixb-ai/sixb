import { expect, test } from "bun:test"
import { fireEvent, render } from "@testing-library/react"
import { MessageView } from "../src/agent/components/message-view"
import type { AgentMessage } from "../src/agent/types"
import { installDom } from "./helpers/dom"

installDom(["document", "navigator", "Node", "Element", "HTMLElement", "Event"])

test("Continue on a cut-short answer sends the continuation", () => {
  // Removal proof: drop `onClick={onContinue}` from the diagnostic's button; nothing is sent.
  const message: AgentMessage = {
    id: "answer",
    projectId: "project",
    threadId: "thread",
    runId: "run",
    role: "assistant",
    seq: 2,
    parts: [{ type: "text", text: "Partial" }],
    annotations: [
      {
        code: "output_limit_reached",
        severity: "warning",
        scope: "run",
        message: "Developer copy.",
      },
    ],
    contentVersion: 1,
    createdAt: "2026-10-12T10:00:00.000Z",
  }
  let continued = 0
  const view = render(<MessageView message={message} onContinue={() => continued++} />)

  fireEvent.click(view.getByRole("button", { name: "Continue" }))

  expect(continued).toBe(1)
})
