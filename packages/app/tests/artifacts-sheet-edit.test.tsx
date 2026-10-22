import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { client, type GetArtifactResponse, type GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactQueryKey, getArtifactVersionQueryKey } from "@sixb/client/hooks"
import {
  type CsvTable,
  parseCsv,
  parseWorkbook,
  type SheetColumnFormat,
  type WorkbookSheet,
} from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { useMemo, useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { artifactFileSource } from "../src/artifacts/file-source"
import { recordChange, redoChange, startHistory, undoChange } from "../src/artifacts/history"
import {
  cellEdited,
  deleteColumn,
  deleteRows,
  draftFiles,
  draftModel,
  draftSheet,
  draftTable,
  insertColumn,
  insertRows,
  setCells,
  setColumn,
  sheetRefusal,
  startDraft,
} from "../src/artifacts/renderers/sheet/draft"
import { SheetGrid, type SheetGridEditor } from "../src/artifacts/renderers/sheet/grid"
import { cellInputText, parseCellInput } from "../src/artifacts/renderers/sheet/input"
import { sheetModel } from "../src/artifacts/renderers/sheet/model"
import { parseTsv } from "../src/artifacts/renderers/sheet/selection"
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

  test("reads a pasted value as a sheet copies it: a percent without its sign is a fraction", () => {
    expect(parseCellInput("0.12", { type: "percent" }, "en-US", { pasted: true })).toEqual({
      value: "0.12",
    })
    expect(parseCellInput("12%", { type: "percent" }, "en-US", { pasted: true })).toEqual({
      value: "0.12",
    })
    // A number as a sheet stores it comes first, whatever the locale's marks.
    expect(parseCellInput("1234.5", { type: "number" }, "de-DE", { pasted: true })).toEqual({
      value: "1234.5",
    })
    expect(parseCellInput("1234.5", { type: "number" }, "de-DE")).toEqual({ value: "12345" })
  })

  test("reads the clipboard as a spreadsheet copies: tabs, line breaks, and quoted cells", () => {
    expect(parseTsv('North\t1300\r\n"Cape Town, ""CPT"""\t\r\n"two\nlines"\t9\r\n')).toEqual([
      ["North", "1300"],
      ['Cape Town, "CPT"', ""],
      ["two\nlines", "9"],
    ])
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
    expect(cellEdited(table, 1, 1)).toBe(true)
    expect(cellEdited(table, 1, 0)).toBe(false)
    expect(cellEdited(table, 0, 1)).toBe(false)
    // Editing it back marks nothing.
    const back = setCells(draft, "Regions", TABLE, [{ row: 1, column: 1, value: "1107" }])
    expect(cellEdited(draftTable(back, "Regions", TABLE), 1, 1)).toBe(false)
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

  test("adds and removes rows, and grows to hold what's pasted past its edge", () => {
    const empty = startDraft(workbook)
    const inserted = draftTable(insertRows(empty, "Regions", TABLE, 1, 2), "Regions", TABLE)
    expect(inserted.rows.map((row) => row[0])).toEqual(["North", "", "", "South", "Harbor"])
    // An added row's cells are marked once they hold something.
    expect(cellEdited(inserted, 1, 0)).toBe(false)
    const deleted = draftTable(deleteRows(empty, "Regions", TABLE, [0, 2]), "Regions", TABLE)
    expect(deleted.rows.map((row) => row[0])).toEqual(["South"])
    const grown = draftTable(
      setCells(
        empty,
        "Regions",
        TABLE,
        [
          { row: 3, column: 0, value: "Coastal" },
          { row: 3, column: 5, value: "Rising" },
        ],
        { rows: 1, columns: 1 }
      ),
      "Regions",
      TABLE
    )
    expect(grown.header.at(-1)).toBe("Column 6")
    expect(grown.rows[3]).toEqual(["Coastal", "", "", "", "", "Rising"])
    expect(cellEdited(grown, 3, 0)).toBe(true)
    expect(grown.rows[0]?.length).toBe(6)
  })

  test("undoes and does again each change, across edits, inserts, and deletes", () => {
    // Reproduce by recording only the present: undo has nothing to return to.
    let history = startHistory(startDraft(workbook))
    const apply = (change: (draft: typeof history.present) => typeof history.present) => {
      history = recordChange(history, change(history.present))
    }
    const names = () => draftTable(history.present, "Regions", TABLE).rows.map((row) => row[0])
    apply((draft) =>
      setCells(draft, "Regions", TABLE, [{ row: 0, column: 0, value: "North East" }])
    )
    apply((draft) => insertRows(draft, "Regions", TABLE, 0, 1))
    apply((draft) => deleteRows(draft, "Regions", TABLE, [3]))
    expect(names()).toEqual(["", "North East", "South"])
    history = undoChange(history)
    expect(names()).toEqual(["", "North East", "South", "Harbor"])
    history = undoChange(undoChange(history))
    expect(names()).toEqual(["North", "South", "Harbor"])
    history = redoChange(history)
    expect(names()).toEqual(["North East", "South", "Harbor"])
    // A change after an undo drops what was undone.
    apply((draft) =>
      setCells(draft, "Regions", TABLE, [{ row: 1, column: 0, value: "South West" }])
    )
    expect(redoChange(history)).toBe(history)
    // A change that changes nothing is no step.
    expect(recordChange(history, history.present)).toBe(history)
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
  const [history, setHistory] = useState(() =>
    startHistory(startDraft({ sheets: [SHEET], charts: [] }))
  )
  const draft = history.present
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
      read: (column, text, pasted) =>
        parseCellInput(text, model.columns[column]?.format ?? { type: "text" }, "en-US", {
          pasted: pasted ?? false,
        }),
      write: (edits, grow) => {
        setHistory((last) =>
          recordChange(last, setCells(last.present, "Regions", TABLE, edits, grow))
        )
        return null
      },
      insertRows: (at, count) => {
        setHistory((last) =>
          recordChange(last, insertRows(last.present, "Regions", TABLE, at, count))
        )
        return null
      },
      deleteRows: (rows) =>
        setHistory((last) => recordChange(last, deleteRows(last.present, "Regions", TABLE, rows))),
      insertColumn: (at) =>
        setHistory((last) => recordChange(last, insertColumn(last.present, "Regions", TABLE, at))),
      deleteColumn: () => null,
      editColumn: () => {},
      undo: () => setHistory(undoChange),
      redo: () => setHistory(redoChange),
      edited: (row, column) => cellEdited(table, row, column),
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
  const press = async (
    key: string,
    target: HTMLElement = grid,
    modifiers: { metaKey?: boolean; shiftKey?: boolean } = {}
  ) => {
    await act(async () => {
      fireEvent.keyDown(target, { key, ...modifiers })
    })
  }
  const paste = async (text: string) => {
    await act(async () => {
      fireEvent.paste(grid, { clipboardData: { getData: () => text } })
    })
  }
  const editor = () => view.container.querySelector<HTMLInputElement>('[role="grid"] input')
  return { view, grid, cell, text, select, press, paste, editor }
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

describe("a sheet's columns, as edited", () => {
  const charted = workbookSheet({
    Visits: { type: "number" },
    "Within SLA": { type: "percent" },
    Share: { type: "percent", formula: "[@Visits]/SUM([Visits])" },
  })
  const workbook = {
    sheets: [{ ...charted, widths: { Visits: 140 }, totals: { Visits: "sum" as const } }],
    charts: [
      {
        name: "visits",
        type: "bar" as const,
        sheet: "Regions",
        x: "Region",
        y: ["Visits"],
        line: [],
        stacked: false,
        title: "Visits by region",
      },
    ],
  }
  const read = (value: string, format: SheetColumnFormat) =>
    parseCellInput(value, format, "en-US", { pasted: true })
  const table = parseCsv("Region,Visits,Within SLA,Share\nNorth,1284,0.961,\nSouth,1107,0.918,\n")

  test("renames a column in its width, total, the charts that plot it, and the formulas that read it", () => {
    // Reproduce by renaming the header alone: the chart and the formula name a column gone.
    const draft = setColumn(
      startDraft(workbook),
      "Regions",
      table,
      1,
      { name: "Calls", format: { type: "number" }, total: "sum" },
      read
    )
    if ("refused" in draft) throw new Error(draft.refused)
    const sheet = draftSheet(draft, "Regions")
    expect(draftTable(draft, "Regions", table).header).toEqual([
      "Region",
      "Calls",
      "Within SLA",
      "Share",
    ])
    expect(sheet?.widths).toEqual({ Calls: 140 })
    expect(sheet?.totals).toEqual({ Calls: "sum" })
    expect(sheet?.columns.Share?.formula).toBe("[@Calls]/SUM([Calls])")
    expect(draft.workbook.charts[0]?.y).toEqual(["Calls"])
    // The workbook is saved, as an author writes it, and reads back the same.
    const files = draftFiles(draft)
    const saved = parseWorkbook(files.get("workbook.json") ?? "")
    expect(saved).toEqual({ workbook: draft.workbook })
    expect(files.get("workbook.json")).toContain('"Calls": "number"')
  })

  test("refuses to delete a column a chart plots or a formula reads, naming which", () => {
    expect(deleteColumn(startDraft(workbook), "Regions", table, 1)).toEqual({
      refused: "charted",
      by: "Visits by region",
    })
    const unplotted = { ...workbook, charts: [] }
    expect(deleteColumn(startDraft(unplotted), "Regions", table, 1)).toEqual({
      refused: "computed-from",
      by: "Share",
    })
    const removed = deleteColumn(startDraft(unplotted), "Regions", table, 2)
    if ("refused" in removed) throw new Error(removed.refused)
    expect(draftTable(removed, "Regions", table).header).toEqual(["Region", "Visits", "Share"])
  })

  test("inserts a column without marking the cells it moves along", () => {
    // Reproduce by comparing cells by index: every cell right of the new column reads as changed.
    const inserted = draftTable(
      insertColumn(startDraft(workbook), "Regions", table, 1),
      "Regions",
      table
    )
    expect(inserted.header).toEqual(["Region", "Column 5", "Visits", "Within SLA", "Share"])
    expect([0, 1, 2, 3].map((column) => cellEdited(inserted, 0, column))).toEqual([
      false,
      false,
      false,
      false,
    ])
  })

  test("converts values to a new type, and refuses one they don't fit", () => {
    const words = parseCsv("Region,Visits,Within SLA,Share\nNorth,1284,high,\nSouth,1107,0.918,\n")
    // A percent that becomes a number keeps its values; one that reads as neither is refused.
    const refused = setColumn(
      startDraft(workbook),
      "Regions",
      words,
      2,
      { name: "Within SLA", format: { type: "number" } },
      read
    )
    expect(refused).toEqual({ refused: "values", count: 1 })
    const asText = setColumn(
      startDraft(workbook),
      "Regions",
      table,
      0,
      { name: "Region", format: { type: "date" } },
      read
    )
    expect(asText).toEqual({ refused: "values", count: 2 })
  })

  test("computes a column from a formula, and keeps what it computed when the formula goes", () => {
    const computed = setColumn(
      startDraft(workbook),
      "Regions",
      table,
      2,
      { name: "Within SLA", format: { type: "number", formula: "[@Visits]*2" } },
      read
    )
    if ("refused" in computed) throw new Error(computed.refused)
    expect(draftTable(computed, "Regions", table).rows.map((row) => row[2])).toEqual(["", ""])
    const kept = setColumn(
      computed,
      "Regions",
      table,
      2,
      { name: "Within SLA", format: { type: "number" } },
      read
    )
    if ("refused" in kept) throw new Error(kept.refused)
    expect(draftTable(kept, "Regions", table).rows.map((row) => row[2])).toEqual(["2568", "2214"])
    // A formula that reads a column the sheet lacks, or computes text into a number, is refused.
    expect(
      setColumn(
        startDraft(workbook),
        "Regions",
        table,
        2,
        { name: "Within SLA", format: { type: "number", formula: "[@Region]" } },
        read
      )
    ).toEqual({ refused: "formula-type", computes: "text" })
  })

  test("refuses what publishing would, by its rules: charts, formulas, and a pie's slices", () => {
    // Reproduce by checking only the columns a chart plots in y: the scatter's x turns to text.
    const rooms = parseCsv("Region,Rooms,Revenue\nNorth,120,\nSouth,80,\n")
    const scatter = {
      sheets: [workbookSheet({ Rooms: "number", Revenue: "currency" })],
      charts: [
        {
          name: "rooms",
          type: "scatter" as const,
          sheet: "Regions",
          x: "Rooms",
          y: ["Revenue"],
          line: [],
          stacked: false,
        },
      ],
    }
    expect(
      setColumn(
        startDraft(scatter),
        "Regions",
        rooms,
        1,
        { name: "Rooms", format: { type: "text" } },
        read
      )
    ).toEqual({
      refused: "invalid",
      message: `workbook.json chart 'rooms' plots column 'Rooms', which is text; give it a number, currency, or percent type in "columns".`,
    })

    // A formula that reads the column refuses it too, as publishing computes it.
    const hotels = workbookSheet({
      Rooms: "number",
      Revenue: { type: "currency", formula: "[@Rooms]*1000" },
    })
    const unplotted = setColumn(
      startDraft({ sheets: [hotels], charts: [] }),
      "Regions",
      rooms,
      1,
      { name: "Rooms", format: { type: "text" } },
      read
    )
    expect(unplotted).toEqual({
      refused: "invalid",
      message: `workbook.json sheet 'Regions' column 'Revenue' "formula": '*' needs numbers on both sides, not text.`,
    })

    // A pie of five regions takes no sixth row.
    const pie = {
      sheets: [workbookSheet({ Visits: "number" })],
      charts: [
        {
          name: "share",
          type: "pie" as const,
          sheet: "Regions",
          x: "Region",
          y: ["Visits"],
          line: [],
          stacked: false,
        },
      ],
    }
    const five = parseCsv("Region,Visits\nA,1\nB,2\nC,3\nD,4\nE,5\n")
    expect(sheetRefusal(startDraft(pie), "Regions", five)).toBeNull()
    expect(
      sheetRefusal(insertRows(startDraft(pie), "Regions", five, 5, 1), "Regions", five)
    ).toEqual({
      refused: "invalid",
      message:
        "workbook.json chart 'share' is a pie with 6 slices; a pie reads well with at most 5. Use a bar chart instead.",
    })
  })
})

describe("pasting, filling, and undoing in a sheet", () => {
  test("pastes a block past the last row and column, and grows the sheet to hold it", async () => {
    const ui = mountEditing()
    await ui.select(3, 0)
    // Two rows from Harbor down, three columns: one past the last.
    await ui.paste("Harbor\t900\t95%\r\nCoastal\t448\t0.95\r\n")
    expect(ui.text(3, 1)).toBe("900")
    expect(ui.text(4, 0)).toBe("Coastal")
    expect(ui.text(4, 1)).toBe("448")
    // Typed, 95% is 0.95; pasted bare, 0.95 is the fraction a sheet copies.
    expect(ui.text(4, 2)).toBe("95.0%")
    ui.view.unmount()

    const wide = mountEditing()
    await wide.select(1, 4)
    // The share is computed: what lands on it is left out and counted; the rest grows the sheet.
    await wide.paste("0.5\tnew")
    expect(wide.cell(0, 5).textContent).toContain("Column 6")
    expect(wide.text(1, 5)).toBe("new")
    expect(wide.view.getByRole("status").textContent).toBe(
      "1 value wasn't pasted: it doesn't fit its column."
    )
    wide.view.unmount()
  })

  test("fills the first row down the selection, and undoes and redoes it", async () => {
    const ui = mountEditing()
    await ui.select(1, 1)
    await act(async () => {
      fireEvent.pointerDown(ui.cell(3, 2), { button: 0, shiftKey: true })
    })
    await ui.press("d", ui.grid, { metaKey: true })
    expect([ui.text(2, 1), ui.text(3, 1), ui.text(3, 2)]).toEqual(["1,284", "1,284", "96.1%"])
    await ui.press("z", ui.grid, { metaKey: true })
    expect([ui.text(2, 1), ui.text(3, 2)]).toEqual(["1,107", "93.4%"])
    await ui.press("z", ui.grid, { metaKey: true, shiftKey: true })
    expect(ui.text(2, 1)).toBe("1,284")
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

  test("says why publishing refused a save, in its words", async () => {
    // Reproduce by reading every failure as one: the notice says to try again, and nothing else.
    requests.length = 0
    answer = () =>
      Response.json(
        {
          error: "[Sixb] 'sheets/Regions.csv' has two columns named 'Visits'.",
          code: "invalid_artifact",
        },
        { status: 400 }
      )
    const ui = await editNorth(cache())
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Save as version 2" }))
    })
    await waitFor(() => expect(ui.getByRole("alert")).toBeTruthy())
    expect(ui.getByRole("alert").textContent).toBe(
      "This version can't be published as it is. Undo the change it names, then save.'sheets/Regions.csv' has two columns named 'Visits'."
    )
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

  test("keeps the draft when a version arrives while editing, and says so at once", async () => {
    // Reproduce by following the latest version while editing: the sheet opens version 2 under
    // the draft, North reads 1,284 again, and nothing says why.
    const queries = cache()
    const ui = await editNorth(queries)
    const v1 = queries.getQueryData<GetArtifactVersionResponse>(
      getArtifactVersionQueryKey({ path: { artifactId, version: "1" } })
    ) as GetArtifactVersionResponse
    const detail = queries.getQueryData<GetArtifactResponse>(
      getArtifactQueryKey({ path: { artifactId } })
    ) as GetArtifactResponse

    // The Agent publishes version 2, ready in the cache, and the artifact is read again.
    await act(async () => {
      queries.setQueryData(getArtifactVersionQueryKey({ path: { artifactId, version: "2" } }), {
        ...v1,
        version: 2,
      })
      for (const file of v1.files) {
        const at = (version: number) =>
          artifactFileSource({ artifactId, version, ...file, fileRef: file.file }).queryKey
        queries.setQueryData([...at(2), "text"], queries.getQueryData([...at(1), "text"]))
      }
      queries.setQueryData(getArtifactQueryKey({ path: { artifactId } }), {
        artifact: { ...detail.artifact, latestVersion: 2 },
        versions: [
          {
            version: 2,
            title: "Regions",
            author: { type: "user", id: "user-2" },
            createdAt: "2026-10-01T13:00:00.000Z",
          },
          ...detail.versions,
        ],
      } satisfies GetArtifactResponse)
    })

    // The header counts from version 2 once the viewer has it, with the fix or without.
    await waitFor(() => expect(ui.getByRole("button", { name: "Save as version 3" })).toBeTruthy())

    // The draft is still there, and the reader is told before saving, with the same choices.
    expect(
      ui.container.querySelector('[role="grid"] [data-row="1"][data-column="1"]')?.textContent
    ).toBe("1,300")
    expect(ui.getByText("Unsaved changes")).toBeTruthy()
    expect(ui.getByRole("alert").textContent).toContain(
      "Version 2 was published while you were editing."
    )
    expect(ui.getByRole("button", { name: "Open version 2" })).toBeTruthy()
    expect(ui.getByRole("button", { name: "Save as version 3 anyway" })).toBeTruthy()
    ui.unmount()
  })
})
