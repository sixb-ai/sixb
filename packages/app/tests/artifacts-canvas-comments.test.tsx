import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetArtifactResponse, type GetArtifactVersionResponse } from "@sixb/client"
import {
  getArtifactQueryKey,
  getArtifactVersionQueryKey,
  getAuthSessionQueryKey,
} from "@sixb/client/hooks"
import { formatCanvas } from "@sixb/core/artifacts"
import { LIVE_FILES } from "@sixb/core/artifacts/live"
import { serializeAgentContextForModel } from "@sixb/core/internal/agents"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import type * as Y from "yjs"
import { commentsContext } from "../src/artifacts/comments-context"
import { artifactFileSource } from "../src/artifacts/file-source"
import { LiveHubProvider } from "../src/artifacts/live/hooks"
import { LiveHub } from "../src/artifacts/live/session"
import type { ArtifactComment } from "../src/artifacts/renderers/canvas/comments"
import { commentThreads } from "../src/artifacts/renderers/canvas/comments"
import { type AgentDraft, AgentDraftContext } from "../src/artifacts/view-context"
import { Viewer } from "../src/artifacts/viewer"
import { installDom } from "./helpers/dom"
import { canvasOf, FakeServer, settle } from "./helpers/live-server"

// Comments on a canvas, as the viewer shows them: Bob reads Alice's canvas; he resolves and
// deletes his own comments, never hers, and sends the ones he picks to the Agent.

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "SVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "DOMMatrixReadOnly",
])

// Radix picks its layout effect when it loads, a no-op without a `document`, and its menus and
// dialogs then never mount: it is given React's own for this file.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))
afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })
afterEach(async () => {
  client.setConfig({ fetch: originalConfig.fetch })
  await new Promise((resolve) => setTimeout(resolve, 0))
})
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

const ARTIFACT_ID = "art_c0mments"
const at = "2026-11-08T09:00:00.000Z"
const bob = { type: "user", id: "usr_bob" } as const
const alice = { type: "user", id: "usr_alice" } as const

const CANVAS = canvasOf({
  items: [
    {
      id: "home",
      type: "board",
      title: "Home",
      file: "boards/home.html",
      x: 0,
      y: 0,
      w: 390,
      h: 400,
    },
    { id: "ask", type: "note", x: 0, y: 560, w: 260, text: "Annual first?" },
  ],
})

const comment = (
  id: string,
  author: ArtifactComment["author"],
  body: string,
  extra: Partial<ArtifactComment> = {}
): ArtifactComment => ({
  artifactId: ARTIFACT_ID,
  id,
  anchor: {
    board: "home",
    element: "body>main:0>h1:0",
    label: "Welcome",
    point: { x: 0.5, y: 0.1 },
    revision: 1,
  },
  body,
  author,
  authorName: author.id === bob.id ? "Bob" : "Alice Martin",
  createdAt: at,
  ...extra,
})

/** Alice's canvas, which Bob reads, or may change, as the viewer reads it. */
function seeded(access: "read" | "update" = "read"): QueryClient {
  const queries = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  queries.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    authEnabled: true,
    user: { id: bob.id, email: "bob@example.com", displayName: "Bob", groupIds: [] },
  })
  queries.setQueryData(getArtifactQueryKey({ path: { artifactId: ARTIFACT_ID } }), {
    artifact: {
      id: ARTIFACT_ID,
      projectId: "proj",
      kind: "canvas",
      title: "Onboarding",
      owner: alice,
      latestVersion: 1,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    versions: [
      {
        version: 1,
        revision: 1,
        frozen: false,
        title: "Onboarding",
        author: alice,
        createdAt: at,
        updatedAt: at,
      },
    ],
    access,
  } satisfies GetArtifactResponse)
  const file = {
    blobId: "blob_canvas",
    digest: `sha256:${"0".repeat(64)}`,
    sizeBytes: 10,
    mediaType: "application/json",
  }
  queries.setQueryData(
    getArtifactVersionQueryKey({ path: { artifactId: ARTIFACT_ID, version: "1" } }),
    {
      artifactId: ARTIFACT_ID,
      version: 1,
      title: "Onboarding",
      entry: "canvas.json",
      files: [{ path: "canvas.json", file }],
      outline: { kind: "canvas", items: [] },
      references: [],
      author: alice,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      frozen: false,
    } satisfies GetArtifactVersionResponse
  )
  const source = artifactFileSource({
    artifactId: ARTIFACT_ID,
    version: 1,
    path: "canvas.json",
    fileRef: file,
  })
  queries.setQueryData([...source.queryKey, "text"], formatCanvas(CANVAS))
  return queries
}

/** The comments API, over a list the test changes; each request it took. */
function serveComments(initial: readonly ArtifactComment[]) {
  const state = { comments: [...initial], requests: [] as string[] }
  client.setConfig({
    fetch: Object.assign(
      async (input: Request) => {
        const url = new URL(input.url)
        const prefix = `/api/artifacts/${ARTIFACT_ID}/comments`
        if (!url.pathname.startsWith(prefix)) {
          return Response.json({ error: "Not found" }, { status: 404 })
        }
        const path = url.pathname.slice(prefix.length)
        state.requests.push(`${input.method} ${path || "/"}`)

        if (input.method === "GET") return Response.json({ comments: state.comments })
        if (input.method === "POST" && path === "") {
          const body = (await input.json()) as { body: string; parentId?: string }
          const parent = state.comments.find((each) => each.id === body.parentId)
          const created = comment(`cmt_${state.comments.length + 1}`, bob, body.body, {
            ...(parent ? { parentId: parent.id, anchor: parent.anchor } : {}),
          })
          state.comments.push(created)
          return Response.json(created, { status: 201 })
        }
        const resolved = /^\/([^/]+)\/resolve$/.exec(path)
        if (input.method === "POST" && resolved) {
          const id = resolved[1]
          state.comments = state.comments.map((each) =>
            each.id === id ? { ...each, resolvedAt: at, resolvedBy: bob } : each
          )
          return Response.json(state.comments.find((each) => each.id === id))
        }
        if (input.method === "DELETE") {
          const id = path.slice(1)
          state.comments = state.comments.filter((each) => each.id !== id)
          return Response.json({ deleted: true })
        }
        return Response.json({ error: "Not found" }, { status: 404 })
      },
      { preconnect: globalThis.fetch.preconnect }
    ) as unknown as typeof fetch,
  })
  return state
}

async function open(
  options: { readonly draft?: (draft: AgentDraft) => void; readonly edits?: boolean } = {}
) {
  const server = new FakeServer(ARTIFACT_ID, CANVAS)
  server.access = options.edits ? "edit" : "watch"
  const hub = new LiveHub(server.open)
  const ui = render(
    <QueryClientProvider client={seeded(options.edits ? "update" : "read")}>
      <MemoryRouter>
        <AgentDraftContext.Provider value={options.draft ?? null}>
          <LiveHubProvider hub={hub}>
            <Viewer
              target={{ type: "artifact", artifactId: ARTIFACT_ID }}
              onTargetChange={() => {}}
            />
          </LiveHubProvider>
        </AgentDraftContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  await act(settle)
  // The board's code loads apart, as the viewer loads it.
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50))
  })
  return { ui, server }
}

async function openPanel(ui: ReturnType<typeof render>) {
  const toggle = await waitFor(() => ui.getByRole("button", { name: /^Comments/ }))
  await act(async () => {
    fireEvent.click(toggle)
  })
  return ui.getByRole("complementary", { name: "Comments" })
}

/**
 * Types into a field as React reads it here: it loaded before the window existed, so it follows a
 * field's words from the key that changed them.
 */
function type(field: HTMLElement, value: string) {
  fireEvent.focusIn(field)
  fireEvent.input(field, { target: { value } })
  fireEvent.keyUp(field, { key: value.at(-1) })
}

/** Lets the requests in flight answer, and what they set off render. */
async function flush() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 30))
  })
}

const thread = (panel: HTMLElement, id: string) => {
  const found = panel.querySelector<HTMLElement>(`[data-comment-thread="${id}"]`)
  if (!found) throw new Error(`Expected thread ${id}.`)
  return found
}

describe("comments on a canvas", () => {
  // Guard proof: return true from canManageComment for anyone; Alice's thread then offers Bob
  // Resolve.
  test("are resolved and deleted by their author, the reader's others left alone", async () => {
    const api = serveComments([
      comment("cmt_1", bob, "Tighten the title"),
      comment("cmt_2", alice, "Warmer colors"),
    ])
    const { ui } = await open()
    const panel = await openPanel(ui)
    await waitFor(() => expect(thread(panel, "cmt_2")).toBeTruthy())

    expect(within(thread(panel, "cmt_2")).queryByRole("button", { name: "Resolve" })).toBeNull()
    // Each is named as the API names its author, the reader's own as theirs.
    // Guard proof: drop `authorName` from useCommentAuthors; Alice is then "Someone".
    expect(within(thread(panel, "cmt_1")).getByText("You")).toBeTruthy()
    expect(within(thread(panel, "cmt_2")).getByText("Alice Martin")).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(thread(panel, "cmt_1")).getByRole("button", { name: "Resolve" }))
    })
    await flush()
    expect(panel.querySelector('[data-comment-thread="cmt_1"]')).toBeNull()
    expect(api.requests).toContain("POST /cmt_1/resolve")
    expect(within(panel).getByRole("button", { name: /^Resolved/ }).textContent).toBe("Resolved1")

    // Reopened from the resolved ones, then deleted, replies and all.
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: /^Resolved/ }))
    })
    const more = within(thread(panel, "cmt_1")).getByRole("button", { name: "More actions" })
    await act(async () => {
      fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" })
    })
    await act(async () => {
      fireEvent.click(await waitFor(() => ui.getByRole("menuitem", { name: "Delete" })))
    })
    await act(async () => {
      fireEvent.click(await waitFor(() => ui.getByRole("button", { name: "Delete" })))
    })
    await flush()
    expect(api.requests).toContain("DELETE /cmt_1")
    expect(panel.querySelector('[data-comment-thread="cmt_1"]')).toBeNull()
    ui.unmount()
  })

  test("take a reply under the comment it answers", async () => {
    const api = serveComments([comment("cmt_1", alice, "Warmer colors")])
    const { ui } = await open()
    const panel = await openPanel(ui)
    await waitFor(() => expect(thread(panel, "cmt_1")).toBeTruthy())

    await act(async () => {
      fireEvent.click(within(thread(panel, "cmt_1")).getByRole("button", { name: "Reply" }))
    })
    const input = within(thread(panel, "cmt_1")).getByRole("textbox", { name: "Reply" })
    type(input, "On it")
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    await flush()

    expect(within(thread(panel, "cmt_1")).getByText("On it")).toBeTruthy()
    expect(api.requests).toContain("POST /")
    ui.unmount()
  })

  // Guard proof: drop the `onCommented` subscription in useArtifactComments; Alice's new comment
  // never shows.
  test("are read again when the live canvas says one changed", async () => {
    const api = serveComments([comment("cmt_1", alice, "Warmer colors")])
    const { ui, server } = await open()
    const panel = await openPanel(ui)
    await waitFor(() => expect(thread(panel, "cmt_1")).toBeTruthy())

    api.comments.push(comment("cmt_2", alice, "And a bigger button"))
    await act(async () => {
      for (const connection of server.connections) {
        connection.deliver({
          type: "commented",
          artifactId: ARTIFACT_ID,
          commentId: "cmt_2",
          action: "created",
        })
      }
      await settle()
    })

    await waitFor(() => expect(within(panel).getByText("And a bigger button")).toBeTruthy())
    ui.unmount()
  })

  // Guard proof: send every open thread from the panel instead of those chosen; the context then
  // carries the third. Put the quotes back in the draft's text; the person reads addresses.
  test("send the chosen ones to the Agent as context of the reader's message, their words theirs", async () => {
    serveComments([
      comment("cmt_1", alice, "Warmer colors"),
      comment("cmt_2", alice, "Bigger button", {
        anchor: { board: "home", revision: 1 },
      }),
      comment("cmt_3", alice, "Leave this one"),
    ])
    const drafts: AgentDraft[] = []
    const { ui } = await open({ draft: (draft) => drafts.push(draft) })
    const panel = await openPanel(ui)
    await waitFor(() => expect(thread(panel, "cmt_3")).toBeTruthy())

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Send to agent" }))
    })
    for (const number of [1, 2]) {
      await act(async () => {
        fireEvent.click(within(panel).getByRole("checkbox", { name: `Select comment ${number}` }))
      })
    }
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Send 2 comments to the agent" }))
    })

    expect(drafts).toHaveLength(1)
    const [draft] = drafts
    expect(draft?.text).toBe("Please address these comments.")
    expect(draft?.context).toMatchObject({
      kind: "app-state",
      id: `artifact-comments:${ARTIFACT_ID}`,
      label: "2 comments · Onboarding",
      value: {
        artifactId: ARTIFACT_ID,
        title: "Onboarding",
        comments: [
          {
            id: "cmt_1",
            quote:
              '[home · body>main:0>h1:0 · "Welcome" · revision 1 · comment cmt_1 · from Alice Martin] Warmer colors',
            author: "Alice Martin",
            body: "Warmer colors",
            replies: [],
          },
          {
            id: "cmt_2",
            quote: "[home · revision 1 · comment cmt_2 · from Alice Martin] Bigger button",
            body: "Bigger button",
          },
        ],
      },
    })
    expect(draft?.text).not.toContain("body>")
    expect(within(panel).getByText("Added to your message to the agent")).toBeTruthy()
    ui.unmount()
  })

  // Guard proof: leave the quote out of commentsContext's entries; the Agent no longer finds where
  // the comments are.
  test("reach the Agent with where they are, quoted as its skill reads them", () => {
    const { context, sent } = commentsContext({
      artifactId: ARTIFACT_ID,
      title: "Onboarding",
      label: (count) => `${count} comments · Onboarding`,
      threads: commentThreads([
        comment("cmt_1", alice, "Warmer colors"),
        comment("cmt_2", bob, "Agreed,\n warmer", { parentId: "cmt_1" }),
      ]),
    })
    expect(sent).toBe(1)

    const block = serializeAgentContextForModel([{ type: "context", context, origin: "explicit" }])
    expect(block).toContain(`<id>artifact-comments:${ARTIFACT_ID}</id>`)
    expect(block).toContain("comment cmt_1 · from Alice Martin] Warmer colors")
    expect(block).toContain("body&gt;main:0&gt;h1:0")
    expect(block).toContain("Agreed, warmer")
  })

  // Guard proof: drop `.closest(COMMENTS)` from the canvas's key handler; Delete on the panel's
  // button deletes the board the reader selected.
  test("keep their keys: Delete in the panel deletes nothing of the canvas", async () => {
    serveComments([comment("cmt_1", alice, "Warmer colors")])
    const { ui, server } = await open({ edits: true })
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Edit" }))
    })
    const panel = await openPanel(ui)
    await waitFor(() => expect(thread(panel, "cmt_1")).toBeTruthy())
    const note = ui.container.querySelector('.react-flow__node[data-id="ask"]')
    if (!note) throw new Error("Expected the note.")
    await act(async () => {
      fireEvent.click(note)
    })
    expect(ui.container.querySelectorAll(".react-flow__node.selected").length).toBe(1)

    const resolve = within(thread(panel, "cmt_1")).getByRole("button", { name: "Resolve" })
    await act(async () => {
      fireEvent.keyDown(resolve, { key: "Delete" })
      fireEvent.keyDown(resolve, { key: "Backspace" })
      await settle()
    })
    const structure = server.doc.getMap<Y.Map<unknown>>(LIVE_FILES).get("canvas.json")
    expect((structure?.get("items") as Y.Map<unknown>).has("ask")).toBe(true)
    ui.unmount()
  })

  // Guard proof: drop the focus and pointer check from the C shortcut; a C typed anywhere on the
  // page, out of the canvas, starts placing a comment.
  test("start being placed with C only while the canvas has the focus or the pointer", async () => {
    serveComments([])
    const { ui } = await open()
    const tool = await waitFor(() => ui.getByRole("button", { name: /^Comment$/ }))

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "c" })
    })
    expect(tool.getAttribute("aria-pressed")).toBe("false")

    const canvas = ui.getByRole("region", { name: "Canvas Onboarding" })
    await act(async () => {
      fireEvent.pointerEnter(canvas)
      fireEvent.keyDown(document.body, { key: "c" })
    })
    expect(tool.getAttribute("aria-pressed")).toBe("true")
    ui.unmount()
  })

  // Guard proof: drop the `origin` branch from useCommentAuthors; the Agent's reply reads as
  // Alice's own.
  test("say when the Agent wrote one, and for whom", async () => {
    serveComments([
      comment("cmt_1", alice, "Warmer colors"),
      comment("cmt_2", alice, "Done: the title is warmer.", {
        parentId: "cmt_1",
        origin: { threadId: "thr_1", runId: "run_1" },
      }),
    ])
    const { ui } = await open()
    const panel = await openPanel(ui)
    await waitFor(() => expect(thread(panel, "cmt_1")).toBeTruthy())

    expect(within(thread(panel, "cmt_1")).getByText("Agent, for Alice Martin")).toBeTruthy()
    ui.unmount()
  })
})
