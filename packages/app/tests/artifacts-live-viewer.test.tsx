import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { client, type GetArtifactResponse, type GetArtifactVersionResponse } from "@sixb/client"
import {
  getArtifactQueryKey,
  getArtifactVersionQueryKey,
  getAuthSessionQueryKey,
} from "@sixb/client/hooks"
import { formatCanvas } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { artifactFileSource } from "../src/artifacts/file-source"
import { LiveHubProvider } from "../src/artifacts/live/hooks"
import { LiveHub } from "../src/artifacts/live/session"
import { Viewer } from "../src/artifacts/viewer"
import { installDom } from "./helpers/dom"
import { canvasOf, FakeServer, settle } from "./helpers/live-server"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
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

describe("a canvas held live in the viewer", () => {
  test("is edited live, with no Save, and stops being edited when the reader may only watch", async () => {
    // Reproduce by keeping the reader editing whatever their access says in useLiveView: the
    // edit bar stays after the server took away their right to change the canvas.
    const server = new FakeServer(ARTIFACT_ID, CANVAS)
    const hub = new LiveHub(server.open)
    const ui = render(
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
    await act(settle)
    // The board's code loads apart, as the viewer loads it.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50))
    })

    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Edit" }))
    })
    expect(ui.getByRole("button", { name: "Done" })).toBeDefined()
    expect(ui.queryByRole("button", { name: "Save" })).toBeNull()
    expect(ui.container.querySelector("[data-save]")?.getAttribute("data-save")).toBe("saved")
    expect(ui.getByRole("toolbar", { name: "Canvas tools" })).toBeDefined()

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
})
