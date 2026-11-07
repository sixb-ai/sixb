import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import {
  client,
  type GetConnectorResponse,
  type GetDatasetResponse,
  type GetLakeHealthResponse,
  type GetSyncResponse,
  type ListDatasetRowsResponse,
} from "@sixb/client"
import {
  getAuthSessionQueryKey,
  getConnectorQueryKey,
  getDatasetQueryKey,
  getLakeHealthQueryKey,
  getSyncQueryKey,
  listDatasetRowsQueryKey,
  listDatasetVersionsQueryKey,
  listSyncsQueryKey,
  listWebhookRunsQueryKey,
} from "@sixb/client/hooks"
import type { FileRef } from "@sixb/core/blob-storage"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { type ReactNode, useLayoutEffect } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { SyncButton } from "../src"
import {
  ConsoleConnectorPage,
  ConsoleDatasetPage,
  ConsoleLakeHealthPage,
  SectionsProvider,
} from "../src/pages"
import { DatasetCell, datasetColumnNames } from "../src/pages/console/data/datasets"
import { projectionRunsPollInterval } from "../src/pages/console/data/projections"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"

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
  "FocusEvent",
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

// Radix picks its layout effect when it loads, a no-op without a `document`, and a sheet then
// never mounts. This file or another of the run loads it before the window exists, so it is given
// React's own, and its own back after the file.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

beforeAll(() => {
  sockets = stubWebSockets()
})

// A closed sheet's focus scope gives focus back on the next task; let it run while the window is
// still here, or it lands in the next file.
afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  sockets?.restore()
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
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
      <SectionsProvider>
        <MemoryRouter initialEntries={[options.path]}>
          <Routes>
            <Route path="/console/connectors/:connectorId" element={ui} />
            <Route path="/console/datasets/:datasetId" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )
  return { view, queryClient }
}

const now = Date.UTC(2026, 9, 7, 12)

// Removal proof: return RUN_POLL_MS unconditionally (the old `refetchInterval: 5000`) and the
// settled cases poll again.
test("projection runs poll while one is pending, or after a source commit until its run can have been queued", () => {
  expect(projectionRunsPollInterval([{ status: "queued" }], 0, now)).toBe(5000)
  expect(projectionRunsPollInterval([{ status: "running" }], 0, now)).toBe(5000)
  expect(projectionRunsPollInterval([{ status: "succeeded" }, { status: "failed" }], 0, now)).toBe(
    false
  )
  // The commit event arrives before the orchestrator persists the run it queues.
  expect(projectionRunsPollInterval([{ status: "succeeded" }], now - 59_000, now)).toBe(5000)
  expect(projectionRunsPollInterval([{ status: "succeeded" }], now - 60_000, now)).toBe(false)
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
    const { view } = renderPage(<ConsoleConnectorPage />, {
      path: "/console/connectors/github",
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
    const { view, queryClient } = renderPage(<ConsoleConnectorPage />, {
      path: "/console/connectors/github",
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
    const { view } = renderPage(<ConsoleConnectorPage />, {
      path: "/console/connectors/github",
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
    attempt: 1,
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

describe("a dataset version's details", () => {
  const dataset: GetDatasetResponse = {
    id: "service-cases",
    schema: { columns: [{ name: "status", type: "string" }] },
    kind: "dataset",
    materialized: true,
    latestVersion: {
      datasetId: "service-cases",
      versionId: "ducklake:84",
      mode: "snapshot",
      createdAt: "2026-10-30T09:00:00.000Z",
    },
    syncIds: [],
    sourcePipelineIds: ["reports"],
    targetPipelineIds: ["controls"],
    projectionIds: [],
  }
  const rows = (version: Partial<ListDatasetRowsResponse["version"]>): ListDatasetRowsResponse => ({
    datasetId: "service-cases",
    versionId: "ducklake:84",
    version: {
      datasetId: "service-cases",
      versionId: "ducklake:84",
      mode: "snapshot",
      createdAt: "2026-10-30T09:00:00.000Z",
      schema: dataset.schema,
      ...version,
    },
    columns: ["status"],
    rows: [],
    count: 0,
    limit: 100,
    offset: 0,
    hasMore: false,
  })
  const path = { datasetId: "service-cases" }
  const openDetails = async (version: Partial<ListDatasetRowsResponse["version"]>) => {
    const { view } = renderPage(<ConsoleDatasetPage />, {
      path: "/console/datasets/service-cases",
      data: [
        [getDatasetQueryKey({ path }), dataset],
        [listDatasetVersionsQueryKey({ path }), { versions: [], count: 0 }],
        [listDatasetRowsQueryKey({ path, query: { limit: "100", offset: "0" } }), rows(version)],
      ],
    })
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Details" })))
    return await view.findByRole("dialog")
  }

  // Removal proof: drop the producer and inputs facts from DatasetDetail and neither shows.
  test("say which run wrote it and the versions it was computed from", async () => {
    const sheet = await openDetails({
      producer: { kind: "pipeline", id: "controls", runId: "run_7", stepId: "join-cases" },
      inputs: [{ datasetId: "raw-cases", versionId: "ducklake:80" }],
    })

    // "Written by" names the pipeline too; the version's producer opens the run that wrote it.
    const pipelineLinks = within(sheet).getAllByRole("link", { name: "Controls" })
    expect(pipelineLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/console/pipelines/controls",
      "/console/pipelines/controls?run=run_7",
    ])
    expect(within(sheet).getByText("Join cases")).toBeDefined()

    const input = within(sheet).getByRole("link", { name: /raw-cases/ })
    expect(input.getAttribute("href")).toBe("/console/datasets/raw-cases?version=ducklake%3A80")
  })

  // Removal proof: swap `targetPipelineIds` and `sourcePipelineIds` back in DatasetDetail.
  test("list the pipeline that writes it under written by and the one that reads it under read by", async () => {
    const sheet = await openDetails({})

    const row = (label: string) => within(within(sheet).getByText(label).parentElement!)
    expect(row("Written by").getByRole("link", { name: "Controls" })).toBeDefined()
    expect(row("Read by").getByRole("link", { name: "Reports" })).toBeDefined()
    expect(row("Written by").queryByRole("link", { name: "Reports" })).toBeNull()
  })

  test("name a producer the reader may not follow by its kind alone", async () => {
    const sheet = await openDetails({ producer: { kind: "sync" } })

    expect(within(sheet).getByText("A sync")).toBeDefined()
    expect(within(sheet).queryByText("Computed from")).toBeNull()
  })
})

describe("Lake health", () => {
  const cleanup: GetLakeHealthResponse["cleanup"] = {
    state: "ok",
    lastRequestedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lastRunAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    keepVersionsFor: "7d",
    deleteFilesAfter: "7d",
    cleanupEvery: "1h",
  }

  function renderHealth(health: GetLakeHealthResponse) {
    return renderPage(<ConsoleLakeHealthPage />, {
      path: "/console/lake-health",
      data: [[getLakeHealthQueryKey(), health]],
    })
  }

  // Reproduce: list inlined rows at zero, or drop the warnings list, in lake-health.tsx.
  test("shows each dataset's storage, its warnings, and what cleanup does", () => {
    const { view } = renderHealth({
      available: true,
      cleanup,
      datasets: [
        {
          datasetId: "raw.events",
          materialized: true,
          rowCount: 1_200,
          dataFiles: 12,
          smallDataFiles: 9,
          dataBytes: 48_000,
          deleteFiles: 2,
          inlinedRows: 0,
          retainedSnapshots: 31,
          partitionBy: ["region"],
          warnings: [
            { code: "partitioned-small-dataset", message: "Partitioned below a million rows." },
          ],
          ingest: null,
        },
        {
          datasetId: "raw.drafts",
          materialized: false,
          rowCount: 0,
          dataFiles: 0,
          smallDataFiles: 0,
          dataBytes: 0,
          deleteFiles: 0,
          inlinedRows: 0,
          retainedSnapshots: 0,
          partitionBy: [],
          warnings: [],
          ingest: null,
        },
      ],
    })

    expect(view.getByText("Healthy")).toBeDefined()
    expect(view.getByText("1 hour")).toBeDefined()
    expect(view.getAllByText("7 days")).toHaveLength(2)
    expect(view.getByText("5 minutes ago")).toBeDefined()
    expect(view.getByText("4 minutes ago")).toBeDefined()
    expect(view.getByRole("link", { name: "raw.events" }).getAttribute("href")).toBe(
      "/console/datasets/raw.events"
    )
    expect(view.getByText("12 files (9 small)")).toBeDefined()
    expect(view.getByText("2 delete files")).toBeDefined()
    expect(view.queryByText(/^\d+ inlined rows?$/)).toBeNull()
    expect(view.getByText("Partitioned by region")).toBeDefined()
    expect(view.getByText("1 warning")).toBeDefined()
    expect(view.getByText("Partitioned below a million rows.")).toBeDefined()
    expect(view.getByText("Not written yet")).toBeDefined()
  })

  // Reproduce: drop `IngestWaiting` from the dataset row in lake-health.tsx.
  test("shows the ingested changes that wait for a flush, and how long", () => {
    const { view } = renderHealth({
      available: true,
      cleanup,
      datasets: [
        {
          datasetId: "raw.crm.people",
          materialized: false,
          rowCount: 0,
          dataFiles: 0,
          smallDataFiles: 0,
          dataBytes: 0,
          deleteFiles: 0,
          inlinedRows: 0,
          retainedSnapshots: 0,
          partitionBy: [],
          warnings: [],
          ingest: {
            pendingDeliveries: 12,
            pendingChanges: 1_250,
            oldestReceivedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
            rejectedDeliveries: 0,
          },
        },
      ],
    })

    expect(view.getByText("1,250 ingested changes waiting")).toBeDefined()
    expect(view.getByText("oldest received 3 minutes ago")).toBeDefined()
  })

  // Reproduce: leave `messages.rejected` out of IngestWaiting in lake-health.tsx.
  test("says when deliveries were refused, with nothing waiting", () => {
    const { view } = renderHealth({
      available: true,
      cleanup,
      datasets: [
        {
          datasetId: "raw.crm.people",
          materialized: false,
          rowCount: 0,
          dataFiles: 0,
          smallDataFiles: 0,
          dataBytes: 0,
          deleteFiles: 0,
          inlinedRows: 0,
          retainedSnapshots: 0,
          partitionBy: [],
          warnings: [],
          ingest: {
            pendingDeliveries: 0,
            pendingChanges: 0,
            oldestReceivedAt: null,
            rejectedDeliveries: 2,
          },
        },
      ],
    })

    expect(
      view.getByText("2 deliveries refused, kept for a week: sixb lake rejected")
    ).toBeDefined()
  })

  test("says so when the lake storage has no maintenance", () => {
    const { view } = renderHealth({ available: false, cleanup, datasets: [] })

    expect(view.getByText("This lake storage has no maintenance")).toBeDefined()
    expect(view.queryByText("Automatic cleanup")).toBeNull()
  })

  test("says when automatic cleanup is off", () => {
    const { view } = renderHealth({
      available: true,
      cleanup: { ...cleanup, state: "off", lastRequestedAt: null, lastRunAt: null },
      datasets: [],
    })

    expect(view.getByText("Off")).toBeDefined()
    expect(view.getAllByText("Never")).toHaveLength(2)
    expect(view.getByText("No datasets")).toBeDefined()
  })

  // Reproduce: show `states.ok` for every state in lake-health.tsx. The page then says cleanup runs
  // while the lake grows.
  test("names what is missing instead of claiming that cleanup runs", () => {
    const expected = [
      ["not-requested", "Not running", "the orchestrator is not running"],
      ["no-worker", "Waiting for a lake worker", "no lake worker has run it"],
      ["failing", "Failing", "The last attempt failed"],
    ] as const

    for (const [state, label, note] of expected) {
      const { view } = renderHealth({
        available: true,
        cleanup: { ...cleanup, state },
        datasets: [],
      })

      expect(view.getByText(label)).toBeDefined()
      expect(view.getByText(new RegExp(note))).toBeDefined()
      expect(view.queryByText("Healthy")).toBeNull()

      view.unmount()
    }
  })
})
