import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetArtifactResponse, type GetArtifactVersionResponse } from "@sixb/client"
import {
  getArtifactQueryKey,
  getArtifactVersionQueryKey,
  getAuthSessionQueryKey,
} from "@sixb/client/hooks"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { type ReactNode, useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { ThreadArtifactsMenu } from "../src/agent/components/thread-artifacts-menu"
import { artifactFileSource } from "../src/artifacts/file-source"
import { ArtifactPeopleContext } from "../src/artifacts/people"
import { ArtifactEmbed } from "../src/artifacts/references/references"
import type { ViewerChrome } from "../src/artifacts/viewer"
import { Viewer } from "../src/artifacts/viewer"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })

// Radix picks its layout effect when it loads, a no-op without a `document`, and its menus and
// dialogs then never mount. It is given React's own for this file, and its own back after.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

afterEach(async () => {
  // A dialog's focus scope lets go a tick after it unmounts: unmount while the window is there.
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
})

const ARTIFACT_ID = "art_sh4r3d0001"
const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const
const at = "2026-10-21T09:00:00.000Z"

type Access = GetArtifactResponse["access"]
type Kind = GetArtifactResponse["artifact"]["kind"]

/** Bob reads Alice's artifact, shared with him through a conversation, with the access given. */
function sharedArtifact(kind: Kind, access: Access): QueryClient {
  const queries = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  queries.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    authEnabled: true,
    user: { id: bob.id, email: "bob@example.com", displayName: "Bob Durand", groupIds: [] },
  })

  queries.setQueryData(getArtifactQueryKey({ path: { artifactId: ARTIFACT_ID } }), {
    artifact: {
      id: ARTIFACT_ID,
      projectId: "proj",
      kind,
      title: "Regions",
      owner: alice,
      latestVersion: 3,
      revision: 3,
      createdAt: at,
      updatedAt: at,
    },
    versions: [
      // The current version, which Bob last wrote; Alice created version 2, the system version 1.
      {
        version: 3,
        revision: 3,
        frozen: false,
        title: "Regions",
        author: bob,
        createdAt: "2026-10-21T10:30:00.000Z",
        updatedAt: "2026-10-21T11:00:00.000Z",
      },
      {
        version: 2,
        revision: 2,
        frozen: true,
        title: "Regions",
        author: bob,
        createdAt: "2026-10-21T09:00:00.000Z",
        updatedAt: "2026-10-21T10:00:00.000Z",
        frozenAt: "2026-10-21T10:30:00.000Z",
        frozenBy: alice,
      },
      {
        version: 1,
        revision: 1,
        frozen: true,
        title: "Regions",
        author: { type: "system", id: "system" },
        createdAt: at,
        updatedAt: at,
        frozenAt: at,
        frozenBy: { type: "system", id: "system" },
      },
    ],
    access,
  } satisfies GetArtifactResponse)

  const texts: Record<string, string> =
    kind === "sheet"
      ? {
          "workbook.json": JSON.stringify({
            sheets: [{ name: "Regions", columns: { Visits: "number" } }],
          }),
          "sheets/Regions.csv": "Region,Visits\nNorth,1284\nSouth,1107\n",
        }
      : { "index.html": "<h1>Planner</h1>" }
  const files = Object.entries(texts).map(([path, text]) => ({
    path,
    file: {
      blobId: `blob_${path}`,
      digest: `sha256:${"0".repeat(64)}`,
      sizeBytes: text.length,
      mediaType: path.endsWith(".csv") ? "text/csv" : "application/json",
    },
  }))
  queries.setQueryData(
    getArtifactVersionQueryKey({ path: { artifactId: ARTIFACT_ID, version: "3" } }),
    {
      artifactId: ARTIFACT_ID,
      version: 3,
      title: "Regions",
      entry: kind === "sheet" ? "workbook.json" : "index.html",
      files,
      outline:
        kind === "sheet"
          ? { kind: "sheet", sheets: [], charts: [] }
          : { kind: "page", title: "Planner" },
      references: [],
      author: bob,
      createdAt: "2026-10-21T10:30:00.000Z",
      updatedAt: "2026-10-21T11:00:00.000Z",
      revision: 3,
      frozen: false,
    } satisfies GetArtifactVersionResponse
  )
  for (const file of files) {
    const source = artifactFileSource({
      artifactId: ARTIFACT_ID,
      version: 3,
      ...file,
      fileRef: file.file,
    })
    queries.setQueryData([...source.queryKey, "text"], texts[file.path])
  }

  return queries
}

/** What the API was asked, and what it answers. */
function stubApi(answer: (url: URL, method: string) => Response | undefined) {
  const requests: string[] = []
  client.setConfig({
    fetch: Object.assign(
      async (input: Request) => {
        const url = new URL(input.url)
        requests.push(`${input.method} ${url.pathname}${url.search}`)
        if (url.pathname === "/api/files") {
          return Response.json(
            {
              blobId: "blob_new",
              digest: `sha256:${"1".repeat(64)}`,
              sizeBytes: 1,
              mediaType: "text/csv",
            },
            { status: 201 }
          )
        }

        return answer(url, input.method) ?? Response.json({ error: "Not found" }, { status: 404 })
      },
      { preconnect: globalThis.fetch.preconnect }
    ) as unknown as typeof fetch,
  })
  return requests
}

function Wrap({
  queries,
  locale,
  children,
}: {
  readonly queries: QueryClient
  readonly locale?: string
  readonly children: ReactNode
}) {
  return (
    <QueryClientProvider client={queries}>
      <LocaleProvider {...(locale ? { locale } : {})}>
        <MemoryRouter>{children}</MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>
  )
}

function viewer(queries: QueryClient, chrome: ViewerChrome = {}) {
  // The conversation names Alice; Bob, the reader, is "You".
  const people = (author: { readonly id: string }) =>
    author.id === alice.id ? "Alice Martin" : undefined

  return render(
    <Wrap queries={queries}>
      <ArtifactPeopleContext.Provider value={people}>
        <Viewer
          target={{ type: "artifact", artifactId: ARTIFACT_ID }}
          onTargetChange={() => {}}
          chrome={chrome}
        />
      </ArtifactPeopleContext.Provider>
    </Wrap>
  )
}

/** Opens a Radix menu the way a pointer does. */
async function openMenu(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" })
  })
}

function typeInto(input: HTMLElement, value: string) {
  let prototype: object | null = Object.getPrototypeOf(input)
  while (prototype && !Object.getOwnPropertyDescriptor(prototype, "value")) {
    prototype = Object.getPrototypeOf(prototype)
  }
  if (!prototype) throw new Error("Expected an input.")

  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value)
  fireEvent.keyUp(input, { key: value.at(-1) ?? "" })
}

describe("an artifact shared in a conversation", () => {
  test("is edited by its owner and participants, and only read by an observer", () => {
    // Reproduce by letting any access publish in useArtifactEdit: the observer gets Edit too.
    for (const [access, editable] of [
      ["owner", true],
      ["update", true],
      ["read", false],
    ] as const) {
      const ui = viewer(sharedArtifact("sheet", access))
      expect(ui.queryByRole("button", { name: "Edit" }) !== null).toBe(editable)
      ui.unmount()
    }
  })

  test("is deleted by its owner only, after asking, and the viewer then closes", async () => {
    // Reproduce by offering Delete for any access in ArtifactMenu: a participant's sheet gets a
    // More menu.
    for (const access of ["update", "read"] as const) {
      const ui = viewer(sharedArtifact("sheet", access))
      expect(ui.queryByRole("button", { name: "More" })).toBeNull()
      ui.unmount()
    }

    const requests = stubApi((url, method) =>
      method === "DELETE" && url.pathname === `/api/artifacts/${ARTIFACT_ID}`
        ? Response.json({ deleted: true })
        : undefined
    )
    const closed = mock(() => {})
    const ui = viewer(sharedArtifact("sheet", "owner"), { onClose: closed })

    await openMenu(ui.getByRole("button", { name: "More" }))
    await act(async () => {
      fireEvent.click(await ui.findByRole("menuitem", { name: /^Delete/ }))
    })

    const dialog = await ui.findByRole("alertdialog")
    expect(within(dialog).getByText("Delete “Regions”?")).toBeDefined()
    expect(requests).toEqual([])

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    })
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
    expect(requests).toEqual([`DELETE /api/artifacts/${ARTIFACT_ID}`])
  })

  test("names who wrote the current version and who created each other: the reader as you, the conversation's people by name", async () => {
    // Reproduce by naming each version's last writer: version 2 reads Bob, who wrote it, not
    // Alice, who created it.
    const ui = viewer(sharedArtifact("sheet", "update"))
    await openMenu(ui.getByRole("button", { name: "Current · Versions" }))

    const items = (await ui.findAllByRole("menuitemradio")).map((item) => item.textContent ?? "")
    expect(items).toHaveLength(3)
    expect(items[0]).toStartWith("CurrentBDEdited by you · Oct 21")
    expect(items[1]).toStartWith("Version 2AMCreated by Alice Martin · Oct 21")
    // The system is nobody the reader knows: its version says only when.
    expect(items[2]).toStartWith("Version 1Created Oct 21")
  })

  test("keeps no data for an observer, who has nothing to reset", () => {
    // Reproduce by dropping `access !== "read"` from ArtifactMenu: the observer's page gets More.
    for (const [access, more] of [
      ["update", true],
      ["read", false],
    ] as const) {
      const queries = sharedArtifact("page", access)
      queries.setQueryData(["artifact-state", ARTIFACT_ID], new Map([["crew", 12]]))
      const ui = viewer(queries)
      expect(ui.queryByRole("button", { name: "More" }) !== null).toBe(more)
      ui.unmount()
    }
  })

  test("tells a participant who saves that everyone in the conversation sees it", async () => {
    // Reproduce by never setting savedShared in useArtifactEdit: the save says nothing.
    for (const [access, says] of [
      ["update", true],
      ["owner", false],
    ] as const) {
      stubApi((url) =>
        url.pathname === `/api/artifacts/${ARTIFACT_ID}/versions`
          ? Response.json(
              {
                artifact: {},
                version: {
                  artifactId: ARTIFACT_ID,
                  version: 3,
                  revision: 4,
                  frozen: false,
                  title: "Regions",
                  entry: "workbook.json",
                  files: [],
                  outline: { kind: "sheet", sheets: [], charts: [] },
                  references: [],
                  author: bob,
                  createdAt: "2026-10-21T10:30:00.000Z",
                  updatedAt: "2026-10-21T12:00:00.000Z",
                },
              },
              { status: 201 }
            )
          : undefined
      )
      const ui = viewer(sharedArtifact("sheet", access))

      await act(async () => {
        fireEvent.click(ui.getByRole("button", { name: "Edit" }))
      })
      const cell = ui.container.querySelector('[role="grid"] [data-row="1"][data-column="1"]')
      await act(async () => {
        fireEvent.doubleClick(cell as Element)
      })
      const input = ui.container.querySelector('[role="grid"] input') as HTMLInputElement
      await act(async () => typeInto(input, "1300"))
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" })
      })
      await act(async () => {
        fireEvent.click(ui.getByRole("button", { name: "Save" }))
      })

      await waitFor(() => expect(ui.queryByRole("button", { name: "Save" })).toBeNull())
      const status = ui.queryByText("Saved — everyone in this conversation sees it.")
      expect(status !== null).toBe(says)
      ui.unmount()
    }
  })

  test("is said to be not shared, calmly, where the reader can't open it", async () => {
    // Reproduce by dropping `notShared` from Pending: the embed reads "Unavailable".
    stubApi((url) =>
      url.pathname.startsWith("/api/artifacts/art_pr1vat3000")
        ? Response.json({ error: "Not shared", code: "not_shared" }, { status: 403 })
        : undefined
    )
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const ui = render(
      <Wrap queries={queries}>
        <ArtifactEmbed address="artifact:art_pr1vat3000" caption="Margins" />
        <div data-testid="slide" style={{ width: 400, height: 300 }}>
          <ArtifactEmbed address="artifact:art_pr1vat3000" caption="" fill />
        </div>
        <ArtifactEmbed address="artifact:art_g0n3000000" caption="Gone" />
      </Wrap>
    )
    await waitFor(() => expect(ui.getAllByText("Not shared in this conversation")).toHaveLength(2))
    expect(ui.getAllByText("It belongs to someone who hasn't shared it here.")).toHaveLength(2)
    // An artifact that no longer exists is another matter.
    expect(ui.getByText("Unavailable")).toBeDefined()

    const opened = render(
      <Wrap queries={queries}>
        <Viewer
          target={{ type: "artifact", artifactId: "art_pr1vat3000" }}
          onTargetChange={() => {}}
        />
      </Wrap>
    )
    expect(await opened.findByText("This artifact isn't shared with you")).toBeDefined()
  })

  test("says so in French too", async () => {
    stubApi(() => Response.json({ error: "Not shared", code: "not_shared" }, { status: 403 }))
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const ui = render(
      <Wrap queries={queries} locale="fr">
        <ArtifactEmbed address="artifact:art_pr1vat3000" caption="Marges" />
      </Wrap>
    )
    expect(await ui.findByText("Non partagé dans cette conversation")).toBeDefined()
  })
})

describe("a conversation's artifacts menu", () => {
  test("names a created version, and leaves the current one unnamed", async () => {
    // The current version changes in place. Reproduce by naming every latest version: the
    // current one reads v3.
    for (const [frozen, detail] of [
      [true, "Sheet · v3"],
      [false, "Sheet"],
    ] as const) {
      const requests = stubApi((url) =>
        url.pathname === "/api/artifacts"
          ? Response.json({
              artifacts: [
                {
                  id: ARTIFACT_ID,
                  projectId: "proj",
                  kind: "sheet",
                  title: "Regions",
                  owner: alice,
                  latestVersion: 3,
                  revision: 3,
                  createdAt: at,
                  updatedAt: at,
                },
              ],
              hasMore: false,
            })
          : url.pathname === `/api/artifacts/${ARTIFACT_ID}/versions/3`
            ? Response.json({
                artifactId: ARTIFACT_ID,
                version: 3,
                revision: 3,
                frozen,
                title: "Regions",
                entry: "workbook.json",
                files: [],
                outline: { kind: "sheet", sheets: [], charts: [] },
                references: [],
                author: alice,
                createdAt: at,
                updatedAt: at,
              })
            : undefined
      )
      const ui = render(
        <Wrap queries={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ThreadArtifactsMenu threadId="thr_1" onOpen={() => {}} withGallery={false} />
        </Wrap>
      )
      await openMenu(await ui.findByRole("button", { name: "1 artifact in this conversation" }))
      const item = await ui.findByRole("menuitem", { name: /Regions/ })
      // Once its latest version is read, it says what it is.
      await waitFor(() =>
        expect(requests).toContain(`GET /api/artifacts/${ARTIFACT_ID}/versions/3`)
      )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(item.textContent).toBe(`Regions${detail}`)
      ui.unmount()
    }
  })

  test("opens an artifact where there is no panel, as an observer's header does", async () => {
    // Reproduce by dropping `onOpen ??` from ThreadArtifactsMenu: outside a panel it shows nothing.
    const requests = stubApi((url) =>
      url.pathname === "/api/artifacts"
        ? Response.json({
            artifacts: [
              {
                id: ARTIFACT_ID,
                projectId: "proj",
                kind: "sheet",
                title: "Regions",
                owner: alice,
                latestVersion: 3,
                createdAt: at,
                updatedAt: at,
              },
            ],
            hasMore: false,
          })
        : undefined
    )
    const opened = mock((_target: unknown) => {})
    const ui = render(
      <Wrap queries={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThreadArtifactsMenu threadId="thr_1" onOpen={opened} withGallery={false} />
      </Wrap>
    )

    await openMenu(await ui.findByRole("button", { name: "1 artifact in this conversation" }))
    await act(async () => {
      fireEvent.click(await ui.findByRole("menuitem", { name: /Regions/ }))
    })
    expect(opened).toHaveBeenCalledWith({ type: "artifact", artifactId: ARTIFACT_ID })
    expect(requests[0]).toBe("GET /api/artifacts?thread=thr_1")
    // An observer's gallery holds none of these: no way to it.
    expect(ui.queryByRole("menuitem", { name: "All artifacts" })).toBeNull()
  })
})

describe("the version menu", () => {
  /** What the API was asked, with each request's body, and what it answers. */
  function recordApi(answer: (url: URL, method: string) => Response | undefined) {
    const requests: { readonly call: string; readonly body: unknown }[] = []
    client.setConfig({
      fetch: Object.assign(
        async (input: Request) => {
          const url = new URL(input.url)
          const body = input.method === "GET" ? undefined : await input.json().catch(() => null)
          requests.push({ call: `${input.method} ${url.pathname}`, body })
          return answer(url, input.method) ?? Response.json({ error: "Not found" }, { status: 404 })
        },
        { preconnect: globalThis.fetch.preconnect }
      ) as unknown as typeof fetch,
    })
    return requests
  }

  const turn = {
    artifactId: ARTIFACT_ID,
    revision: 2,
    version: 3,
    frozen: false,
    title: "Regions",
    author: bob,
    origin: { threadId: "thr_1", runId: "run_1" },
    updatedAt: "2026-10-21T10:45:00.000Z",
    reason: "turn" as const,
    turnRunId: "run_1",
    createdAt: "2026-10-21T10:50:00.000Z",
  }

  test("creates a version from the current one, from the revision the reader saw", async () => {
    // Reproduce by freezing without baseRevision: a change made meanwhile would be frozen unseen.
    const requests = recordApi((url) =>
      url.pathname === `/api/artifacts/${ARTIFACT_ID}/freeze`
        ? Response.json({ artifact: {}, version: { version: 3 } })
        : undefined
    )
    const ui = viewer(sharedArtifact("sheet", "update"))
    await openMenu(ui.getByRole("button", { name: "Current · Versions" }))

    const create = await ui.findByRole("menuitem", { name: /Create version/ })
    expect(create.textContent).toContain("Keep what it holds now as version 3.")
    await act(async () => {
      fireEvent.click(create)
    })

    await waitFor(() => expect(ui.getByRole("status").textContent).toBe("Version 3 created"))
    // Said on a phone too, under the header. The test DOM applies no container queries, so this
    // reads the classes: reproduce by hiding the status below the md width, as it once was.
    expect(ui.getByRole("status").className.split(" ")).not.toContain("hidden")
    expect(requests).toContainEqual({
      call: `POST /api/artifacts/${ARTIFACT_ID}/freeze`,
      body: { baseRevision: 3 },
    })
  })

  test("creates nothing when the latest version is already created, and nothing for an observer", async () => {
    // Reproduce by enabling Create version whatever the latest: it would freeze nothing new.
    const created = sharedArtifact("sheet", "update")
    const detail = created.getQueryData<GetArtifactResponse>(
      getArtifactQueryKey({ path: { artifactId: ARTIFACT_ID } })
    ) as GetArtifactResponse
    created.setQueryData(getArtifactQueryKey({ path: { artifactId: ARTIFACT_ID } }), {
      ...detail,
      versions: detail.versions.map((entry) =>
        entry.version === 3
          ? { ...entry, frozen: true, frozenAt: entry.updatedAt, frozenBy: bob }
          : entry
      ),
    })
    const ui = viewer(created)
    await openMenu(ui.getByRole("button", { name: "Current · Versions" }))
    const create = await ui.findByRole("menuitem", { name: /Create version/ })
    expect(create.getAttribute("aria-disabled")).toBe("true")
    expect(create.textContent).toContain("Nothing changed since version 3.")
    ui.unmount()

    const observer = viewer(sharedArtifact("sheet", "read"))
    await openMenu(observer.getByRole("button", { name: "Current · Versions" }))
    await observer.findAllByRole("menuitemradio")
    expect(observer.queryByRole("menuitem", { name: /Create version/ })).toBeNull()
    expect(observer.queryByRole("group", { name: "Restore" })).toBeNull()
  })

  test("restores a point after asking, from the revision the reader saw, and says when it changed", async () => {
    // Reproduce by restoring without baseRevision: a change made meanwhile would be replaced unseen.
    let moved = false
    const requests = recordApi((url, method) => {
      const points = `/api/artifacts/${ARTIFACT_ID}/restore-points`
      if (url.pathname === points) return Response.json({ restorePoints: [turn] })
      if (url.pathname === `${points}/2` && method === "GET") {
        return Response.json({
          ...turn,
          entry: "workbook.json",
          files: [],
          outline: { kind: "sheet", sheets: [], charts: [] },
          references: [],
        })
      }
      if (url.pathname === `${points}/2/restore`) {
        return moved
          ? Response.json(
              {
                error: "moved",
                code: "artifact_moved",
                latest: { version: 3, revision: 5, author: alice },
              },
              { status: 409 }
            )
          : Response.json({ artifact: {}, version: { version: 3 } })
      }
      return undefined
    })

    const restore = async () => {
      const ui = viewer(sharedArtifact("sheet", "update"))
      await openMenu(ui.getByRole("button", { name: "Current · Versions" }))
      const point = await ui.findByRole("menuitem", { name: /Before the agent's turn/ })
      await act(async () => {
        fireEvent.click(point)
      })
      const dialog = await ui.findByRole("alertdialog")
      expect(dialog.textContent).toContain("Restore “Before the agent's turn”")
      expect(dialog.textContent).toContain("It held “Regions”, as the agent left it.")
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }))
      })
      return ui
    }

    const ui = await restore()
    await waitFor(() => expect(ui.queryByRole("alertdialog")).toBeNull())
    expect(requests).toContainEqual({
      call: `POST /api/artifacts/${ARTIFACT_ID}/restore-points/2/restore`,
      body: { baseRevision: 3 },
    })
    ui.unmount()

    // Someone changed it while the dialog was open: it stays, and says so.
    moved = true
    const again = await restore()
    await waitFor(() =>
      expect(again.getByRole("alert").textContent).toBe(
        "It changed while this was open. Look at it again, then restore."
      )
    )
  })
})
