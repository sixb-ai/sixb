import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { client, type GetConnectorResponse, type GetSyncResponse } from "@sixb/client"
import {
  getAuthSessionQueryKey,
  getConnectorQueryKey,
  getSyncQueryKey,
  listSyncsQueryKey,
  listWebhookRunsQueryKey,
} from "@sixb/client/hooks"
import type { FileRef } from "@sixb/core/blob-storage"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { SyncButton } from "../src"
import { DataConnectorPage, SectionsProvider } from "../src/pages"
import { DatasetCell, datasetColumnNames } from "../src/pages/data/datasets"
import { projectionRunsPollInterval } from "../src/pages/data/projections"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])
const apiUrl = "https://api.sixb.test"
const originalConfig = client.getConfig()
let sockets: ReturnType<typeof stubWebSockets> | undefined
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: apiUrl })

beforeAll(() => {
  sockets = stubWebSockets()
})

afterEach(() => {
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  sockets?.restore()
})

function renderPage(
  ui: ReactNode,
  options: {
    readonly path: string
    readonly data?: readonly (readonly [readonly unknown[], unknown])[]
  }
) {
  // Cached answers never go stale, so a page only fetches what the test leaves out.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(getAuthSessionQueryKey(), { authenticated: false, authEnabled: false })
  for (const [key, value] of options.data ?? []) queryClient.setQueryData(key, value)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SectionsProvider visibility={undefined}>
        <MemoryRouter initialEntries={[options.path]}>
          <Routes>
            <Route path="/data/connectors/:connectorId" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )
  return { view, queryClient }
}

const now = Date.UTC(2026, 9, 7, 12)

describe("projection runs", () => {
  test("poll only while one is pending", () => {
    // Removal proof: return RUN_POLL_MS unconditionally (the old `refetchInterval: 5000`) and the
    // settled case polls again.
    expect(projectionRunsPollInterval([{ status: "queued" }], 0, now)).toBe(5000)
    expect(projectionRunsPollInterval([{ status: "running" }], 0, now)).toBe(5000)
    expect(
      projectionRunsPollInterval([{ status: "succeeded" }, { status: "failed" }], 0, now)
    ).toBe(false)
  })

  test("poll after a source commit until its run can have been queued", () => {
    // The commit event arrives before the orchestrator persists the run it queues.
    expect(projectionRunsPollInterval([{ status: "succeeded" }], now - 59_000, now)).toBe(5000)
    expect(projectionRunsPollInterval([{ status: "succeeded" }], now - 60_000, now)).toBe(false)
  })
})

test("dataset cells show files only in columns declared fileRef", () => {
  const fileRef: FileRef = {
    blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sizeBytes: 7789,
    fileName: "download.jpeg",
    mediaType: "image/jpeg",
  }
  // Removal proof: drop `type === "fileRef" &&` from DatasetCell and the json cell shows a file.
  const markup = (cell: ReactNode) => {
    const html = render(cell).container.innerHTML
    cleanup()
    return html
  }
  const file = markup(<DatasetCell type="fileRef" value={fileRef} hiddenLabel={null} />)
  const record = markup(<DatasetCell type="json" value={fileRef} hiddenLabel={null} />)
  expect(file).toContain(">download.jpeg<")
  expect(file).not.toContain(fileRef.blobId)
  expect(record).toContain(fileRef.blobId)
  expect(markup(<DatasetCell type="string" value="secret" hiddenLabel="Hidden" />)).not.toContain(
    "secret"
  )
})

// Removal proof: return `page.columns` from datasetColumnNames and the withheld column disappears.
test("a withheld column keeps its place in the grid", () => {
  const schema = [{ name: "id" }, { name: "email" }, { name: "plan" }]
  expect(
    datasetColumnNames(schema, {
      columns: ["id", "plan"],
      redactions: { email: { reason: "missing_clearance" } },
    })
  ).toEqual(["id", "email", "plan"])
  // A column the page left out for any other reason stays out.
  expect(datasetColumnNames(schema, { columns: ["id"] })).toEqual(["id"])
  expect(datasetColumnNames(schema)).toEqual(["id", "email", "plan"])
})

function answerWith(answer: (request: Request) => Response) {
  const api = async (input: RequestInfo | URL, init?: RequestInit) =>
    answer(new Request(input, init))
  client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
}

// Removal proof: drop `error.status === 404` from useLoadFailure and the outage reads "Not found".
test("a detail page says Not found for a 404 alone", async () => {
  for (const [status, heading, text] of [
    [404, "Not found", "Nothing is called “github”. It may have been renamed or removed."],
    [503, "Could not load", "Storage is unavailable."],
  ] as const) {
    answerWith(() => Response.json({ error: "Storage is unavailable." }, { status }))
    const { view } = renderPage(<DataConnectorPage />, {
      path: "/data/connectors/github",
      data: [[listSyncsQueryKey(), []]],
    })
    expect(await view.findByRole("heading", { level: 1, name: heading })).toBeDefined()
    expect(view.getByText(text)).toBeDefined()
    cleanup()
  }
})

describe("a connector's webhooks", () => {
  const connector: GetConnectorResponse = {
    id: "github",
    type: "github",
    connection: null,
    syncIds: [],
    webhooks: [],
  }
  const webhook = {
    id: "push",
    method: "POST" as const,
    route: "/api/webhooks/github/push",
    bodyFormat: "json" as const,
    hasVerify: true,
    hasIdempotency: false,
  }
  const runsKey = listWebhookRunsQueryKey({
    query: { connectorId: "github", limit: "20", order: "desc" },
  })

  // Removal proof: drop `enabled` from the deliveries query and the request goes out; render the
  // sections without the `webhooks.length > 0` check and they show.
  test("stay hidden, deliveries unrequested, on a connector without any", () => {
    const { view, queryClient } = renderPage(<DataConnectorPage />, {
      path: "/data/connectors/github",
      data: [
        [getConnectorQueryKey({ path: { connectorId: "github" } }), connector],
        [listSyncsQueryKey(), []],
      ],
    })
    expect(view.getByRole("heading", { name: "Github" })).toBeDefined()
    expect(view.queryByText("Webhooks")).toBeNull()
    expect(queryClient.getQueryState(runsKey)?.fetchStatus ?? "idle").toBe("idle")
    expect(queryClient.getQueryState(runsKey)?.dataUpdatedAt ?? 0).toBe(0)
  })

  test("show their full address", () => {
    const { view } = renderPage(<DataConnectorPage />, {
      path: "/data/connectors/github",
      data: [
        [
          getConnectorQueryKey({ path: { connectorId: "github" } }),
          { ...connector, webhooks: [webhook] },
        ],
        [listSyncsQueryKey(), []],
        [runsKey, { runs: [], hasMore: false, total: 0 }],
      ],
    })
    expect(view.getByText("Webhooks")).toBeDefined()
    expect(view.getByText(`POST ${apiUrl}/api/webhooks/github/push`)).toBeDefined()
    expect(view.getByText("No deliveries yet")).toBeDefined()
  })
})

describe("SyncButton", () => {
  const sync = (latestRun: GetSyncResponse["latestRun"]): GetSyncResponse => ({
    id: "sync-orbit",
    mode: "snapshot",
    connector: { id: "github", type: "github" },
    target: { kind: "dataset", dataset: { id: "orbit", schema: { columns: [] } } },
    triggers: [],
    latestRun,
  })
  const run = (status: "queued" | "succeeded" | "failed") => ({
    id: "run-1",
    projectId: "project",
    syncId: "sync-orbit",
    datasetId: "orbit",
    mode: "snapshot" as const,
    status,
    queuedAt: "2026-10-14T09:00:00.000Z",
    finishedAt: status === "queued" ? undefined : "2026-10-14T09:01:00.000Z",
  })
  const syncKey = getSyncQueryKey({ path: { syncId: "sync-orbit" } })

  test("says how the last sync went", () => {
    for (const [latestRun, text] of [
      [null, "Never synced"],
      [run("failed"), "Last sync failed"],
      [run("succeeded"), /^Synced /],
    ] as const) {
      const { view } = renderPage(<SyncButton sync="sync-orbit" showStatus />, {
        path: "/",
        data: [[syncKey, sync(latestRun)]],
      })
      expect(view.getByText(text)).toBeDefined()
      expect(view.getByRole("button", { name: "Sync now" })).toBeDefined()
      cleanup()
    }
  })

  // Removal proof: show the status only with `showStatus` and the refusal goes unseen.
  test("shows a refused request beside the button", async () => {
    answerWith((request) =>
      request.method === "POST"
        ? Response.json({ error: "You may not run this sync." }, { status: 403 })
        : Response.json(sync(run("succeeded")))
    )
    const { view } = renderPage(<SyncButton sync="sync-orbit" />, {
      path: "/",
      data: [[syncKey, sync(run("succeeded"))]],
    })
    expect(view.queryByText(/^Synced /)).toBeNull()
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Sync now" }))
    })
    expect(await view.findByText("You may not run this sync.")).toBeDefined()
  })

  // Removal proof: drop the queued and running statuses from `working` and the button turns back
  // to "Sync now" as soon as the request returns, while the run still waits.
  test("starts a run, then stays busy while it is queued", async () => {
    const requests: string[] = []
    // The API: starting a run queues it, and the sync then reports that run.
    const api = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return request.method === "POST"
        ? Response.json(run("queued"), { status: 202 })
        : Response.json(sync(run("queued")))
    }
    client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
    const { view } = renderPage(<SyncButton sync="sync-orbit" />, {
      path: "/",
      data: [[syncKey, sync(run("succeeded"))]],
    })

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Sync now" }))
    })
    await waitFor(() => expect(requests).toContain("GET /api/syncs/sync-orbit"))
    expect(requests[0]).toBe("POST /api/syncs/sync-orbit/runs")
    const busy = await view.findByRole("button", { name: "Syncing…" })
    expect(busy.hasAttribute("disabled")).toBe(true)
  })
})
