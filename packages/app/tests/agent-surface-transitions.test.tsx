import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { Window } from "happy-dom"
import { useState } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { OperationsAssistant } from "../../../examples/northline/app/_components/operations-assistant"
import NorthlineConversationPage from "../../../examples/northline/app/chat/[id]/page"
import { AgentSurface } from "../../agent-ui/src/AgentSurface"
import {
  DocumentPreviewRoot,
  useDocumentPreview,
} from "../../agent-ui/src/document-preview/DocumentPreviewRoot"
import type { AgentDocumentSource } from "../../agent-ui/src/document-preview/types"
import { AgentChatPage } from "../../agent-ui/src/react-router"
import { createSixbClient } from "../../client/src"
import {
  getAgentQueryKey,
  getAgentThreadQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsQueryKey,
  SixbProvider,
  searchObjectsQueryKey,
} from "../../client/src/hooks"

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
afterEach(async () => {
  cleanup()
  await Bun.sleep(0)
  browser.localStorage.clear()
  browser.sessionStorage.clear()
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

function conversationCache() {
  const cache = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  cache.setQueryData(getAgentQueryKey(), {
    name: "Test assistant",
    model: { provider: "test", modelId: "test" },
  })
  for (const id of ["a", "b"]) {
    cache.setQueryData(getAgentThreadQueryKey({ path: { threadId: id } }), {
      id,
      title: `Conversation ${id}`,
      activeRunId: null,
    })
    cache.setQueryData(
      listAgentThreadMessagesQueryKey({ path: { threadId: id }, query: { order: "asc" } }),
      { messages: [] }
    )
    cache.setQueryData(
      listAgentThreadRunsQueryKey({
        path: { threadId: id },
        query: { limit: "50", order: "desc" },
      }),
      { runs: [] }
    )
  }
  return cache
}

test("a pending route change cannot restore the thread cleared by New thread", () => {
  // Reproduce by adding sessionState.threadId to AgentSurface's controlled-thread effect deps.
  // Hold the old route prop for a render, as React Router 7 does while navigation is pending.
  const cache = conversationCache()
  const view = (threadId?: string | null) => (
    <QueryClientProvider client={cache}>
      <AgentSurface threadId={threadId} fullPage persistenceKey={false} />
    </QueryClientProvider>
  )
  const ui = render(view("a"))
  fireEvent.click(ui.getByRole("button", { name: "New thread" }))
  ui.rerender(view(undefined))
  expect(
    Boolean(ui.queryByRole("button", { name: "Thread history. Current: Conversation a" }))
  ).toBe(false)
  ui.rerender(view("b"))
  expect(ui.getByRole("button", { name: "Thread history. Current: Conversation b" })).toBeTruthy()
  ui.rerender(view(undefined))
  expect(ui.getByRole("button", { name: "Thread history. Current: Conversation b" })).toBeTruthy()
  ui.unmount()
  cache.clear()
})

function NorthlineRoutes() {
  const location = useLocation()
  return (
    <>
      <output data-testid="route">
        {location.pathname}
        {location.search}
      </output>
      <OperationsAssistant />
      <Routes>
        <Route path="/chat/:id" element={<NorthlineConversationPage />} />
        <Route path="*" element={null} />
      </Routes>
    </>
  )
}

test("Northline expands and minimizes the same conversation and unsent composer", async () => {
  // Restore OperationsAssistant's /chat early return and the separate chat page AgentPanel
  // to reproduce: expansion replaces the textarea and discards its draft and explicit context.
  const cache = conversationCache()
  browser.sessionStorage.setItem(
    "sixb.agent-ui.surface.v1:agents",
    JSON.stringify({
      mode: "dock",
      dockWidth: 384,
      threadId: "a",
    })
  )
  cache.setQueryData(searchObjectsQueryKey({ query: { q: "case", limit: "20" } }), { items: [] })
  const client = createSixbClient({
    baseUrl: "https://app.sixb.test/api",
    fetch: Object.assign(
      async () =>
        Response.json({
          blobId: "attachment",
          digest: `sha256:${"a".repeat(64)}`,
          sizeBytes: 5,
          fileName: "notes.txt",
          mediaType: "text/plain",
        }),
      { preconnect: fetch.preconnect }
    ),
  })
  const ui = render(
    <SixbProvider client={client}>
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/service-cases/case-1?status=open"]}>
          <NorthlineRoutes />
        </MemoryRouter>
      </QueryClientProvider>
    </SixbProvider>
  )
  const input = ui.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
  // React DOM was imported before Happy DOM; keyup also exercises its input-event fallback.
  fireEvent.input(input, { target: { value: "@case", selectionStart: 5 } })
  fireEvent.keyUp(input, { key: "@" })
  fireEvent.click(ui.getByRole("option", { name: /Service case · Case 1/ }))
  const fileInput = ui.container.querySelector("input[type=file]")
  expect(fileInput).not.toBeNull()
  fireEvent.change(fileInput as HTMLInputElement, {
    target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
  })
  await waitFor(() => expect(ui.queryByText("Uploading…")?.textContent).toBeUndefined())
  expect(ui.queryByText("Upload failed")?.parentElement?.parentElement?.title).toBeUndefined()
  fireEvent.input(input, { target: { value: "Follow up on this case" } })
  fireEvent.keyUp(input, { key: "e" })
  fireEvent.click(ui.getByRole("button", { name: "Expand conversation" }))
  expect(ui.getByTestId("route").textContent).toBe("/chat/a")
  expect(ui.container.querySelectorAll("[data-agent-surface=full]")).toHaveLength(1)
  expect(ui.getByRole("textbox", { name: "Message" }) === input).toBe(true)
  expect(input.value).toBe("Follow up on this case")
  expect(ui.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy()
  expect(ui.getByRole("button", { name: "Remove Service case · Case 1 context" })).toBeTruthy()
  fireEvent.click(ui.getByRole("button", { name: "Move assistant to side panel" }))
  expect(ui.getByTestId("route").textContent).toBe("/service-cases/case-1?status=open")
  expect(ui.getByRole("textbox", { name: "Message" }) === input).toBe(true)
  expect(input.value).toBe("Follow up on this case")
  expect(ui.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy()
  expect(ui.getByRole("button", { name: "Remove Service case · Case 1 context" })).toBeTruthy()
  ui.unmount()
  cache.clear()
})

test.each(["/agents", "/agents/a"])("standalone %s has an exit even on a direct link", (path) => {
  // Remove AgentChatPage's Back to app header action to reproduce the missing in-app exit.
  const cache = conversationCache()
  const ui = render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/agents/:threadId?" element={<AgentChatPage />} />
          <Route path="/" element={<p>Application home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  fireEvent.click(ui.getByRole("button", { name: "Back to app" }))
  expect(ui.getByText("Application home")).toBeTruthy()
  ui.unmount()
  cache.clear()
})
