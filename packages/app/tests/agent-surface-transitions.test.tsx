import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { Window } from "happy-dom"
import { useState } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { OperationsAssistant } from "../../../examples/northline/app/_components/operations-assistant"
import NorthlineConversationPage from "../../../examples/northline/app/chat/[id]/page"
import { createSixbClient } from "../../client/src"
import {
  getAgentQueryKey,
  getAgentThreadQueryKey,
  getArtifactQueryKey,
  getArtifactVersionQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsQueryKey,
  SixbProvider,
  searchObjectsQueryKey,
} from "../../client/src/hooks"
import { AgentSurface } from "../src/agent/agent-surface"
import { ArtifactPanelRoot, useArtifactPanel } from "../src/agent/artifact-panel"
import { AgentChatPage } from "../src/agent/react-router"
import { ArtifactPage } from "../src/artifacts/artifact-page"
import {
  artifactFileSource,
  type FileSource,
  messageFileSource,
} from "../src/artifacts/file-source"

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
const file: FileSource = messageFileSource({
  threadId: "thread",
  messageId: "message",
  path: "/parts/0/fileRef",
  fileRef: {
    blobId: "blob",
    digest: "a".repeat(64),
    sizeBytes: 1,
    fileName: "example.png",
    mediaType: "image/png",
  },
  baseUrl: "https://app.sixb.test",
})
function Conversation() {
  const [draft, setDraft] = useState("")
  const panel = useArtifactPanel()
  return (
    <>
      <input
        aria-label="Draft"
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <button type="button" onClick={() => panel?.open({ type: "file", source: file })}>
        Open file
      </button>
      <output data-testid="active-file">{panel?.openKey ?? "none"}</output>
    </>
  )
}

test("dock/full-page transitions retain the conversation instance and the open file", () => {
  // Reproduce by rendering ArtifactWorkspace only for the panel presentation: toggling compact
  // swaps the conversation's parent, and the draft assertion fails.
  const host = globalThis.document.createElement("div")
  globalThis.document.body.append(host)
  const view = (compact: boolean) => (
    <ArtifactPanelRoot compact={compact} overlayHost={compact ? host : null} scopeKey="thread">
      <Conversation />
    </ArtifactPanelRoot>
  )
  const ui = render(view(true))
  const input = ui.getByLabelText("Draft")
  fireEvent.input(input, { target: { value: "Keep this unsent draft" } })
  fireEvent.click(ui.getByText("Open file"))
  expect(ui.getByTestId("active-file").textContent).toBe(`file:${file.id}`)
  ui.rerender(view(false))
  expect(ui.getByLabelText("Draft")).toBe(input)
  expect((ui.getByLabelText("Draft") as HTMLInputElement).value).toBe("Keep this unsent draft")
  expect(ui.getByTestId("active-file").textContent).toBe(`file:${file.id}`)
  ui.rerender(view(true))
  expect(ui.getByLabelText("Draft")).toBe(input)
  expect(ui.getByTestId("active-file").textContent).toBe(`file:${file.id}`)
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

const REPORT = "art_q3rep9rt00"
const SHEET = "art_q3n4mbers0"

/** A report that links to a sheet, both already read. */
function referencingCache(): QueryClient {
  const report = REPORT
  const sheet = SHEET
  const cache = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  const files: Record<string, Record<string, string>> = {
    [report]: {
      "document.md": `# Q3 report\n\nSee [the regional sheet](artifact:${sheet}#Regions).\n`,
    },
    [sheet]: {
      "workbook.json": JSON.stringify({ sheets: [{ name: "Regions" }] }),
      "sheets/Regions.csv": "Region,Visits\nNorth,1284\n",
    },
  }
  for (const [artifactId, texts] of Object.entries(files)) {
    const title = artifactId === report ? "Q3 report" : "Q3 numbers"
    const kind = artifactId === report ? "document" : "sheet"
    const versionFiles = Object.entries(texts).map(([path, text], index) => ({
      path,
      file: {
        blobId: `${artifactId}-${index}`,
        digest: `sha256:${String(index).repeat(64)}`,
        sizeBytes: text.length,
        mediaType: path.endsWith(".csv") ? "text/csv" : "text/plain",
      },
    }))
    cache.setQueryData(getArtifactQueryKey({ path: { artifactId } }), {
      artifact: {
        id: artifactId,
        projectId: "project",
        kind,
        title,
        owner: { type: "user", id: "user-1" },
        latestVersion: 1,
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      },
      versions: [
        {
          version: 1,
          title,
          author: { type: "user", id: "user-1" },
          createdAt: "2026-10-01T12:00:00.000Z",
        },
      ],
    })
    cache.setQueryData(getArtifactVersionQueryKey({ path: { artifactId, version: "1" } }), {
      artifactId,
      version: 1,
      title,
      entry: kind === "sheet" ? "workbook.json" : "document.md",
      files: versionFiles,
      outline:
        kind === "sheet"
          ? {
              kind,
              sheets: [{ name: "Regions", rows: 1, columns: ["Region", "Visits"] }],
              charts: [],
            }
          : { kind, headings: [{ depth: 1, text: "Q3 report", slug: "q3-report" }] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-01T12:00:00.000Z",
    })
    for (const { path, file } of versionFiles) {
      const source = artifactFileSource({ artifactId, version: 1, path, fileRef: file })
      cache.setQueryData([...source.queryKey, "text"], texts[path])
    }
  }
  return cache
}

test("following a reference in the panel keeps a way back to where the reader was", async () => {
  // Reproduce by dropping onOpenReference from the panel's Viewer: the link opens the sheet in
  // place, and there is no Back button.
  const report = REPORT
  const cache = referencingCache()
  function Opener() {
    const panel = useArtifactPanel()
    return (
      <button type="button" onClick={() => panel?.open({ type: "artifact", artifactId: report })}>
        Open report
      </button>
    )
  }
  const ui = render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <ArtifactPanelRoot compact={false} scopeKey="thread">
          <Opener />
        </ArtifactPanelRoot>
      </MemoryRouter>
    </QueryClientProvider>
  )
  fireEvent.click(ui.getByText("Open report"))
  await waitFor(() => expect(ui.getByText("the regional sheet")).toBeTruthy())
  expect(ui.queryByRole("button", { name: "Back" })).toBeNull()

  fireEvent.click(ui.getByText("the regional sheet"))
  await waitFor(() => expect(ui.getByRole("heading", { name: "Q3 numbers" })).toBeTruthy())
  fireEvent.click(ui.getByRole("button", { name: "Back" }))
  await waitFor(() => expect(ui.getByText("the regional sheet")).toBeTruthy())
  expect(ui.queryByRole("button", { name: "Back" })).toBeNull()
})

test("following a reference on an artifact's page opens the other artifact's page", async () => {
  // Reproduce by dropping onOpenReference from ArtifactPage: the address keeps the report's id,
  // gains only ?part=, and the page does not change.
  function Location() {
    const location = useLocation()
    return <output data-testid="location">{location.pathname + location.search}</output>
  }
  const ui = render(
    <QueryClientProvider client={referencingCache()}>
      <MemoryRouter initialEntries={[`/artifacts/${REPORT}`]}>
        <Routes>
          <Route
            path="/artifacts/:artifactId"
            element={
              <>
                <ArtifactPage />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  await waitFor(() => expect(ui.getByText("the regional sheet")).toBeTruthy())
  fireEvent.click(ui.getByText("the regional sheet"))
  await waitFor(() => expect(ui.getByRole("heading", { name: "Q3 numbers" })).toBeTruthy())
  expect(ui.getByTestId("location").textContent).toBe(`/artifacts/${SHEET}?part=Regions`)
})
