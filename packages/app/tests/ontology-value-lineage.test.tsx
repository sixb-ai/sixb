import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type GetUserResponse } from "@sixb/client"
import {
  getAuthSessionQueryKey,
  getDatasetVersionLineageQueryKey,
  listActionsQueryKey,
  userQueryOptions,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { SectionsProvider } from "../src/pages"
import {
  type DatasetLineage,
  explainProperty,
  hiddenSteps,
  lineageSummary,
  type ObjectLineage,
  type ProjectionSource,
  type PropertyLineage,
  resolutionOf,
  upstreamSteps,
} from "../src/pages/ontology/lineage/model"
import { PropertiesPanel } from "../src/pages/ontology/lineage/properties-panel"
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

// Radix picks its layout effect when it loads, a no-op without a `document`, and the sheet then
// never mounts. This file or another of the run loads it before the window exists, so it is given
// React's own, and its own back after the file.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })

// A closed sheet's focus scope gives focus back on the next task; let it run while the window is
// still here, or it lands in the next file.
afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

const editedAt = "2026-10-30T09:12:44.120Z"
const sourceUpdatedAt = "2026-10-31T08:00:00.000Z"
const applied = { datasetId: "crm.cases", versionId: "ducklake:84" }
const tickets = { datasetId: "raw.tickets", versionId: "ducklake:80" }
const accounts = { datasetId: "raw.accounts", versionId: "ducklake:12" }
const weather = { datasetId: "raw.weather", versionId: "ducklake:3" }

// A service case imported from the CRM: Alice acknowledged it, which replaced the imported
// status; its severity comes from the CRM, which a pipeline computed from raw tickets (whose rows
// accounts decide) and the weather; a newer CRM row won over her edit of the title; an edit whose
// commit cannot be told apart set the owner.
const lineage: ObjectLineage = {
  objectTypeId: "ServiceCase",
  primaryId: "sc-1042",
  existence: { source: "projection:crm-cases" },
  sources: {
    "projection:crm-cases": {
      kind: "projection",
      projectionId: "crm-cases",
      projectionRunId: "prj_run_12",
      datasetVersion: applied,
      rowOrigins: [{ datasetId: "raw.accounts", column: "id" }],
    },
    "commit:cmt_91": {
      kind: "edit",
      commitId: "cmt_91",
      committedAt: editedAt,
      requestedBy: { type: "user", id: "usr_alice" },
      executor: {
        type: "primitive",
        kind: "action",
        id: "acknowledge-service-case",
        runId: "run_7",
      },
      action: { actionId: "acknowledge-service-case", runId: "run_7" },
    },
    [`commit@${editedAt}`]: { kind: "edit", commitId: null, committedAt: editedAt },
    identity: { kind: "identity" },
  },
  properties: {
    id: { source: "identity" },
    status: {
      source: "commit:cmt_91",
      replaced: { source: "projection:crm-cases", column: "status", value: "new" },
      resolution: { strategy: "editsWin" },
    },
    severity: {
      source: "projection:crm-cases",
      column: "severity",
      origins: [{ datasetId: "raw.tickets", column: "priority" }],
    },
    title: {
      source: "projection:crm-cases",
      column: "title",
      replaced: { source: "commit:cmt_91", value: "Fan noise" },
      resolution: { strategy: "mostRecent", sourceUpdatedAt, editedAt },
    },
    owner: { source: `commit@${editedAt}` },
  },
  // Hidden steps elsewhere in the object; no trail here has one.
  restricted: 3,
}

const upstream: DatasetLineage = {
  nodes: [
    {
      ...applied,
      mode: "snapshot",
      createdAt: "2026-10-31T07:00:00.000Z",
      producer: { kind: "pipeline", id: "cases", runId: "pip_run_3", stepId: "derive" },
    },
    {
      ...tickets,
      mode: "append",
      createdAt: "2026-10-31T06:00:00.000Z",
      producer: { kind: "sync", id: "crm-tickets", runId: "syn_run_9" },
    },
    { ...weather, mode: "snapshot", createdAt: "2026-10-31T05:00:00.000Z" },
    { ...accounts, expired: true },
  ],
  edges: [
    { from: tickets, to: applied },
    { from: weather, to: applied },
    { from: accounts, to: tickets },
  ],
  restricted: 0,
  truncated: true,
}

const alice: GetUserResponse = {
  id: "usr_alice",
  email: "alice@northline.test",
  displayName: "Alice Martin",
  status: "active",
}

const values = {
  id: "sc-1042",
  status: "triage",
  severity: "high",
  title: "Supply fan noise",
  owner: "Dispatch desk",
}
const labels = { id: "ID", status: "Status", severity: "Severity", title: "Title", owner: "Owner" }

/** `null` renders the page before its lineage arrives. */
function renderProperties(shownLineage: ObjectLineage | null = lineage) {
  // Cached answers never go stale, so nothing here fetches.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(getAuthSessionQueryKey(), { authenticated: false, authEnabled: false })
  queryClient.setQueryData(getDatasetVersionLineageQueryKey({ path: applied }), upstream)
  queryClient.setQueryData(userQueryOptions({ type: "user", id: "usr_alice" }).queryKey, alice)
  queryClient.setQueryData(listActionsQueryKey(), [
    { id: "acknowledge-service-case", name: "Acknowledge the case", params: [] },
  ])

  const page = (pageLineage: ObjectLineage | null) => (
    <QueryClientProvider client={queryClient}>
      <SectionsProvider visibility={undefined}>
        <MemoryRouter>
          <PropertiesPanel
            title="Properties"
            objectName="SC-1042"
            properties={values}
            propertySchema={() => undefined}
            labels={labels}
            lineage={pageLineage ?? undefined}
          />
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )

  const view = render(page(shownLineage))
  return Object.assign(view, {
    refresh: (next: ObjectLineage) => view.rerender(page(next)),
  })
}

async function explain(view: ReturnType<typeof render>, name: RegExp) {
  await act(async () => fireEvent.click(view.getByRole("button", { name })))
  return within(await view.findByRole("dialog", { name: "Where this value comes from" }))
}

function explained(propertyId: string, from: ObjectLineage = lineage) {
  const property = explainProperty(from, propertyId)
  if (!property) throw new Error(`'${propertyId}' is explained`)
  return property
}

describe("what decided a value", () => {
  // Removal proof: drop the identity check from explainProperty and the primary key is explained.
  test("the primary key explains nothing", () => {
    expect(explainProperty(lineage, "id")).toBeNull()
    expect(explainProperty(lineage, "missing")).toBeNull()
    expect(explainProperty(lineage, "status")?.source.kind).toBe("edit")
  })

  test("the header counts the values an edit decided", () => {
    const summary = lineageSummary(lineage)
    expect(summary.existence?.kind).toBe("projection")
    expect(summary.edited).toBe(2)
  })

  test("only the newer-wins rule says why a source won", () => {
    expect(resolutionOf(lineage, explained("status"))).toBeNull()
    expect(resolutionOf(lineage, explained("title"))).toEqual({
      winner: "source",
      edit: lineage.sources["commit:cmt_91"] as never,
    })
  })

  // Removal proof: return every node from upstreamSteps and the weather, which feeds no column of
  // the value, joins the trail.
  test("the walk upstream keeps only the versions the value comes from", () => {
    const steps = (
      origins: PropertyLineage["origins"],
      rowOrigins: ProjectionSource["rowOrigins"]
    ) =>
      upstreamSteps(upstream, origins, rowOrigins).map((step) => [
        step.node.datasetId,
        step.columns,
      ])

    expect(
      steps(lineage.properties.severity?.origins, [{ datasetId: "raw.accounts", column: "id" }])
    ).toEqual([
      ["raw.tickets", ["priority"]],
      ["raw.accounts", []],
    ])
    // A version between the applied one and a dataset the value reads stays on the trail.
    expect(steps([{ datasetId: "raw.accounts", column: "region" }], undefined)).toEqual([
      ["raw.tickets", []],
      ["raw.accounts", ["region"]],
    ])
    // Without recorded column lineage nothing can be ruled out.
    expect(steps(undefined, undefined)).toHaveLength(3)
  })

  // Removal proof: count `lineage.restricted` in hiddenSteps and every trail reports the object's
  // other hidden steps.
  test("a trail counts only its own hidden steps", () => {
    expect(hiddenSteps(explained("status"))).toBe(0)
    expect(hiddenSteps(explained("owner"))).toBe(0)
    expect(hiddenSteps(explained("severity"), { ...upstream, restricted: 2 })).toBe(2)

    const hiddenRun: ObjectLineage = {
      ...lineage,
      sources: {
        ...lineage.sources,
        "projection:crm-cases": { kind: "projection", projectionId: "crm-cases" },
      },
    }
    expect(hiddenSteps(explained("severity", hiddenRun))).toBe(2)
  })
})

describe("a property's source", () => {
  test("marks each explained name, and leaves the primary key and an unread lineage plain", () => {
    const view = renderProperties()
    expect(view.getByRole("button", { name: /^Status.*Edited/ })).toBeDefined()
    expect(view.getByRole("button", { name: /^Severity.*Imported from Crm cases/ })).toBeDefined()
    expect(view.queryByRole("button", { name: /^ID/ })).toBeNull()
    view.unmount()

    const loading = renderProperties(null)
    expect(loading.queryByRole("button", { name: /^Status/ })).toBeNull()
    expect(loading.getByText("Status")).toBeDefined()
  })

  test("an edit names its Action, who asked, and the imported value it replaced", async () => {
    const view = renderProperties()
    const panel = await explain(view, /^Status/)

    expect(panel.getByText("Status of SC-1042")).toBeDefined()
    expect(panel.getByText("Acknowledge the case")).toBeDefined()
    expect(panel.getByText("Alice Martin")).toBeDefined()
    expect(panel.getByText("new").closest("del")).not.toBeNull()
    expect(panel.getByRole("link", { name: "Crm cases" }).getAttribute("href")).toBe(
      "/data/projections/crm-cases"
    )
    expect(panel.getByRole("link", { name: "View action run" }).getAttribute("href")).toBe(
      "/observability/runs/actions/run_7"
    )
    expect(panel.queryByText(/you can’t see/)).toBeNull()
  })

  // Removal proof: label an edit without an executor "Direct edit" again and this one claims a
  // request wrote it.
  test("an edit whose commit cannot be told apart says only that it is an edit", async () => {
    const view = renderProperties()
    const panel = await explain(view, /^Owner/)

    expect(panel.getByText("Edit")).toBeDefined()
    expect(panel.getByText("Commit unknown")).toBeDefined()
    expect(panel.queryByText("Direct edit")).toBeNull()
  })

  // Removal proof: drop `onCloseAutoFocus` from ValueLineagePanel and focus is left on the body.
  test("Escape closes the trail and gives focus back to the property", async () => {
    const view = renderProperties()
    await explain(view, /^Status/)

    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    })

    expect(view.queryByRole("dialog")).toBeNull()
    // Radix gives focus back on the next task, after the dialog has unmounted.
    const status = view.getByRole("button", { name: /^Status/ })
    await waitFor(() => expect(document.activeElement).toBe(status))
  })

  // Removal proof: drop the effect that closes the panel in PropertiesPanel and it opens again
  // when the refresh brings the property back.
  test("a refresh that leaves nothing to explain closes the trail for good", async () => {
    const view = renderProperties()
    await explain(view, /^Status/)

    const { status: _status, ...properties } = lineage.properties
    await act(async () => view.refresh({ ...lineage, properties }))
    await act(async () => view.refresh(lineage))

    expect(view.queryByRole("dialog")).toBeNull()
  })

  test("an imported value walks from the projection to the datasets it comes from", async () => {
    const view = renderProperties()
    const panel = await explain(view, /^Severity/)

    expect(panel.getByRole("link", { name: "crm.cases" }).getAttribute("href")).toBe(
      "/data/datasets/crm.cases?version=ducklake%3A84"
    )
    expect(panel.getByText("severity")).toBeDefined()
    expect(panel.getByRole("link", { name: "Cases" }).getAttribute("href")).toBe(
      "/data/pipelines/cases?run=pip_run_3"
    )
    expect(panel.getByText("priority")).toBeDefined()
    expect(panel.queryByText("raw.weather")).toBeNull()
    expect(panel.getByText("No longer stored")).toBeDefined()
    // The farthest version shown expired, so its dataset opens at its latest version.
    expect(panel.getByRole("link", { name: "More upstream" }).getAttribute("href")).toBe(
      "/data/datasets/raw.accounts"
    )
  })

  // Removal proof: link the projection whatever its source carries and this reader is sent to a
  // page it cannot open.
  test("a projection whose runs the reader may not view is named, not linked", async () => {
    const view = renderProperties({
      ...lineage,
      sources: {
        ...lineage.sources,
        "projection:crm-cases": {
          kind: "projection",
          projectionId: "crm-cases",
          datasetVersion: applied,
        },
      },
    })
    const panel = await explain(view, /^Severity/)

    expect(panel.getByText("Crm cases")).toBeDefined()
    expect(panel.queryByRole("link", { name: "Crm cases" })).toBeNull()
    expect(panel.getByText("1 step you can’t see")).toBeDefined()
  })

  test("a source row that outlived an edit says it is newer", async () => {
    const view = renderProperties()
    const panel = await explain(view, /^Title/)

    expect(panel.getByText("Fan noise").closest("del")).not.toBeNull()
    expect(panel.getByText("The source is newer than Alice Martin’s edit")).toBeDefined()
  })
})
