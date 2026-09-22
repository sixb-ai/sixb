import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { Window } from "happy-dom"
import { useState } from "react"
import {
  DocumentPreviewRoot,
  useDocumentPreview,
} from "../../agent-ui/src/document-preview/DocumentPreviewRoot"
import type { AgentDocumentSource } from "../../agent-ui/src/document-preview/types"

const browser = new Window({ url: "https://app.sixb.test" })
const globals = [
  "localStorage",
  "sessionStorage",
  "window",
  "self",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()
beforeAll(() => {
  const values = browser as unknown as Record<string, unknown>
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window" || key === "self"
          ? browser
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : values[key],
    })
  }
})
afterEach(() => {
  cleanup()
  browser.localStorage.clear()
})
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})
const document: AgentDocumentSource = {
  id: "file",
  kind: "image",
  threadId: "thread",
  messageId: "message",
  partIndex: 0,
  fileRef: {
    blobId: "blob",
    digest: "a".repeat(64),
    sizeBytes: 1,
    fileName: "example.png",
    mediaType: "image/png",
  },
  inlineUrl: "https://app.sixb.test/file",
  downloadUrl: "https://app.sixb.test/file",
}
function Conversation() {
  const [draft, setDraft] = useState("")
  const preview = useDocumentPreview()
  return (
    <>
      <input
        aria-label="Draft"
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <button type="button" onClick={() => preview?.openDocument(document)}>
        Open file
      </button>
      <output data-testid="active-file">{preview?.activeDocumentId ?? "none"}</output>
    </>
  )
}

test("dock/full-page transitions retain the conversation instance and open documents", () => {
  // Reproduce against the pre-review implementation: toggling compact swaps the conversation's
  // parent and restores stale preview state. Both draft and selected file assertions fail.
  const host = globalThis.document.createElement("div")
  globalThis.document.body.append(host)
  const view = (compact: boolean) => (
    <DocumentPreviewRoot
      compact={compact}
      overlayHost={compact ? host : null}
      persistenceKey="thread"
    >
      <Conversation />
    </DocumentPreviewRoot>
  )
  const ui = render(view(true))
  const input = ui.getByLabelText("Draft")
  fireEvent.input(input, { target: { value: "Keep this unsent draft" } })
  fireEvent.click(ui.getByText("Open file"))
  expect(ui.getByTestId("active-file").textContent).toBe("file")
  ui.rerender(view(false))
  expect(ui.getByLabelText("Draft")).toBe(input)
  expect((ui.getByLabelText("Draft") as HTMLInputElement).value).toBe("Keep this unsent draft")
  expect(ui.getByTestId("active-file").textContent).toBe("file")
  ui.rerender(view(true))
  expect(ui.getByLabelText("Draft")).toBe(input)
  expect(ui.getByTestId("active-file").textContent).toBe("file")
  host.remove()
})
