import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetArtifactResponse, type GetArtifactVersionResponse } from "@sixb/client"
import {
  getArtifactQueryKey,
  getArtifactVersionQueryKey,
  getAuthSessionQueryKey,
} from "@sixb/client/hooks"
import { FRAME_PROTOCOL, type FrameEditTarget } from "@sixb/core/artifacts"
import { LIVE_FILES } from "@sixb/core/artifacts/live"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import * as Y from "yjs"
import { frameLinkKey } from "../src/artifacts/frame"
import { LiveHubProvider } from "../src/artifacts/live/hooks"
import { LiveHub } from "../src/artifacts/live/session"
import { fileTextQueryKey, versionFileSource } from "../src/artifacts/queries"
import { Viewer } from "../src/artifacts/viewer"
import { installDom } from "./helpers/dom"
import { canvasOf, FakeServer, settle } from "./helpers/live-server"

// A designed document typed into in place, in the viewer: the frame, played here by the test,
// reports what the reader picks and types; the document writes it into the live document, which
// the server holds for everyone.

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "SVGElement",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "MessageEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
])

const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })

// Radix picks its layout effect when it loads, a no-op without a `document`, and its menus then
// never mount. It is given React's own for this file, and its own back after.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
})

/**
 * The editor's channels, each telling the test once its port handled a message: a message on a
 * port arrives a task later, and the test waits for its own instead of for time to pass.
 */
const handled: (() => void)[] = []
const NativeChannel = globalThis.MessageChannel
globalThis.MessageChannel = class extends NativeChannel {
  constructor() {
    super()
    const port = this.port1
    Object.defineProperty(port, "onmessage", {
      set(handler: (message: MessageEvent) => void) {
        port.addEventListener("message", (message) => {
          handler(message)
          handled.shift()?.()
        })
        port.start()
      },
    })
  }
}
afterAll(() => {
  globalThis.MessageChannel = NativeChannel
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const ARTIFACT_ID = "art_pr0p0sa1ed"
const FILE = "document.html"
const SOURCE =
  '<!doctype html><html><head><link rel="stylesheet" href="design.css"></head><body><h1>Service proposal</h1><p>A fixed fee of $4,000.</p></body></html>'
const HEADING = "body>h1:0"
const FEE = "body>p:0"
const at = "2026-11-11T09:00:00.000Z"
const bob = { type: "user", id: "usr_bob" } as const

const fileRef = (name: string) => ({
  blobId: `blob_${name}`,
  digest: `sha256:${name.padEnd(64, "0").slice(0, 64)}`,
  sizeBytes: 10,
})

const VERSION = {
  artifactId: ARTIFACT_ID,
  version: 1,
  title: "Proposal",
  entry: FILE,
  files: [
    { path: FILE, file: fileRef("document") },
    { path: "design.css", file: fileRef("design") },
  ],
  outline: {
    kind: "document",
    format: "html",
    headings: [{ depth: 1, text: "Service proposal", slug: "service-proposal" }],
    paper: { width: 816, height: 1056, margin: { top: 72, right: 72, bottom: 72, left: 72 } },
  },
  references: [],
  author: bob,
  createdAt: at,
  updatedAt: at,
  revision: 1,
  frozen: false,
} satisfies GetArtifactVersionResponse

/** Bob's proposal, his to change, as the viewer reads it. */
function seeded(): QueryClient {
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
      kind: "document",
      title: "Proposal",
      owner: bob,
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
        title: "Proposal",
        author: bob,
        createdAt: at,
        updatedAt: at,
      },
    ],
    access: "owner",
  } satisfies GetArtifactResponse)
  queries.setQueryData(
    getArtifactVersionQueryKey({ path: { artifactId: ARTIFACT_ID, version: "1" } }),
    VERSION
  )
  queries.setQueryData(frameLinkKey(VERSION), {
    path: "/api/artifact-frames/token/",
    expiresAt: "2026-11-11T10:00:00.000Z",
  })
  queries.setQueryData(fileTextQueryKey(versionFileSource(VERSION, FILE)), SOURCE)
  return queries
}

/** The room's document for the proposal, as storage keeps a designed document's. */
function server() {
  // The fake room starts from a canvas; its files are made the proposal's before anyone joins.
  const note = { id: "n", type: "note", x: 0, y: 0, w: 100, text: "-" }
  const room = new FakeServer(ARTIFACT_ID, canvasOf({ items: [note] }))
  room.doc.transact(() => {
    room.doc.getMap("artifact").set("kind", "document")
    const files = room.doc.getMap<unknown>(LIVE_FILES)
    files.delete("canvas.json")
    files.set(FILE, new Y.Text(SOURCE))
  })
  return room
}

function viewer(room: FakeServer) {
  const queries = seeded()
  const ui = render(
    <QueryClientProvider client={queries}>
      <MemoryRouter>
        <LiveHubProvider hub={new LiveHub(room.open)}>
          <Viewer
            target={{ type: "artifact", artifactId: ARTIFACT_ID }}
            onTargetChange={() => {}}
          />
        </LiveHubProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const frame = () => {
    const element = ui.container.querySelector("iframe")
    if (!element) throw new Error("Expected the document's frame.")
    return element
  }

  // The port the editor's `edit` request hands over, which the frame's runtime reports through.
  let port: MessagePort | null = null
  const listen = () => {
    const window = frame().contentWindow
    if (!window) throw new Error("Expected the frame's window.")
    window.postMessage = ((
      message: { method: string },
      _origin: string,
      transfer: readonly MessagePort[] = []
    ) => {
      if (message.method === "edit" && transfer[0]) port = transfer[0]
    }) as typeof window.postMessage
  }
  /** The frame says it loaded, through the window. */
  const ready = async () => {
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, event: "ready", params: {} },
          source: frame().contentWindow as never,
        })
      )
    })
  }
  /** The frame reports editing, through its port. */
  const post = async (event: string, params: Record<string, unknown>) => {
    await act(async () => {
      if (!port) throw new Error("Expected the frame's port.")
      const taken = new Promise<void>((done) => handled.push(done))
      port.postMessage({ protocol: FRAME_PROTOCOL, event, params })
      await taken
      await settle()
    })
  }
  const target = (address: string, label: string): FrameEditTarget => ({
    address,
    kind: "text",
    label,
    rect: { x: 72, y: 72, width: 600, height: 40 },
  })
  /** What the room holds for everyone now. */
  const held = () => String(room.doc.getMap<unknown>(LIVE_FILES).get(FILE))
  return { ui, queries, frame, listen, ready, post, target, held }
}

describe("a designed document's downloads", () => {
  // Reproduce by offering the entry in EntryDownloadMenu for a designed document too: its
  // document.html downloads alone, without the stylesheets and pictures it shows with.
  test("are its PDF alone, and nothing where it cannot print", async () => {
    const { ui, queries } = viewer(server())
    await act(settle)
    // The header is up, with what this reader may do: there is nothing to download.
    await ui.findByRole("button", { name: "Edit" })
    expect(ui.queryByRole("button", { name: "Download" })).toBeNull()

    await act(async () => {
      queries.setQueryData(
        getArtifactVersionQueryKey({ path: { artifactId: ARTIFACT_ID, version: "1" } }),
        { ...VERSION, printable: true }
      )
      await settle()
    })
    const download = await ui.findByRole("button", { name: "Download" })
    await act(async () => {
      fireEvent.pointerDown(download, {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      })
    })
    const items = await ui.findAllByRole("menuitem")
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain("Ready to print or share")
  })
})

describe("a designed document held live in the viewer", () => {
  // Reproduce by holding only a canvas live in Viewer: no Edit is offered, and the proposal
  // opens as its pages with nothing in it to type into.
  test("is typed into in place, as one sheet, for everyone, under the reader's own undo", async () => {
    const room = server()
    const { ui, frame, listen, ready, post, target, held } = viewer(room)
    await act(settle)
    expect(frame().getAttribute("src")).toEndWith("document.html#sixb-pages")

    await act(async () => {
      fireEvent.click(await ui.findByRole("button", { name: "Edit" }))
    })
    expect(ui.getByRole("button", { name: "Done" })).toBeDefined()
    expect(frame().getAttribute("src")).toEndWith("document.html?sixb-edit")

    listen()
    await ready()

    // Words for an element the reader did not pick are not taken.
    await post("edit.text", { address: FEE, base: "A fixed fee of $4,000.", text: "Free." })
    expect(held()).toContain("<p>A fixed fee of $4,000.</p>")

    await post("edit.select", { target: target(HEADING, "Service proposal") })
    await post("edit.text", { address: HEADING, base: "Service proposal", text: "Repair proposal" })
    expect(held()).toContain("<h1>Repair proposal</h1>")

    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Undo" }))
      await settle()
    })
    expect(held()).toContain("<h1>Service proposal</h1>")
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Redo" }))
      await settle()
    })
    expect(held()).toContain("<h1>Repair proposal</h1>")
    ui.unmount()
  })

  // Reproduce by returning null from useSettling: Done shows the stored pages at once, which
  // still hold "Service proposal" until the write-back lands.
  test("stays one sheet once the reader is done, until the stored version holds their words", async () => {
    const room = server()
    const { ui, queries, frame, listen, ready, post, target, held } = viewer(room)
    await act(settle)
    await act(async () => {
      fireEvent.click(await ui.findByRole("button", { name: "Edit" }))
    })
    listen()
    await ready()
    await post("edit.select", { target: target(HEADING, "Service proposal") })
    await post("edit.text", { address: HEADING, base: "Service proposal", text: "Repair proposal" })

    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Done" }))
    })
    expect(ui.queryByRole("button", { name: "Done" })).toBeNull()
    expect(frame().getAttribute("src")).toEndWith("document.html?sixb-edit")

    // The write-back lands: the stored version holds what the room does.
    expect(held()).toContain("<h1>Repair proposal</h1>")
    await act(async () => {
      queries.setQueryData(fileTextQueryKey(versionFileSource(VERSION, FILE)), held())
      // The cache tells its observers on the next task.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(frame().getAttribute("src")).toEndWith("document.html#sixb-pages")
    ui.unmount()
  })
})
