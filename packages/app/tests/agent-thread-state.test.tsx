import { afterEach, describe, expect, test } from "bun:test"
import {
  getAgentQueryKey,
  getAgentThreadQueryKey,
  getArtifactQueryKey,
  listAgentThreadMessagesQueryKey,
  listAgentThreadRunsQueryKey,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { ArtifactPanelRoot, useArtifactPanel } from "../src/agent/artifact-panel"
import { Composer } from "../src/agent/components/composer"
import { AgentChatPage } from "../src/agent/react-router"
import {
  clearThreadDraft,
  readThreadDraft,
  readThreadPanelTarget,
  writeThreadDraft,
  writeThreadPanelTarget,
} from "../src/agent/thread-state"
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

afterEach(async () => {
  await Bun.sleep(0)
  browser.localStorage.clear()
  browser.sessionStorage.clear()
})

const REPORT = "art_rep0rt0001"
const SHEET = "art_sh33t00002"

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
    const ui = (draftKey: string) => (
      <QueryClientProvider client={cache}>
        <Composer draftKey={draftKey} onSend={(text) => sent.push(`${draftKey}:${text}`)} />
      </QueryClientProvider>
    )

    const view = render(ui("thr_a"))
    const input = () => view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement

    fireEvent.input(input(), { target: { value: "Draft for thread A" } })
    expect(input().value).toBe("Draft for thread A")

    // Switch to thread B: starts clean without thread A's draft.
    view.rerender(ui("thr_b"))
    expect(input().value).toBe("")
    fireEvent.input(input(), { target: { value: "Draft for thread B" } })

    // Unmount completely (leaving the chat page) and remount on thread A.
    view.unmount()
    const reopened = render(ui("thr_a"))
    const reopenedInput = () =>
      reopened.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
    expect(reopenedInput().value).toBe("Draft for thread A")

    // Switch back to thread B and send: clears thread B while keeping thread A intact.
    reopened.rerender(ui("thr_b"))
    expect(reopenedInput().value).toBe("Draft for thread B")
    fireEvent.click(reopened.getByRole("button", { name: "Send message" }))
    expect(sent).toEqual(["thr_b:Draft for thread B"])
    expect(reopenedInput().value).toBe("")
    expect(readThreadDraft("thr_b")).toBeNull()
    expect(readThreadDraft("thr_a")?.text).toBe("Draft for thread A")
    reopened.unmount()
    cache.clear()
  })

  test("stores attachments and explicit context per thread and handles bad storage", () => {
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

    writeThreadDraft("thr_a", {
      text: "Review",
      attachments: [attachment],
      explicitContext: explicit,
    })
    expect(readThreadDraft("thr_a")).toEqual({
      text: "Review",
      attachments: [attachment],
      explicitContext: explicit,
    })

    clearThreadDraft("thr_a")
    expect(readThreadDraft("thr_a")).toBeNull()

    browser.sessionStorage.setItem("sixb.agent.thread-state.v1", "{malformed")
    expect(readThreadDraft("thr_a")).toBeNull()
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
      return (
        <>
          <button
            type="button"
            onClick={() => panel?.open({ type: "artifact", artifactId: REPORT })}
          >
            Open report
          </button>
          <button type="button" onClick={() => panel?.open({ type: "file", source: file })}>
            Open file
          </button>
          <button type="button" onClick={() => panel?.close()}>
            Close panel
          </button>
          <output data-testid="open-key">{panel?.openKey ?? "none"}</output>
        </>
      )
    }

    const cache = seedThreadAndArtifacts()
    const ui = (scopeKey: string) => (
      <QueryClientProvider client={cache}>
        <MemoryRouter>
          <ArtifactPanelRoot scopeKey={scopeKey}>
            <Probe />
          </ArtifactPanelRoot>
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
    expect(readThreadPanelTarget("thr_a")).toEqual({ type: "artifact", artifactId: REPORT })
    expect(readThreadPanelTarget("thr_b")).toBeNull()
    view.unmount()
    cache.clear()
  })

  test("restores a thread's open artifact and draft across route navigation", async () => {
    // Removal proof: drop `readThreadPanelTarget` / `readThreadDraft` on mount; leaving
    // `/threads/thr_a` for `/threads` and coming back loses both the open artifact and the draft.
    const cache = seedThreadAndArtifacts()
    writeThreadPanelTarget("thr_a", { type: "artifact", artifactId: REPORT })
    writeThreadDraft("thr_a", {
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

    fireEvent.click(view.getByText("Open thread A"))
    await waitFor(() =>
      expect(view.getByTestId("url").textContent).toBe(`/threads/thr_a?artifact=${REPORT}`)
    )
    const inputA = view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
    expect(inputA.value).toBe("Continue analyzing Q4")

    // Switch directly to thread B: URL has no artifact and input is empty.
    fireEvent.click(view.getByText("Open thread B"))
    await waitFor(() => expect(view.getByTestId("url").textContent).toBe("/threads/thr_b"))
    expect((view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("")

    // Leave to /threads, then return to thread A: both the artifact and draft come right back.
    fireEvent.click(view.getByText("Leave thread"))
    expect(view.getByText("All threads list")).toBeTruthy()
    fireEvent.click(view.getByText("Open thread A"))
    await waitFor(() =>
      expect(view.getByTestId("url").textContent).toBe(`/threads/thr_a?artifact=${REPORT}`)
    )
    expect((view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Continue analyzing Q4"
    )
    view.unmount()
    cache.clear()
  })
})
