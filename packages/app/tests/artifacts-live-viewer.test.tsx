import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetArtifactResponse, type GetArtifactVersionResponse } from "@sixb/client"
import {
  getArtifactQueryKey,
  getArtifactVersionQueryKey,
  getAuthSessionQueryKey,
} from "@sixb/client/hooks"
import { formatCanvas } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { artifactFileSource } from "../src/artifacts/file-source"
import { LiveHubProvider } from "../src/artifacts/live/hooks"
import { LiveHub } from "../src/artifacts/live/session"
import { Viewer } from "../src/artifacts/viewer"
import { installDom } from "./helpers/dom"
import { canvasOf, FakeConnection, FakeServer, settle } from "./helpers/live-server"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLFormElement",
  "SVGElement",
  "Event",
  "CustomEvent",
  "FocusEvent",
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
  "DOMMatrixReadOnly",
])

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
})

const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

const ARTIFACT_ID = "art_l1v3c4nv4s"
const at = "2026-11-08T09:00:00.000Z"
const bob = { type: "user", id: "usr_bob" } as const

const CANVAS = canvasOf({
  items: [
    { id: "home", type: "board", file: "boards/home.html", x: 0, y: 0, w: 390, h: 400 },
    { id: "ask", type: "note", x: 0, y: 560, w: 260, text: "Annual first?" },
  ],
})

/** Bob's canvas, shared with him for him to change, as the viewer reads it. */
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
      kind: "canvas",
      title: "Onboarding",
      owner: { type: "user", id: "usr_alice" },
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
        author: bob,
        createdAt: at,
        updatedAt: at,
      },
    ],
    access: "update",
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
      author: bob,
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

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
})

function viewer(hub: LiveHub) {
  return render(
    <QueryClientProvider client={seeded()}>
      <MemoryRouter>
        <LiveHubProvider hub={hub}>
          <Viewer
            target={{ type: "artifact", artifactId: ARTIFACT_ID }}
            onTargetChange={() => {}}
          />
        </LiveHubProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("a canvas held live in the viewer", () => {
  test("is edited live, with no Save, and stops being edited when the reader may only watch", async () => {
    // Reproduce by keeping the reader editing whatever their access says in useLiveView: the
    // edit bar stays after the server took away their right to change the canvas.
    const server = new FakeServer(ARTIFACT_ID, CANVAS)
    const ui = viewer(new LiveHub(server.open))
    await act(settle)

    const edit = await ui.findByRole("button", { name: "Edit" })
    await act(async () => {
      fireEvent.click(edit)
    })
    expect(ui.getByRole("button", { name: "Done" })).toBeDefined()
    expect(ui.queryByRole("button", { name: "Save" })).toBeNull()
    expect(ui.container.querySelector("[data-save]")?.getAttribute("data-save")).toBe("saved")
    // The board's code loads apart, as the viewer loads it.
    expect(await ui.findByRole("toolbar", { name: "Canvas tools" })).toBeDefined()

    await act(async () => {
      for (const connection of server.connections) {
        connection.deliver({ type: "access", artifactId: ARTIFACT_ID, access: "watch" })
      }
      await settle()
    })
    expect(ui.queryByRole("button", { name: "Done" })).toBeNull()
    expect(ui.queryByRole("button", { name: "Edit" })).toBeNull()
    expect(ui.queryByRole("toolbar", { name: "Canvas tools" })).toBeNull()
    expect(ui.container.querySelector('[data-live-notice="access"]')?.textContent).toBe(
      "You can now only view this canvas."
    )
    ui.unmount()
  })

  test("waits to be edited until its document holds it, never offering a draft meanwhile", async () => {
    // Reproduce by offering the draft's Edit until the live document syncs in ArtifactHeader:
    // an edit begun then is dropped as the canvas starts drawing from the document, and goes on
    // live under the draft's Save.
    const server = new FakeServer(ARTIFACT_ID, CANVAS)
    let connection: FakeConnection | undefined
    const ui = viewer(
      new LiveHub((handlers) => {
        connection = new FakeConnection(server, handlers)
        server.connections.add(connection)
        return connection
      })
    )
    await act(settle)

    const waiting = ui.getByRole("button", { name: "Connecting…" })
    expect(waiting.hasAttribute("disabled")).toBe(true)
    expect(ui.queryByRole("button", { name: "Edit" })).toBeNull()

    await act(async () => {
      connection?.connect()
      await settle()
    })
    expect(ui.queryByRole("button", { name: "Connecting…" })).toBeNull()
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Edit" }))
    })
    expect(ui.getByRole("button", { name: "Done" })).toBeDefined()
    expect(ui.queryByRole("button", { name: "Save" })).toBeNull()
    ui.unmount()
  })

  test("says it is offline to whoever only looks at it, as to who edits it", async () => {
    // Reproduce by showing the save state only in LiveEditBar: once Done, the canvas freezes
    // while the socket is down, and nothing says why.
    const server = new FakeServer(ARTIFACT_ID, CANVAS)
    const ui = viewer(new LiveHub(server.open))
    await act(settle)
    await ui.findByRole("button", { name: "Edit" })
    expect(ui.container.querySelector("[data-save]")).toBeNull()

    await act(async () => {
      for (const connection of server.connections) connection.drop()
    })
    const offline = ui.container.querySelector("[data-save]")
    expect(offline?.getAttribute("data-save")).toBe("offline")
    expect(offline?.getAttribute("title")).toBe("Offline — reconnecting")
    ui.unmount()
  })
})

describe("a video held live in the viewer", () => {
  /** Bob's video, which he may change, as the viewer reads it: it renders nothing else to export. */
  function seededVideo(): QueryClient {
    const queries = seeded()
    const detail = queries.getQueryData<GetArtifactResponse>(
      getArtifactQueryKey({ path: { artifactId: ARTIFACT_ID } })
    )
    if (!detail) throw new Error("Expected the canvas's detail.")
    queries.setQueryData(getArtifactQueryKey({ path: { artifactId: ARTIFACT_ID } }), {
      ...detail,
      artifact: { ...detail.artifact, kind: "video", title: "Launch film" },
    } satisfies GetArtifactResponse)
    const versionKey = getArtifactVersionQueryKey({
      path: { artifactId: ARTIFACT_ID, version: "1" },
    })
    const version = queries.getQueryData<GetArtifactVersionResponse>(versionKey)
    if (!version) throw new Error("Expected the canvas's version.")
    queries.setQueryData(versionKey, {
      ...version,
      title: "Launch film",
      entry: "index.html",
      files: [],
      outline: {
        kind: "video",
        width: 1920,
        height: 1080,
        fps: 30,
        durationMs: 4000,
        scenes: [{ id: "intro", label: "Opening", startMs: 0, durationMs: 4000, renderKey: "a" }],
      },
    } satisfies GetArtifactVersionResponse)
    return queries
  }

  test("folds its Edit into More on a phone's header, and keeps it beside More on a wider one", async () => {
    // Reproduce by rendering a video's EditButton bare in ArtifactHeader, as a canvas's: on a
    // phone it keeps its place beside More, and the title keeps about eleven characters.
    const server = new FakeServer(ARTIFACT_ID, CANVAS)
    const ui = render(
      <QueryClientProvider client={seededVideo()}>
        <MemoryRouter>
          <LiveHubProvider hub={new LiveHub(server.open)}>
            <Viewer
              target={{ type: "artifact", artifactId: ARTIFACT_ID }}
              onTargetChange={() => {}}
            />
          </LiveHubProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    await act(settle)

    const edit = await ui.findByRole("button", { name: "Edit" })
    expect(edit.parentElement?.className).toBe("hidden @md:contents")
    // Bob deletes nothing: More is there for the Edit a phone's header folds into it.
    const more = ui.getAllByRole("button", { name: "More" })
    expect(more.map((button) => button.parentElement?.className)).toEqual(["contents @md:hidden"])

    await act(async () => {
      fireEvent.pointerDown(more[0] as Element, { button: 0, ctrlKey: false, pointerType: "mouse" })
    })
    const entry = await ui.findByRole("menuitem", { name: /Edit/ })
    expect(entry.textContent).toContain("Reorder, trim and retitle its scenes")
    await act(async () => {
      fireEvent.click(entry)
    })
    expect(ui.getByRole("button", { name: "Done" })).toBeDefined()
    ui.unmount()
  })
})
