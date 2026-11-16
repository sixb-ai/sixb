import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { client } from "@sixb/client"
import {
  getAgentQueryKey,
  getAgentThreadQueryKey,
  getArtifactQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsQueryKey,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { ArtifactPanelRoot, useArtifactPanel } from "../src/agent/artifact-panel"
import { Composer } from "../src/agent/components/composer"
import { AgentChatPage } from "../src/agent/react-router"
import { ThreadStateContext, threadStateStoreFor } from "../src/agent/thread-state"
import { type FileSource, messageFileSource } from "../src/artifacts/file-source"
import { artifactVersion, seedVersion, textFiles } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

installDom([
  "localStorage",
  "sessionStorage",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })
afterEach(() => client.setConfig({ fetch: originalConfig.fetch }))
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

const REPORT = "art_rep0rt0001"
const SHEET = "art_sh33t00002"

function typeText(element: HTMLElement, value: string): void {
  fireEvent.input(element, { target: { value } })
  fireEvent.keyUp(element, { key: value.at(-1) ?? "a" })
}

function messageInput(screen: ReturnType<typeof render>): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
}

function seedThreadAndArtifacts(): QueryClient {
  const cache = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  cache.setQueryData(getAgentQueryKey(), {
    name: "Assistant",
    model: { provider: "test", modelId: "test" },
  })
  for (const id of ["thr_a", "thr_b"]) {
    cache.setQueryData(getAgentThreadQueryKey({ path: { threadId: id } }), {
      id,
      projectId: "proj",
      kind: "conversation",
      ownerPrincipal: { type: "user", id: "usr_1" },
      owner: { type: "user", id: "usr_1" },
      participants: [],
      title: `Thread ${id}`,
      status: "active",
      activeRunId: null,
      messageCount: 0,
      createdAt: "2026-11-14T12:00:00.000Z",
      updatedAt: "2026-11-14T12:00:00.000Z",
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
  for (const [artifactId, title] of [
    [REPORT, "Q4 operating report"],
    [SHEET, "Q4 revenue model"],
  ] as const) {
    const texts = { "document.md": `# ${title}\n\nBody text.\n` }
    cache.setQueryData(getArtifactQueryKey({ path: { artifactId } }), {
      artifact: {
        id: artifactId,
        projectId: "proj",
        kind: "document",
        title,
        owner: { type: "user", id: "usr_1" },
        latestVersion: 1,
        revision: 1,
        createdAt: "2026-11-14T12:00:00.000Z",
        updatedAt: "2026-11-14T12:00:00.000Z",
      },
      versions: [
        {
          version: 1,
          revision: 1,
          frozen: true,
          title,
          author: { type: "user", id: "usr_1" },
          createdAt: "2026-11-14T12:00:00.000Z",
          updatedAt: "2026-11-14T12:00:00.000Z",
        },
      ],
      access: "owner",
    })
    seedVersion(
      cache,
      artifactVersion({
        artifactId,
        title,
        entry: "document.md",
        files: textFiles(texts, artifactId),
        outline: {
          kind: "document",
          headings: [{ depth: 1, text: title, slug: "title" }],
        },
      }),
      texts
    )
  }
  return cache
}

describe("per-thread composer drafts", () => {
  test("preserves unsent text across thread switches and unmounts, and clears on send", () => {
    // Removal proof: drop `draftKey` sync in Composer; switching to `thr_b` leaks `thr_a`'s text,
    // and unmounting discards both drafts.
    const sent: string[] = []
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const store = threadStateStoreFor(cache)
    const ui = (draftKey: string) => (
      <QueryClientProvider client={cache}>
        <Composer draftKey={draftKey} onSend={(text) => sent.push(`${draftKey}:${text}`)} />
      </QueryClientProvider>
    )

    const view = render(ui("thr_a"))
    typeText(messageInput(view), "Draft for thread A")
    expect(messageInput(view).value).toBe("Draft for thread A")

    // Switch to thread B: starts clean without thread A's draft.
    view.rerender(ui("thr_b"))
    expect(messageInput(view).value).toBe("")
    typeText(messageInput(view), "Draft for thread B")

    // Unmount completely (leaving the chat page) and remount on thread A.
    view.unmount()
    const reopened = render(ui("thr_a"))
    expect(messageInput(reopened).value).toBe("Draft for thread A")

    // Switch back to thread B and send: clears thread B while keeping thread A intact.
    reopened.rerender(ui("thr_b"))
    expect(messageInput(reopened).value).toBe("Draft for thread B")
    fireEvent.click(reopened.getByRole("button", { name: "Send message" }))
    expect(sent).toEqual(["thr_b:Draft for thread B"])
    expect(messageInput(reopened).value).toBe("")
    expect(store.readDraft("thr_b")).toBeNull()
    expect(store.readDraft("thr_a")?.text).toBe("Draft for thread A")
    reopened.unmount()
    cache.clear()
  })

  test("stores attachments and explicit context per thread and evicts oldest past the cap", () => {
    const store = threadStateStoreFor({})
    const attachment = {
      blobId: "blob_1",
      digest: `sha256:${"a".repeat(64)}`,
      sizeBytes: 128,
      fileName: "spec.md",
      mediaType: "text/markdown",
    }
    const explicit = [
      {
        origin: "explicit" as const,
        context: {
          kind: "object" as const,
          ref: { objectTypeId: "Deal", primaryId: "deal_1" },
          label: "Acme renewal",
        },
      },
    ]

    store.writeDraft("thr_a", {
      text: "Review",
      attachments: [attachment],
      explicitContext: explicit,
    })
    expect(store.readDraft("thr_a")).toEqual({
      text: "Review",
      attachments: [attachment],
      explicitContext: explicit,
    })

    store.clearDraft("thr_a")
    expect(store.readDraft("thr_a")).toBeNull()

    for (let index = 0; index < 55; index += 1) {
      store.writeDraft(`thr_${index}`, {
        text: `Note ${index}`,
        attachments: [],
        explicitContext: [],
      })
    }
    expect(store.readDraft("thr_0")).toBeNull()
    expect(store.readDraft("thr_54")?.text).toBe("Note 54")
  })
})

describe("a message that comes back", () => {
  test("a send refused after the reader opened another thread goes back to its own thread", async () => {
    // Removal proof: drop the `draftReseedKey` branch of Composer's reseed effect, or the key
    // useAgentConversation passes it; thread A's message replaces thread B's draft.
    let refuse: () => void = () => {}
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/messages")) {
        return new Promise<Response>((resolve) => {
          refuse = () => resolve(Response.json({ error: "[Sixb] Unavailable." }, { status: 503 }))
        })
      }
      return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }))
    }
    client.setConfig({ fetch: Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }) })

    const cache = seedThreadAndArtifacts()
    const store = threadStateStoreFor(cache)
    store.writeDraft("thr_b", { text: "Relancer Globex", attachments: [], explicitContext: [] })

    function Harness() {
      const navigate = useNavigate()
      return (
        <>
          <button type="button" onClick={() => navigate("/threads/thr_a")}>
            Open thread A
          </button>
          <button type="button" onClick={() => navigate("/threads/thr_b")}>
            Open thread B
          </button>
          <Routes>
            <Route path="/threads/:threadId" element={<AgentChatPage />} />
          </Routes>
        </>
      )
    }

    const view = render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/threads/thr_a"]}>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>
    )
    typeText(messageInput(view), "Note : appeler Alice")
    fireEvent.click(view.getByRole("button", { name: "Send message" }))
    await waitFor(() => expect(messageInput(view).value).toBe(""))

    fireEvent.click(view.getByText("Open thread B"))
    expect(messageInput(view).value).toBe("Relancer Globex")
    await act(async () => refuse())

    await waitFor(() => expect(store.readDraft("thr_a")?.text).toBe("Note : appeler Alice"))
    expect(messageInput(view).value).toBe("Relancer Globex")
    expect(store.readDraft("thr_b")?.text).toBe("Relancer Globex")

    fireEvent.click(view.getByText("Open thread A"))
    expect(messageInput(view).value).toBe("Note : appeler Alice")
    view.unmount()
    cache.clear()
  })
})

describe("per-thread open artifact state", () => {
  test("reopens each thread's open artifact or file across scopes and clears on close", () => {
    // Removal proof: reset `localTarget` to `null` unconditionally in ArtifactPanelRoot when
    // `scopeKey` changes; returning to `thr_a` shows `"none"`.
    const file: FileSource = messageFileSource({
      threadId: "thr_b",
      messageId: "msg_1",
      path: "/parts/0/fileRef",
      fileRef: {
        blobId: "blob_f",
        digest: "b".repeat(64),
        sizeBytes: 10,
        fileName: "diagram.png",
        mediaType: "image/png",
      },
      baseUrl: "https://app.sixb.test",
    })

    function Probe() {
      const panel = useArtifactPanel()
      const openReport = () => panel?.open({ type: "artifact", artifactId: REPORT })
      const openFile = () => panel?.open({ type: "file", source: file })
      const closePanel = () => panel?.close()
      return (
        <>
          <button type="button" onClick={openReport}>
            Open report
          </button>
          <button type="button" onClick={openFile}>
            Open file
          </button>
          <button type="button" onClick={closePanel}>
            Close panel
          </button>
          <output data-testid="open-key">{panel?.openKey ?? "none"}</output>
        </>
      )
    }

    const cache = seedThreadAndArtifacts()
    const store = threadStateStoreFor(cache)
    const ui = (scopeKey: string) => (
      <QueryClientProvider client={cache}>
        <MemoryRouter>
          <ThreadStateContext.Provider value={store}>
            <ArtifactPanelRoot scopeKey={scopeKey}>
              <Probe />
            </ArtifactPanelRoot>
          </ThreadStateContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    )

    const view = render(ui("thr_a"))
    fireEvent.click(view.getByText("Open report"))
    expect(view.getByTestId("open-key").textContent).toBe(`artifact:${REPORT}`)

    // Switch to thread B: starts empty, then opens a message file.
    view.rerender(ui("thr_b"))
    expect(view.getByTestId("open-key").textContent).toBe("none")
    fireEvent.click(view.getByText("Open file"))
    expect(view.getByTestId("open-key").textContent).toBe(`file:${file.id}`)

    // Switch back to thread A: report is still open; back to thread B: file is still open.
    view.rerender(ui("thr_a"))
    expect(view.getByTestId("open-key").textContent).toBe(`artifact:${REPORT}`)
    view.rerender(ui("thr_b"))
    expect(view.getByTestId("open-key").textContent).toBe(`file:${file.id}`)

    // Closing in thread B clears its remembered target.
    fireEvent.click(view.getByText("Close panel"))
    expect(view.getByTestId("open-key").textContent).toBe("none")
    view.rerender(ui("thr_a"))
    view.rerender(ui("thr_b"))
    expect(view.getByTestId("open-key").textContent).toBe("none")
    expect(store.readPanelTarget("thr_a")).toEqual({ type: "artifact", artifactId: REPORT })
    expect(store.readPanelTarget("thr_b")).toBeNull()
    view.unmount()
    cache.clear()
  })

  test("a sub-agent opened over an artifact leaves the panel closed when its thread comes back", () => {
    // Removal proof: write only non-slot targets in `show` (`if (next.type !== "slot") …`);
    // returning to `thr_a` reopens the report the sub-agent replaced.
    function Probe() {
      const panel = useArtifactPanel()
      const openReport = () => panel?.open({ type: "artifact", artifactId: REPORT })
      const openSubAgent = () =>
        panel?.open({ type: "slot", id: "researcher", title: "Researcher" })
      return (
        <>
          <button type="button" onClick={openReport}>
            Open report
          </button>
          <button type="button" onClick={openSubAgent}>
            Open sub-agent
          </button>
          <output data-testid="open-key">{panel?.openKey ?? "none"}</output>
        </>
      )
    }

    const cache = seedThreadAndArtifacts()
    const store = threadStateStoreFor(cache)
    const ui = (scopeKey: string) => (
      <QueryClientProvider client={cache}>
        <MemoryRouter>
          <ThreadStateContext.Provider value={store}>
            <ArtifactPanelRoot scopeKey={scopeKey}>
              <Probe />
            </ArtifactPanelRoot>
          </ThreadStateContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>
    )

    const view = render(ui("thr_a"))
    fireEvent.click(view.getByText("Open report"))
    fireEvent.click(view.getByText("Open sub-agent"))
    expect(view.getByTestId("open-key").textContent).toBe("slot:researcher")

    view.rerender(ui("thr_b"))
    view.rerender(ui("thr_a"))

    expect(view.getByTestId("open-key").textContent).toBe("none")
    expect(store.readPanelTarget("thr_a")).toBeNull()
    view.unmount()
    cache.clear()
  })

  test("restores a thread's open artifact and draft across route navigation", async () => {
    // Removal proof: drop `readPanelTarget` / `readDraft` on mount; leaving `/threads/thr_a` for
    // `/threads` and coming back loses both the open artifact and the unsent draft.
    const cache = seedThreadAndArtifacts()
    const store = threadStateStoreFor(cache)
    store.writePanelTarget("thr_a", { type: "artifact", artifactId: REPORT })
    store.writeDraft("thr_a", {
      text: "Continue analyzing Q4",
      attachments: [],
      explicitContext: [],
    })

    function Harness() {
      const location = useLocation()
      const navigate = useNavigate()
      return (
        <>
          <output data-testid="url">{location.pathname + location.search}</output>
          <button type="button" onClick={() => navigate("/threads")}>
            Leave thread
          </button>
          <button type="button" onClick={() => navigate("/threads/thr_a")}>
            Open thread A
          </button>
          <button type="button" onClick={() => navigate("/threads/thr_b")}>
            Open thread B
          </button>
          <Routes>
            <Route path="/threads/:threadId" element={<AgentChatPage />} />
            <Route path="/threads" element={<p>All threads list</p>} />
          </Routes>
        </>
      )
    }

    const view = render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/threads"]}>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>
    )

    const expectedUrl = `/threads/thr_a?artifact=${REPORT}`
    fireEvent.click(view.getByText("Open thread A"))
    await waitFor(() => expect(view.getByTestId("url").textContent).toBe(expectedUrl))
    expect(messageInput(view).value).toBe("Continue analyzing Q4")

    // Switch directly to thread B: URL has no artifact and input is empty.
    fireEvent.click(view.getByText("Open thread B"))
    await waitFor(() => expect(view.getByTestId("url").textContent).toBe("/threads/thr_b"))
    expect(messageInput(view).value).toBe("")

    // Leave to /threads, then return to thread A: both the artifact and draft come right back.
    fireEvent.click(view.getByText("Leave thread"))
    expect(view.getByText("All threads list")).toBeTruthy()
    fireEvent.click(view.getByText("Open thread A"))
    await waitFor(() => expect(view.getByTestId("url").textContent).toBe(expectedUrl))
    expect(messageInput(view).value).toBe("Continue analyzing Q4")
    view.unmount()
    cache.clear()
  })
})
