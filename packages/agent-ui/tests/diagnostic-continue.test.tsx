import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MessageView } from "../src/components/MessageView"
import type { AgentMessage } from "../src/types"

const browserWindow = new Window({ url: "https://app.sixb.test/" })
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event"]
const previous = new Map<string, PropertyDescriptor | undefined>()

beforeAll(() => {
  const values = browserWindow as unknown as Record<string, unknown>
  for (const key of [...globals, "IS_REACT_ACT_ENVIRONMENT"]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    const value =
      key === "window" ? browserWindow : key === "IS_REACT_ACT_ENVIRONMENT" ? true : values[key]
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
})

afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browserWindow.close()
})

test("Continue on a cut-short answer sends the continuation", async () => {
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
  const container = browserWindow.document.createElement("div")
  browserWindow.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => {
    root.render(<MessageView message={message} onContinue={() => continued++} />)
  })
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Continue"
  )
  await act(async () => {
    button?.click()
  })
  expect(continued).toBe(1)
  await act(async () => root.unmount())
})
