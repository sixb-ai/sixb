import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { client, type GetArtifactResponse, type GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactQueryKey, getArtifactVersionQueryKey } from "@sixb/client/hooks"
import { type CsvTable, parseCsv, parseWorkbook, type WorkbookSheet } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { useMemo, useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { artifactFileSource } from "../src/artifacts/file-source"
import {
  cellEdited,
  draftFiles,
  draftModel,
  draftTable,
  setCells,
  startDraft,
} from "../src/artifacts/renderers/sheet/draft"
import { SheetGrid, type SheetGridEditor } from "../src/artifacts/renderers/sheet/grid"
import { cellInputText, parseCellInput } from "../src/artifacts/renderers/sheet/input"
import { sheetModel } from "../src/artifacts/renderers/sheet/model"
import { Viewer } from "../src/artifacts/viewer"
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
  "FocusEvent",
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

function workbookSheet(columns: Record<string, unknown>): WorkbookSheet {
  const parsed = parseWorkbook(JSON.stringify({ sheets: [{ name: "Regions", columns }] }))
  if (!("workbook" in parsed) || !parsed.workbook.sheets[0]) throw new Error("Expected a sheet.")
  return parsed.workbook.sheets[0]
}

const SHEET = workbookSheet({
  Visits: "number",
  "Within SLA": "percent",
  Audited: "boolean",
  Share: { type: "percent", formula: "[@Visits]/SUM([Visits])" },
})
const TABLE: CsvTable = parseCsv(
  "Region,Visits,Within SLA,Audited,Share\nNorth,1284,0.961,true,\nSouth,1107,0.918,false,\nHarbor,962,0.934,false,\n"
)

describe("what a reader types into a cell", () => {
  test.each([
    ["12%", "percent", "en-US", { value: "0.12" }],
    ["12", "percent", "en-US", { value: "0.12" }],
    ["12,5 %", "percent", "fr-FR", { value: "0.125" }],
    ["$1,200", "currency", "en-US", { value: "1200" }],
    ["1 200,50 €", "currency", "fr-FR", { value: "1200.5" }],
    ["(1,200)", "number", "en-US", { value: "-1200" }],
    ["4.5M", "number", "en-US", { value: "4500000" }],
    ["1.2k", "number", "en-US", { value: "1200" }],
    ["abc", "number", "en-US", { error: "number" }],
    ["23/11/2026", "date", "fr-FR", { value: "2026-11-23" }],
    ["11/23/26", "date", "en-US", { value: "2026-11-23" }],
    ["2026-11-23T09:30Z", "date", "en-US", { value: "2026-11-23T09:30Z" }],
    // The 31st of April rolls over in a Date; it is no date.
    ["31/04/2026", "date", "fr-FR", { error: "date" }],
    ["yes", "boolean", "en-US", { value: "true" }],
    ["non", "boolean", "fr-FR", { value: "false" }],
    ["maybe", "boolean", "en-US", { error: "boolean" }],
    ["example.com/pricing", "link", "en-US", { value: "https://example.com/pricing" }],
    ["call me", "link", "en-US", { error: "link" }],
    ["  ", "number", "en-US", { value: "" }],
    ["  Harbor ", "text", "en-US", { value: "  Harbor " }],
  ] as const)("%p in a %s column, in %s", (text, type, locale, expected) => {
    expect(parseCellInput(text, { type }, locale)).toEqual(expected)
  })

  test("reads an image's path against the artifact's files", () => {
    const image = (path: string) => path === "images/north.jpg"
    expect(parseCellInput("images/north.jpg", { type: "image" }, "en-US", { image })).toEqual({
      value: "images/north.jpg",
    })
    expect(parseCellInput("north.jpg", { type: "image" }, "en-US", { image })).toEqual({
      error: "image",
    })
  })

  test("shows a value as it is typed back: the locale's digits, a percent in points", () => {
    expect(cellInputText("0.123", { type: "percent" }, "en-US")).toBe("12.3%")
    expect(cellInputText("0.125", { type: "percent" }, "fr-FR")).toBe("12,5%")
    expect(cellInputText("4120000", { type: "currency" }, "en-US")).toBe("4120000")
    expect(cellInputText("1234.5", { type: "number" }, "fr-FR")).toBe("1234,5")
    expect(cellInputText("Harbor", { type: "text" }, "en-US")).toBe("Harbor")
  })
})

describe("a workbook's draft", () => {
  const workbook = { sheets: [SHEET], charts: [] }

  test("changes only the rows it edits, and knows which cells it changed", () => {
    const draft = setCells(startDraft(workbook), "Regions", TABLE, [
      { row: 1, column: 1, value: "1200" },
    ])
    const table = draftTable(draft, "Regions", TABLE)
    expect(table.rows[1]).toEqual(["South", "1200", "0.918", "false", ""])
    // Rows nobody touched are the version's own.
    expect(table.rows[0]).toBe(TABLE.rows[0] as string[])
    expect(cellEdited(table.rows[1], 1)).toBe(true)
    expect(cellEdited(table.rows[1], 0)).toBe(false)
    expect(cellEdited(table.rows[0], 1)).toBe(false)
    // Editing it back marks nothing.
    const back = setCells(draft, "Regions", TABLE, [{ row: 1, column: 1, value: "1107" }])
    expect(cellEdited(draftTable(back, "Regions", TABLE).rows[1], 1)).toBe(false)
    // A value the cell holds already changes nothing.
    expect(
      setCells(startDraft(workbook), "Regions", TABLE, [{ row: 0, column: 0, value: "North" }])
    ).toEqual(startDraft(workbook))
  })

  test("computes its formulas again, and keeps the columns as wide as the version drew them", () => {
    const base = sheetModel(SHEET, TABLE)
    const draft = setCells(startDraft(workbook), "Regions", TABLE, [
      { row: 0, column: 0, value: "North and the islands, all depots" },
      { row: 0, column: 1, value: "2000" },
    ])
    const model = draftModel(SHEET, draftTable(draft, "Regions", TABLE), base)
    expect(Number(model.rows[0]?.[4])).toBeCloseTo(2000 / (2000 + 1107 + 962), 6)
    expect(model.columns.map((column) => column.width)).toEqual(
      base.columns.map((column) => column.width)
    )
  })

  test("saves the sheets it changed, and no others", () => {
    const other = { ...SHEET, name: "Targets" }
    const draft = setCells(startDraft({ sheets: [SHEET, other], charts: [] }), "Regions", TABLE, [
      { row: 2, column: 1, value: "1000" },
    ])
    expect([...draftFiles(draft)]).toEqual([
      [
        "sheets/Regions.csv",
        "Region,Visits,Within SLA,Audited,Share\r\nNorth,1284,0.961,true,\r\nSouth,1107,0.918,false,\r\nHarbor,1000,0.934,false,\r\n",
      ],
    ])
  })
})

/**
 * Types into the focused input: its value set through the element's own setter, then the key
 * coming up. react-dom reads an input's changes on keyup here, as it does in a page without input
 * events.
 */
function typeInto(input: HTMLElement, value: string) {
  let prototype: object | null = Object.getPrototypeOf(input)
  while (prototype && !Object.getOwnPropertyDescriptor(prototype, "value")) {
    prototype = Object.getPrototypeOf(prototype)
  }
  if (!prototype) throw new Error("Expected an input.")
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value)
  fireEvent.keyUp(input, { key: value.at(-1) ?? "" })
}

/** Sorted by visits, most first: a view the reader set, kept the same as values change. */
const BY_VISITS = {
  sort: { column: 1, direction: "descending" as const },
  filters: {},
  widths: {},
  hidden: [],
  autoFilter: false,
}

/** The grid editing a sheet held in a draft, as the sheet renderer edits one. */
function EditedGrid({ sort }: { readonly sort?: boolean }) {
  const [draft, setDraft] = useState(() => startDraft({ sheets: [SHEET], charts: [] }))
  const base = useMemo(() => sheetModel(SHEET, TABLE), [])
  const table = draftTable(draft, "Regions", TABLE)
  const model = useMemo(
    () => (table === TABLE ? base : draftModel(SHEET, table, base)),
    [table, base]
  )
  const editor = useMemo<SheetGridEditor>(
    () => ({
      editable: (column) => !model.columns[column]?.format.formula,
      inputText: (column, raw) =>
        cellInputText(raw, model.columns[column]?.format ?? { type: "text" }, "en-US"),
      read: (column, text) =>
        parseCellInput(text, model.columns[column]?.format ?? { type: "text" }, "en-US"),
      write: (edits) => setDraft((last) => setCells(last, "Regions", TABLE, edits)),
      edited: (row, column) => cellEdited(table.rows[row], column),
    }),
    [model, table]
  )
  return (
    <SheetGrid
      model={model}
      locale="en-US"
      editor={editor}
      {...(sort ? { view: BY_VISITS } : {})}
    />
  )
}

function mountEditing(options: { sort?: boolean } = {}) {
  const view = render(<EditedGrid {...options} />)
  const grid = view.getByRole("grid")
  const cell = (row: number, column: number) => {
    const element = view.container.querySelector<HTMLElement>(
      `[role="grid"] [data-row="${row}"][data-column="${column}"]`
    )
    if (!element) throw new Error(`No cell at row ${row}, column ${column}`)
    return element
  }
  const text = (row: number, column: number) => cell(row, column).textContent
  const select = async (row: number, column: number) => {
    await act(async () => {
      fireEvent.pointerDown(cell(row, column), { button: 0 })
    })
  }
  const press = async (key: string, target: HTMLElement = grid) => {
    await act(async () => {
      fireEvent.keyDown(target, { key })
    })
  }
  const editor = () => view.container.querySelector<HTMLInputElement>('[role="grid"] input')
  return { view, grid, cell, text, select, press, editor }
}

describe("editing a sheet's cells", () => {
  test("types a value in the reader's terms, stores it raw, and moves down", async () => {
    const ui = mountEditing()
    await ui.select(1, 1)
    // A character typed on a cell starts its value afresh.
    await ui.press("4")
    const input = ui.editor()
    if (!input) throw new Error("Typing opened no editor.")
    expect(input.value).toBe("4")
    await act(async () => typeInto(input, "4.5k"))
    await ui.press("Enter", input)
    expect(ui.editor()).toBeNull()
    expect(ui.text(1, 1)).toBe("4,500")
    // The computed share follows the new value.
    // At as many decimals as the version showed: a column doesn't change its form as it's edited.
    expect(ui.text(1, 4)).toBe(`${((4500 / (4500 + 1107 + 962)) * 100).toFixed(2)}%`)
    // The changed cell is marked; its neighbour isn't.
    expect(ui.cell(1, 1).querySelector(".bg-primary")).not.toBeNull()
    expect(ui.cell(1, 0).querySelector(".bg-primary")).toBeNull()
    // Enter moved to the cell below, which opens with its own value.
    await ui.press("Enter")
    expect(ui.editor()?.value).toBe("1107")
    await ui.press("Escape", ui.editor() as HTMLElement)
    expect(ui.text(2, 1)).toBe("1,107")
    ui.view.unmount()
  })

  test("holds what doesn't fit the column, with why, and stores nothing", async () => {
    const ui = mountEditing()
    await ui.select(1, 2)
    await ui.press("F2")
    const input = ui.editor() as HTMLInputElement
    expect(input.value).toBe("96.1%")
    await act(async () => typeInto(input, "most"))
    await ui.press("Enter", input)
    expect(ui.editor()).not.toBeNull()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Type a number, such as 1,200 or −3.5."
    )
    await ui.press("Escape", input)
    expect(ui.text(1, 2)).toBe("96.1%")
    ui.view.unmount()
  })

  test("clears the selection, toggles checkboxes, and leaves computed cells alone", async () => {
    const ui = mountEditing()
    await ui.select(1, 3)
    // Space turns the unchecked box on.
    await ui.select(2, 3)
    await ui.press(" ")
    expect(ui.cell(2, 3).querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("TRUE")
    // A computed cell opens no editor.
    await ui.select(1, 4)
    await ui.press("Enter")
    expect(ui.editor()).toBeNull()
    await ui.select(3, 0)
    await ui.press("Delete")
    expect(ui.text(3, 0)).toBe("")
    ui.view.unmount()
  })

  test("keeps rows in their places while a sorted sheet's values change", async () => {
    // Reproduce by sorting again on every edit: North, lowered below South, moves down a row.
    const ui = mountEditing({ sort: true })
    expect(ui.text(1, 0)).toBe("North")
    await ui.select(1, 1)
    await ui.press("1")
    const input = ui.editor() as HTMLInputElement
    await act(async () => typeInto(input, "100"))
    await ui.press("Enter", input)
    expect(ui.text(1, 0)).toBe("North")
    expect(ui.text(1, 1)).toBe("100")
    ui.view.unmount()
  })
})

describe("saving an edited sheet", () => {
  const artifactId = "art_s3ll5ab0ok"
  const requests: { url: string; body: unknown }[] = []
  let answer: () => Response = () => new Response(null, { status: 500 })
  const original = client.getConfig()

  beforeAll(() => {
    client.setConfig({
      baseUrl: "http://localhost:3002",
      fetch: Object.assign(
        async (input: Request) => {
          const url = new URL(input.url).pathname
          if (url === "/api/files") {
            const file = (await input.formData()).get("file") as File
            requests.push({ url, body: await file.text() })
            return Response.json(
              {
                blobId: "blob_new",
                digest: `sha256:${"1".repeat(64)}`,
                sizeBytes: file.size,
                mediaType: "text/csv",
              },
              { status: 201 }
            )
          }
          requests.push({ url, body: await input.json() })
          return answer()
        },
        { preconnect: globalThis.fetch.preconnect }
      ) as unknown as typeof fetch,
    })
  })
  afterAll(() => {
    client.setConfig(original)
  })

  function cache(): QueryClient {
    const queries = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
    })
    const texts: Record<string, string> = {
      "workbook.json": JSON.stringify({
        sheets: [{ name: "Regions", columns: { Visits: "number" } }, { name: "Targets" }],
      }),
      "sheets/Regions.csv": "Region,Visits\nNorth,1284\nSouth,1107\n",
      "sheets/Targets.csv": "Region,Target\nNorth,1300\n",
    }
    const files = Object.entries(texts).map(([path, text]) => ({
      path,
      file: {
        blobId: `blob_${path}`,
        digest: `sha256:${"0".repeat(64)}`,
        sizeBytes: text.length,
        mediaType: "text/csv",
      },
    }))
    queries.setQueryData(getArtifactQueryKey({ path: { artifactId } }), {
      artifact: {
        id: artifactId,
        projectId: "project",
        kind: "sheet",
        title: "Regions",
        owner: { type: "user", id: "user-1" },
        latestVersion: 1,
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      },
      versions: [
        {
          version: 1,
          title: "Regions",
          author: { type: "user", id: "user-1" },
          createdAt: "2026-10-01T12:00:00.000Z",
        },
      ],
    } satisfies GetArtifactResponse)
    queries.setQueryData(getArtifactVersionQueryKey({ path: { artifactId, version: "1" } }), {
      artifactId,
      version: 1,
      title: "Regions",
      entry: "workbook.json",
      files,
      outline: { kind: "sheet", sheets: [], charts: [] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-01T12:00:00.000Z",
    } satisfies GetArtifactVersionResponse)
    for (const file of files) {
      const source = artifactFileSource({ artifactId, version: 1, ...file, fileRef: file.file })
      queries.setQueryData([...source.queryKey, "text"], texts[file.path])
    }
    return queries
  }

  async function editNorth(queries: QueryClient) {
    const ui = render(
      <QueryClientProvider client={queries}>
        <MemoryRouter>
          <Viewer target={{ type: "artifact", artifactId }} onTargetChange={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    )
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
    return ui
  }

  test("uploads only the sheet that changed, and publishes from the version edited", async () => {
    requests.length = 0
    answer = () =>
      Response.json(
        { artifact: {}, version: { artifactId, version: 2, files: [] }, warnings: [] },
        { status: 201 }
      )
    const ui = await editNorth(cache())
    const save = ui.getByRole("button", { name: "Save as version 2" })
    await act(async () => {
      fireEvent.click(save)
    })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests).toEqual([
      { url: "/api/files", body: "Region,Visits\r\nNorth,1300\r\nSouth,1107\r\n" },
      {
        url: `/api/artifacts/${artifactId}/versions`,
        body: expect.objectContaining({
          kind: "sheet",
          baseVersion: 1,
          files: expect.arrayContaining([
            expect.objectContaining({
              path: "sheets/Targets.csv",
              file: expect.objectContaining({ blobId: "blob_sheets/Targets.csv" }),
            }),
          ]),
        }),
      },
    ])
    // Saved, the viewer leaves editing.
    expect(ui.queryByRole("button", { name: "Save as version 2" })).toBeNull()
    ui.unmount()
  })

  test("says when the artifact moved on, and saves over it only when asked", async () => {
    requests.length = 0
    answer = () =>
      Response.json(
        {
          error: "moved",
          code: "artifact_moved",
          latest: { version: 2, author: { type: "user", id: "user-2" } },
        },
        { status: 409 }
      )
    const ui = await editNorth(cache())
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Save as version 2" }))
    })
    expect(ui.getByRole("alert").textContent).toContain(
      "Version 2 was published while you were editing."
    )
    // The draft stays: its change is still there to save.
    expect(
      ui.container.querySelector('[role="grid"] [data-row="1"][data-column="1"]')?.textContent
    ).toBe("1,300")
    answer = () =>
      Response.json(
        { artifact: {}, version: { artifactId, version: 3, files: [] }, warnings: [] },
        { status: 201 }
      )
    // The header's Save follows: it saves over version 2 too.
    expect(ui.getByRole("button", { name: "Save as version 3" })).toBeTruthy()
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Save as version 3 anyway" }))
    })
    expect(requests.at(-1)?.body).toMatchObject({ baseVersion: 2 })
    ui.unmount()
  })
})
