import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { useState } from "react"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom"
import { OperationsAssistant } from "../../../examples/northline/app/_components/operations-assistant"
import NorthlineThreadPage from "../../../examples/northline/app/threads/[id]/page"
import { createSixbClient } from "../../client/src"
import {
  getAgentQueryKey,
  getAgentThreadQueryKey,
  getArtifactQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsQueryKey,
  SixbProvider,
  searchObjectsQueryKey,
} from "../../client/src/hooks"
import { AgentSurface } from "../src/agent/agent-surface"
import { ArtifactPanelRoot, useArtifactPanel } from "../src/agent/artifact-panel"
import { AgentChatPage } from "../src/agent/react-router"
import { AgentThreadRedirect } from "../src/agent/thread-pages"
import { ArtifactPage } from "../src/artifacts/artifact-page"
import { type FileSource, messageFileSource } from "../src/artifacts/file-source"
import { artifactVersion, seedVersion, textFiles } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "localStorage",
  "sessionStorage",
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
])
afterEach(async () => {
  await Bun.sleep(0)
  browser.localStorage.clear()
  browser.sessionStorage.clear()
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
      ownerPrincipal: { type: "user", id: "usr_1" },
      owner: { type: "user", id: "usr_1" },
      participants: [],
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
  const open = () => ui.container.querySelector("[data-thread-id]")?.getAttribute("data-thread-id")
  const ui = render(view("a"))
  fireEvent.click(ui.getByRole("button", { name: "New thread" }))
  ui.rerender(view(undefined))
  expect(open()).not.toBe("a")
  ui.rerender(view("b"))
  expect(open()).toBe("b")
  ui.rerender(view(undefined))
  expect(open()).toBe("b")
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
        <Route path="/threads/:id" element={<NorthlineThreadPage />} />
        <Route path="*" element={null} />
      </Routes>
    </>
  )
}

test("Northline expands and minimizes the same conversation and unsent composer", async () => {
  // Restore OperationsAssistant's /threads/:id early return and the separate chat page AgentPanel
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
  expect(ui.getByTestId("route").textContent).toBe("/threads/a")
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

test("a conversation's own page has an exit even on a direct link", () => {
  // Remove AgentChatPage's Back to app header action to reproduce the missing in-app exit.
  const cache = conversationCache()
  const ui = render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={["/threads/a"]}>
        <Routes>
          <Route path="/threads/:threadId" element={<AgentChatPage />} />
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

test("a link saved at a conversation's old address opens it", () => {
  // Reproduce by sending AgentThreadRedirect to the list whatever the id: the thread never opens.
  const ui = render(
    <MemoryRouter initialEntries={["/agents/thr%201"]}>
      <Routes>
        <Route path="/agents/:threadId" element={<AgentThreadRedirect />} />
        <Route path="/threads/:threadId" element={<OpenedThread />} />
      </Routes>
    </MemoryRouter>
  )
  expect(ui.getByTestId("opened").textContent).toBe("thr 1")
  ui.unmount()
})

function OpenedThread() {
  return <output data-testid="opened">{useParams().threadId}</output>
}

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
    const version = artifactVersion({
      artifactId,
      title,
      entry: kind === "sheet" ? "workbook.json" : "document.md",
      files: textFiles(texts, artifactId),
      outline:
        kind === "sheet"
          ? {
              kind,
              sheets: [{ name: "Regions", rows: 1, columns: ["Region", "Visits"] }],
              charts: [],
            }
          : { kind, headings: [{ depth: 1, text: "Q3 report", slug: "q3-report" }] },
      createdAt: "2026-10-01T12:00:00.000Z",
    })
    seedVersion(cache, version, texts)
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
