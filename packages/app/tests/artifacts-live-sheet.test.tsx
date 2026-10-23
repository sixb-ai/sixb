import { beforeAll, describe, expect, test } from "bun:test"
import { type GetArtifactQueryResponse, type GetArtifactResponse, SixbApiError } from "@sixb/client"
import { getArtifactQueryKey } from "@sixb/client/hooks"
import { ARTIFACT_LIMITS, parseWorkbook } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { en } from "../src/artifacts/messages"
import { artifactQueryKey } from "../src/artifacts/queries"
import {
  ArtifactReferencesProvider,
  ReferencingMarkdown,
} from "../src/artifacts/references/references"
import { chartData, chartReadsLocked } from "../src/artifacts/renderers/sheet/chart-data"
import { StatusFigures } from "../src/artifacts/renderers/sheet/frame"
import { cellRange, rangeStats } from "../src/artifacts/renderers/sheet/selection"
import { INITIAL_SHEET_VIEW } from "../src/artifacts/renderers/sheet/view"
import { readSheetModel } from "../src/artifacts/renderers/sheet/workbook"
import { workbookXlsx } from "../src/artifacts/renderers/sheet/xlsx"
import { Viewer } from "../src/artifacts/viewer"
import { artifactVersion, seedVersion, textFiles } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])
beforeAll(() => {
  // happy-dom lays nothing out: give the grid a viewport, so it draws every column of the sheet.
  for (const [property, value] of [
    ["clientWidth", 1200],
    ["clientHeight", 800],
  ] as const) {
    Object.defineProperty(browser.HTMLElement.prototype, property, { get: () => value })
  }
})

const OVERDUE = "art_0verdve001"
const REVIEW = "art_rev1ew0001"

const workbook = {
  sheets: [
    {
      name: "Overdue",
      query: "overdue",
      columns: {
        Invoice: { from: "number" },
        Customer: { from: "customer.name" },
        Amount: { from: "amount", type: "currency" },
        Due: { from: "dueDate" },
      },
      totals: { Amount: "sum" },
    },
  ],
  charts: [
    {
      name: "by-customer",
      type: "bar",
      sheet: "Overdue",
      x: "Customer",
      y: "Amount",
      aggregate: "sum",
    },
  ],
}

const texts = {
  "workbook.json": JSON.stringify(workbook),
  "queries/overdue.json": JSON.stringify({ kind: "start", objectTypeId: "Invoice" }),
}

const version = artifactVersion({
  artifactId: OVERDUE,
  title: "Overdue",
  entry: "workbook.json",
  files: textFiles(texts, OVERDUE),
  outline: {
    kind: "sheet",
    sheets: [
      {
        name: "Overdue",
        rows: 0,
        columns: ["Invoice", "Customer", "Amount", "Due"],
        query: "overdue",
      },
    ],
    charts: ["by-customer"],
  },
})

const schema = {
  properties: {
    number: { type: "string" },
    amount: { type: "double" },
    dueDate: { type: "date" },
  },
  links: { customer: { properties: { name: { type: "string" } } } },
} as const

function row(number: string, customer: string, values: Record<string, unknown>) {
  return {
    primaryId: number,
    objectTypeId: "Invoice",
    properties: { number, ...values },
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    links: {
      customer: {
        primaryId: customer,
        objectTypeId: "Customer",
        properties: { name: customer },
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      },
    },
  }
}

/** The rows the signed-in reader reads: Globex's amount is one they are not cleared for. */
function result(
  options: { readonly locked?: boolean; readonly truncated?: boolean } = {}
): GetArtifactQueryResponse {
  const objects = [
    row("inv_1", "Acme", { amount: 1250, dueDate: "2026-09-30" }),
    row("inv_2", "Acme", { amount: 750, dueDate: "2026-10-04" }),
    options.locked
      ? {
          ...row("inv_3", "Globex", { dueDate: "2026-10-12" }),
          redactions: { amount: { reason: "missing_clearance" as const } },
        }
      : row("inv_3", "Globex", { amount: 400, dueDate: "2026-10-12" }),
  ]
  return {
    kind: "objects",
    objects,
    total: objects.length,
    truncated: options.truncated ?? false,
    resultObjectTypeIds: ["Invoice"],
    readObjectTypeIds: ["Invoice", "Customer"],
    schema,
  }
}

/** The artifact read already, its query answered with `answer`: rows, or an error the API gave. */
function cache(answer: GetArtifactQueryResponse | SixbApiError): QueryClient {
  const queries = new QueryClient({
    // An answered error stays as answered: no read on mount reaches the network.
    defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false } },
  })
  seedVersion(queries, version, texts)
  seedVersion(queries, version, texts, { as: "latest" })
  queries.setQueryData(getArtifactQueryKey({ path: { artifactId: OVERDUE } }), {
    artifact: {
      id: OVERDUE,
      projectId: "project",
      kind: "sheet",
      title: "Overdue",
      owner: { type: "user", id: "user-1" },
      latestVersion: 1,
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z",
    },
    versions: [
      {
        version: 1,
        title: "Overdue",
        author: { type: "user", id: "user-1" },
        createdAt: "2026-10-01T12:00:00.000Z",
      },
    ],
    access: "owner",
  } satisfies GetArtifactResponse)

  const key = artifactQueryKey(OVERDUE, 1, "overdue")
  if (answer instanceof SixbApiError) {
    queries.getQueryCache().build(queries, { queryKey: key }).setState({
      status: "error",
      error: answer,
    })
  } else {
    queries.setQueryData(key, answer)
  }
  return queries
}

async function view(queries: QueryClient) {
  const ui = render(
    <QueryClientProvider client={queries}>
      <MemoryRouter>
        <Viewer target={{ type: "artifact", artifactId: OVERDUE }} onTargetChange={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  await act(async () => {})
  return ui
}

const cellText = (container: HTMLElement, row: number, column: number) =>
  container.querySelector(`[role="grid"] [data-row="${row}"][data-column="${column}"]`)?.textContent

const totalsText = (container: HTMLElement) =>
  [
    ...(container.querySelector('[aria-label="Totals"]')?.querySelectorAll('[role="gridcell"]') ??
      []),
  ].map((cell) => cell.textContent)

describe("a live sheet", () => {
  test("shows its query's rows as the sheet formats them, and totals them", async () => {
    const ui = await view(cache(result()))

    expect(cellText(ui.container, 1, 0)).toBe("inv_1")
    expect(cellText(ui.container, 1, 1)).toBe("Acme")
    expect(cellText(ui.container, 1, 2)).toBe("$1,250")
    expect(cellText(ui.container, 1, 3)).toBe("Sep 30, 2026")
    expect(totalsText(ui.container)).toEqual(["Total", "", "$2,400", ""])
    expect(ui.container.textContent).toContain("3 rows")
    ui.unmount()
  })

  // Guard proof: drop the `order.some(...)` check in columnTotals; the total then reads $2,000.
  // Drop the `lockedAt` branch in the grid's cell, and Globex's amount reads as an empty cell.
  test("locks a value the reader may not see, and the total that would read it", async () => {
    const ui = await view(cache(result({ locked: true })))

    const locked = ui.container.querySelector(
      '[role="grid"] [data-row="3"][data-column="2"] [data-locked]'
    )
    expect(locked?.getAttribute("aria-label")).toBe("You can't see this value")
    expect(locked?.getAttribute("title")).toBe("You can't see this value")
    expect(ui.container.querySelectorAll("[role=grid] [data-cell] [data-locked]")).toHaveLength(1)

    const total = ui.container.querySelector('[aria-label="Totals"] [data-locked]')
    expect(total?.getAttribute("aria-label")).toBe("This total reads values you can't see")
    expect(totalsText(ui.container)).toEqual(["Total", "", "", ""])
    ui.unmount()
  })

  test("says when its rows are the first its query returns", async () => {
    const ui = await view(cache(result({ truncated: true })))
    expect(ui.container.textContent).toContain(
      `First ${ARTIFACT_LIMITS.maxQueryRows.toLocaleString("en")} rows`
    )
    ui.unmount()
  })

  // Guard proof: drop the `error ?` notice in WorkbookView; each then reads "This sheet could not
  // be read." as a sheet that failed to load.
  test("says why there are no rows to show, never a sheet of none", async () => {
    const forbidden = await view(
      cache(new SixbApiError("forbidden", { status: 403, body: { error: "[Sixb] Not allowed." } }))
    )
    expect(forbidden.container.textContent).toContain(
      "You don't have access to the data this sheet shows."
    )
    expect(forbidden.container.querySelector('[role="grid"]')).toBeNull()
    forbidden.unmount()

    const invalid = await view(
      cache(
        new SixbApiError("conflict", {
          status: 409,
          body: {
            code: "query_invalid",
            error:
              "[Sixb] Query 'overdue' no longer matches the ontology: $: Unknown object type 'Invoice'.",
          },
        })
      )
    )
    expect(invalid.container.textContent).toContain(
      "This sheet's query no longer matches the project's data"
    )
    expect(invalid.container.textContent).toContain("$: Unknown object type 'Invoice'.")
    invalid.unmount()
  })

  // Guard proof: drop `!live &&` from `available` in viewer.tsx; the header then offers Edit.
  test("is not edited in place", async () => {
    const ui = await view(cache(result()))
    expect(ui.container.querySelector('[role="grid"]')).not.toBeNull()
    const buttons = [...ui.container.querySelectorAll("button")].map((button) => button.textContent)
    expect(buttons).toContain("Filter")
    expect(buttons).not.toContain("Edit")
    ui.unmount()
  })

  test("downloads the reader's rows, a locked value left empty", async () => {
    const queries = cache(result({ locked: true }))
    const parsed = parseWorkbook(texts["workbook.json"])
    if (!("workbook" in parsed) || !parsed.workbook.sheets[0]) throw new Error("No workbook.")

    const model = await readSheetModel(queries, version, parsed.workbook.sheets[0])
    expect(model.rows).toEqual([
      ["inv_1", "Acme", "1250", "2026-09-30"],
      ["inv_2", "Acme", "750", "2026-10-04"],
      ["inv_3", "Globex", "", "2026-10-12"],
    ])

    // The workbook's total over the locked value is left out, not a SUBTOTAL of what remains.
    const xlsx = new TextDecoder().decode(await workbookXlsx([model]))
    expect(xlsx).not.toContain("SUBTOTAL")
  })

  test("charts its rows as the sheet's chart summarizes them", async () => {
    const queries = cache(result())
    const parsed = parseWorkbook(texts["workbook.json"])
    if (!("workbook" in parsed) || !parsed.workbook.sheets[0]) throw new Error("No workbook.")
    const chart = parsed.workbook.charts[0]
    if (!chart) throw new Error("No chart.")

    const model = await readSheetModel(queries, version, parsed.workbook.sheets[0])
    expect(chartData(chart, model)?.rows).toEqual([
      { x: "Acme", s0: 2000 },
      { x: "Globex", s0: 400 },
    ])
  })
})

/** The sheet laid out with Globex's amount locked, and its chart, as the viewer reads them. */
async function lockedModel() {
  const parsed = parseWorkbook(texts["workbook.json"])
  if (!("workbook" in parsed) || !parsed.workbook.sheets[0]) throw new Error("No workbook.")
  const chart = parsed.workbook.charts[0]
  if (!chart) throw new Error("No chart.")

  const model = await readSheetModel(
    cache(result({ locked: true })),
    version,
    parsed.workbook.sheets[0]
  )
  return { model, chart }
}

/** Waits for the lazily loaded chart to draw, or to say it is locked. */
async function settle() {
  for (let attempt = 0; attempt < 5; attempt += 1) await act(async () => {})
}

const CHART_LOCKED = "You can't see some of the values this chart draws."

describe("a live sheet's figures over locked values", () => {
  // Guard proof: return false from chartReadsLocked; the chart beside the grid then draws
  // Globex's bar from nothing, and the message is gone.
  test("show a chart that reads one as locked, in place of the chart", async () => {
    const ui = await view(cache(result({ locked: true })))
    await settle()
    expect(ui.container.querySelector(`[aria-label="${CHART_LOCKED}"]`)).not.toBeNull()
    ui.unmount()

    const open = await view(cache(result()))
    await settle()
    expect(open.container.querySelector(`[aria-label="${CHART_LOCKED}"]`)).toBeNull()
    open.unmount()
  })

  test("leave a chart that counts rows drawn, unless what it counts by is locked", async () => {
    const { model, chart } = await lockedModel()

    expect(chartReadsLocked(chart, model)).toBe(true)
    expect(chartReadsLocked({ ...chart, y: [], aggregate: "count" }, model)).toBe(false)
    expect(chartReadsLocked({ ...chart, x: "Amount", y: [], aggregate: "count" }, model)).toBe(true)
  })

  // Guard proof: drop the `isLocked` branch in rangeStats; the status bar then sums $2,000 as if
  // it were the selection's whole.
  test("show the selection's sum, average, min and max locked over a locked cell", async () => {
    const { model } = await lockedModel()
    const range = cellRange({ row: 1, column: 2 }, { row: 3, column: 2 })
    const stats = rangeStats(range, model, [0, 1, 2])
    expect(stats).toMatchObject({ count: 2, locked: 1 })

    const ui = render(
      <StatusFigures
        model={model}
        status={{ range, stats, column: model.columns[2], value: "", rows: 3 }}
        view={INITIAL_SHEET_VIEW}
        onViewChange={() => {}}
        locale="en-US"
        messages={en}
      />
    )
    const text = ui.container.textContent ?? ""
    expect(text).toContain("Count: 2")
    expect(text).not.toContain("2,000")
    expect(ui.container.querySelectorAll("[data-locked]")).toHaveLength(4)
    expect(ui.container.querySelector("[data-locked]")?.getAttribute("title")).toBe(
      "The selection holds values you can't see"
    )
    ui.unmount()
  })
})

describe("a live sheet shown in a document", () => {
  function documentCache(answer: GetArtifactQueryResponse | SixbApiError) {
    const queries = cache(answer)
    const markdown = `# Review\n\n![Overdue](artifact:${OVERDUE}#Overdue!A1:C4)\n`
    seedVersion(
      queries,
      artifactVersion({
        artifactId: REVIEW,
        title: "Review",
        entry: "document.md",
        files: textFiles({ "document.md": markdown }, REVIEW),
        outline: { kind: "document", headings: [{ depth: 1, text: "Review", slug: "review" }] },
      }),
      { "document.md": markdown },
      { as: "latest" }
    )
    return queries
  }

  async function show(queries: QueryClient, markdown: string) {
    const ui = render(
      <QueryClientProvider client={queries}>
        <ArtifactReferencesProvider open={() => {}}>
          <ReferencingMarkdown>{markdown}</ReferencingMarkdown>
        </ArtifactReferencesProvider>
      </QueryClientProvider>
    )
    await act(async () => {})
    return ui
  }

  test("shows the reader's rows, a value they may not see locked", async () => {
    const ui = await show(
      documentCache(result({ locked: true })),
      `![Overdue](artifact:${OVERDUE}#Overdue!A1:C4)`
    )
    const cells = [...ui.container.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent)
    )
    expect(cells).toEqual([
      ["inv_1", "Acme", "$1,250"],
      ["inv_2", "Acme", "$750"],
      ["inv_3", "Globex", ""],
    ])
    expect(ui.container.querySelector("tbody [data-locked]")?.getAttribute("title")).toBe(
      "You can't see this value"
    )
    ui.unmount()
  })

  // Guard proof: drop the `csv.error` notice in ChartEmbed; it then reads as an artifact that
  // can't be shown.
  test("says why its chart has nothing to show", async () => {
    const ui = await show(
      documentCache(new SixbApiError("forbidden", { status: 403 })),
      `![By customer](artifact:${OVERDUE}#chart=by-customer)`
    )
    expect(ui.container.textContent).toContain(
      "You don't have access to the data this sheet shows."
    )
    ui.unmount()
  })

  // Guard proof: as for the sheet's own chart, return false from chartReadsLocked.
  test("shows its chart locked over a value the reader may not see", async () => {
    const ui = await show(
      documentCache(result({ locked: true })),
      `![By customer](artifact:${OVERDUE}#chart=by-customer)`
    )
    await settle()
    expect(ui.container.textContent).toContain(CHART_LOCKED)
    ui.unmount()
  })
})
