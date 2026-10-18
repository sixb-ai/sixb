import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { GetArtifactResponse, GetArtifactVersionResponse } from "@sixb/client"
import { getArtifactQueryKey, getArtifactVersionQueryKey } from "@sixb/client/hooks"
import { parseCsv, parseWorkbook } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { artifactFileSource } from "../src/artifacts/file-source"
import { SheetGrid, type SheetGridStatus } from "../src/artifacts/renderers/sheet/grid"
import { sheetModel } from "../src/artifacts/renderers/sheet/model"
import { rangeLabel } from "../src/artifacts/renderers/sheet/selection"
import { INITIAL_SHEET_VIEW, type SheetView } from "../src/artifacts/renderers/sheet/view"
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
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])
const copied: string[] = []
/** What the rich clipboard was given, by type, when the test puts a `ClipboardItem` in place. */
const written: Record<string, string>[] = []
class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
}
beforeAll(() => {
  // happy-dom lays nothing out: give the grid a viewport, so it draws every column of the sheet.
  for (const [property, value] of [
    ["clientWidth", 1200],
    ["clientHeight", 800],
  ] as const) {
    Object.defineProperty(browser.HTMLElement.prototype, property, { get: () => value })
  }
  Object.defineProperty(browser.navigator, "clipboard", {
    value: {
      writeText: async (text: string) => void copied.push(text),
      write: async (items: FakeClipboardItem[]) => {
        for (const item of items) {
          const entries = Object.entries(item.items)
          written.push(
            Object.fromEntries(
              await Promise.all(entries.map(async ([type, blob]) => [type, await blob.text()]))
            )
          )
        }
      },
    },
  })
})
afterEach(() => {
  copied.length = 0
  written.length = 0
  Reflect.deleteProperty(globalThis, "ClipboardItem")
})

const parsed = parseWorkbook(
  JSON.stringify({
    sheets: [{ name: "Summary", columns: { Revenue: "currency", Margin: "percent" } }],
  })
)
if (!("workbook" in parsed) || !parsed.workbook.sheets[0]) throw new Error("Expected a workbook.")
const model = sheetModel(
  parsed.workbook.sheets[0],
  parseCsv(
    "Quarter,Revenue,Margin\nQ4 2025,4120000,0.269\nQ1 2026,3900000,0.281\nQ2 2026,5560000,0.3\n"
  )
)

/**
 * Types into the focused input: its value set through the element's own setter, then the key
 * coming up. react-dom is imported before this file installs a window, so it takes the page for
 * one without input events and reads an input's changes on keyup, as it does in such browsers.
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

function mount(sheetView?: SheetView) {
  const statuses: SheetGridStatus[] = []
  const view = render(
    <SheetGrid
      model={model}
      locale="en-US"
      onStatusChange={(status) => statuses.push(status)}
      {...(sheetView ? { view: sheetView } : {})}
    />
  )
  const grid = view.getByRole("grid")
  const cell = (row: number, column: number) => {
    // Column letters sit beside the grid, not in it: they are not cells.
    const element = view.container.querySelector(`[data-row="${row}"][data-column="${column}"]`)
    if (!element) throw new Error(`No cell at row ${row}, column ${column}`)
    return element
  }
  const status = () => {
    const last = statuses.at(-1)
    if (!last) throw new Error("The grid reported no selection.")
    return {
      range: rangeLabel(last.range),
      column: last.column?.name,
      ...last.stats,
      value: last.value,
    }
  }
  const press = async (
    key: string,
    modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}
  ) => {
    await act(async () => {
      fireEvent.keyDown(grid, { key, ...modifiers })
    })
  }
  return { grid, cell, status, press }
}

describe("the sheet grid", () => {
  test("extends a selection with Shift and reports its sum, average, and count", async () => {
    const { status, press } = mount()
    expect(status()).toMatchObject({ range: "A2", column: "Quarter" })

    await press("ArrowRight")
    await press("ArrowDown", { shiftKey: true })
    await press("ArrowDown", { shiftKey: true })
    expect(status()).toEqual({
      range: "B2:B4",
      column: "Revenue",
      value: "$5,560,000",
      count: 3,
      numericCount: 3,
      sum: 13_580_000,
      average: 13_580_000 / 3,
      min: 3_900_000,
      max: 5_560_000,
    })

    await press("Escape")
    expect(status().range).toBe("B4")
    await press("a", { metaKey: true })
    expect(status().range).toBe("A1:C4")
  })

  test("selects by dragging, and by a column's letter", async () => {
    const { cell, status } = mount()
    fireEvent.pointerDown(cell(1, 1), { button: 0 })
    fireEvent.pointerMove(cell(2, 2))
    fireEvent.pointerUp(cell(2, 2))
    expect(status().range).toBe("B2:C3")

    fireEvent.pointerDown(cell(-1, 2), { button: 0 })
    expect(status()).toMatchObject({ range: "C1:C4", numericCount: 3 })
  })

  test("selects rows and columns by their numbers and letters, with Shift, by dragging, and by key", async () => {
    // Reproduce by dropping the Shift branches in onPointerDown, the "rows" mode in
    // onPointerMove, or the Space branch in onKeyDown: each selection below stays one row,
    // one column, or one cell.
    const { cell, status, press } = mount()
    fireEvent.pointerDown(cell(1, -1), { button: 0 })
    fireEvent.pointerUp(cell(1, -1))
    expect(status().range).toBe("A2:C2")
    fireEvent.pointerDown(cell(3, -1), { button: 0, shiftKey: true })
    fireEvent.pointerUp(cell(3, -1))
    expect(status().range).toBe("A2:C4")

    fireEvent.pointerDown(cell(-1, 1), { button: 0 })
    fireEvent.pointerUp(cell(-1, 1))
    fireEvent.pointerDown(cell(-1, 2), { button: 0, shiftKey: true })
    fireEvent.pointerUp(cell(-1, 2))
    expect(status().range).toBe("B1:C4")

    fireEvent.pointerDown(cell(1, -1), { button: 0 })
    fireEvent.pointerMove(cell(2, 1))
    fireEvent.pointerUp(cell(2, 1))
    expect(status().range).toBe("A2:C3")

    fireEvent.pointerDown(cell(2, 1), { button: 0 })
    fireEvent.pointerUp(cell(2, 1))
    await press(" ", { shiftKey: true })
    expect(status().range).toBe("A3:C3")
    fireEvent.pointerDown(cell(2, 1), { button: 0 })
    fireEvent.pointerUp(cell(2, 1))
    await press(" ", { ctrlKey: true })
    expect(status().range).toBe("B1:B4")
    await press(" ", { ctrlKey: true, shiftKey: true })
    expect(status().range).toBe("A1:C4")
  })

  test("reports the active cell's whole value", async () => {
    const { status, press } = mount()
    expect(status().value).toBe("Q4 2025")
    await press("ArrowRight")
    expect(status().value).toBe("$4,120,000")
    await press("ArrowUp")
    expect(status().value).toBe("Revenue")
  })

  test("opens on the range an address named, selected", () => {
    // Reproduce by ignoring `selected` in SheetGrid: the grid opens on A2.
    const statuses: SheetGridStatus[] = []
    render(
      <SheetGrid
        model={model}
        locale="en-US"
        selected={{ top: 1, left: 1, bottom: 2, right: 2 }}
        onStatusChange={(status) => statuses.push(status)}
      />
    )
    const last = statuses.at(-1)
    expect(last ? rangeLabel(last.range) : null).toBe("B2:C3")
    expect(last?.stats.sum).toBeCloseTo(4120000 + 3900000 + 0.269 + 0.281)
  })

  test("copies the selection as tab-separated values", async () => {
    const { press } = mount()
    await press("ArrowDown", { shiftKey: true })
    await press("ArrowRight", { shiftKey: true })
    await press("c", { metaKey: true })
    expect(copied).toEqual(["Q4 2025\t4120000\nQ1 2026\t3900000"])
  })

  test("copies the selection as a table too, where the clipboard takes HTML", async () => {
    // Reproduce by writing only `writeText` in the grid's copy: the clipboard gets no table.
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      writable: true,
      value: FakeClipboardItem,
    })
    const { press } = mount()
    await press("ArrowUp")
    await press("ArrowDown", { shiftKey: true })
    await press("ArrowRight", { shiftKey: true })
    await press("c", { metaKey: true })
    expect(copied).toEqual([])
    expect(written).toEqual([
      {
        "text/plain": "Quarter\tRevenue\nQ4 2025\t4120000",
        "text/html":
          "<table><tr><th>Quarter</th><th>Revenue</th></tr><tr><td>Q4 2025</td><td>$4,120,000</td></tr></table>",
      },
    ])
  })

  test("fits a column to its values when its separator is double-clicked", async () => {
    // Reproduce by double-clicking back to `model.columns[column].width`: the column keeps the
    // 400 pixels the workbook gave it.
    const wide = sheetModel(
      { name: "Wide", frozenRows: 1, frozenColumns: 0, columns: {}, widths: { Quarter: 400 } },
      parseCsv("Quarter\nQ4 2025\n")
    )
    const ui = render(<SheetGrid model={wide} locale="en-US" />)
    const separator = ui.getByRole("separator", { name: "Resize Quarter" })
    expect(separator.getAttribute("aria-valuenow")).toBe("400")
    await act(async () => fireEvent.doubleClick(separator))
    const fitted = Number(separator.getAttribute("aria-valuenow"))
    expect(fitted).toBeLessThan(200)
    expect(fitted).toBeGreaterThanOrEqual(48)
  })

  test("marks what a search finds, selects the current match, and wraps around", async () => {
    // Reproduce by dropping the effect that selects `matches.points[…]`: the selection stays A2.
    const counts: number[] = []
    const statuses: SheetGridStatus[] = []
    const grid = (index: number) => (
      <SheetGrid
        model={model}
        locale="en-US"
        find={{ query: "2026", index }}
        onFind={(found) => counts.push(found.count)}
        onStatusChange={(status) => statuses.push(status)}
      />
    )
    const ui = render(grid(0))
    const selection = () => {
      const last = statuses.at(-1)
      return last ? rangeLabel(last.range) : null
    }
    expect(counts.at(-1)).toBe(2)
    expect(selection()).toBe("A3")
    const marked = Array.from(ui.container.querySelectorAll("[data-matched]"))
    expect(marked.map((cell) => cell.textContent)).toEqual(["Q1 2026", "Q2 2026"])

    ui.rerender(grid(1))
    expect(selection()).toBe("A4")
    ui.rerender(grid(2))
    expect(selection()).toBe("A3")
    ui.rerender(grid(-1))
    expect(selection()).toBe("A4")
  })

  test("tells assistive technology which cell is active, and where each drawn column is", async () => {
    // Reproduce by dropping `aria-activedescendant` from the grid, or `aria-colindex` from
    // GridCell: focus stays on the grid, so nothing else says which cell the arrows reached.
    const { grid, cell, press } = mount()
    expect(grid.getAttribute("aria-colcount")).toBe("4")
    expect(grid.getAttribute("aria-activedescendant")).toBe(cell(1, 0).id)
    await press("ArrowRight")
    await press("ArrowDown")
    expect(grid.getAttribute("aria-activedescendant")).toBe(cell(2, 1).id)
    expect(cell(2, 1).getAttribute("aria-colindex")).toBe("3")
    expect(cell(0, 2).getAttribute("aria-colindex")).toBe("4")
    expect(grid.querySelector('[role="rowheader"]')?.getAttribute("aria-colindex")).toBe("1")
    expect(grid.querySelector('[data-column="-1"][data-row="-1"]')).toBeNull()
  })

  test("resizes the active cell's column from its separator with the arrow keys", async () => {
    // Reproduce by dropping the separator's `tabIndex` or its `onKeyDown`: the keyboard cannot
    // reach it, or it does nothing there.
    const { cell, press } = mount()
    await press("ArrowRight")
    const separators = Array.from(document.querySelectorAll<HTMLElement>('[role="separator"]'))
    expect(separators.map((separator) => separator.tabIndex)).toEqual([-1, 0, -1])
    const separator = separators[1] as HTMLElement
    expect(separator.getAttribute("aria-label")).toBe("Resize Revenue")
    const before = Number(separator.getAttribute("aria-valuenow"))
    await act(async () => {
      fireEvent.keyDown(separator, { key: "ArrowRight" })
    })
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(before + 16)
    expect((cell(1, 1) as HTMLElement).style.width).toBe(`${before + 16}px`)
    await act(async () => {
      fireEvent.keyDown(separator, { key: "Enter" })
    })
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(before)
  })

  test("sorts as the reader's view says, either way, then in the sheet's order", () => {
    const sorted = (sort: SheetView["sort"]) => {
      const ui = render(
        <SheetGrid model={model} locale="en-US" view={{ ...INITIAL_SHEET_VIEW, sort }} />
      )
      const quarters = [1, 2, 3].map((row) =>
        ui.container.querySelector(`[data-row="${row}"][data-column="0"]`)?.textContent?.trim()
      )
      const header = ui.container.querySelector('[data-row="0"][data-column="1"]')
      const result = { quarters, sort: header?.getAttribute("aria-sort") ?? null }
      ui.unmount()
      return result
    }
    expect(sorted({ column: 1, direction: "ascending" })).toEqual({
      quarters: ["Q1 2026", "Q4 2025", "Q2 2026"],
      sort: "ascending",
    })
    expect(sorted({ column: 1, direction: "descending" })).toEqual({
      quarters: ["Q2 2026", "Q4 2025", "Q1 2026"],
      sort: "descending",
    })
    expect(sorted(null)).toEqual({ quarters: ["Q4 2025", "Q1 2026", "Q2 2026"], sort: null })
  })

  test("leaves a hidden column out of the layout, the arrows, the sums, and a copy", async () => {
    // Reproduce by dropping `hidden` from rangeStats or rangeTsv, or the `visibleColumn` step in
    // onKeyDown: the hidden Revenue still sums, copies, or takes the active cell.
    const { grid, status, press } = mount({ ...INITIAL_SHEET_VIEW, hidden: [1] })
    expect(grid.querySelector('[data-column="1"]')).toBeNull()
    expect(document.querySelector('[data-row="-1"][data-column="1"]')).toBeNull()

    await press("ArrowRight")
    expect(status()).toMatchObject({ range: "C2", column: "Margin" })
    await press("ArrowLeft", { shiftKey: true })
    expect(status()).toMatchObject({ range: "A2:C2", count: 2, numericCount: 1, sum: 0.269 })
    await press("c", { metaKey: true })
    expect(copied).toEqual(["Q4 2025\t0.269"])
  })

  test("freezes the columns the reader froze", () => {
    const { cell } = mount({ ...INITIAL_SHEET_VIEW, frozenColumns: 2 })
    expect(cell(1, 0).className).toContain("sticky")
    expect(cell(1, 1).className).toContain("sticky")
    expect(cell(1, 2).className).not.toContain("sticky")
  })

  test("leaves the keys pressed on a column's menu to the menu", async () => {
    // Reproduce by dropping the target check at the top of onKeyDown: ArrowDown on the menu's
    // button also moves the active cell to A3.
    const { status } = mount()
    const trigger = document.querySelector('button[aria-label="Revenue column options"]')
    if (!trigger) throw new Error("No menu for Revenue.")
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" })
    })
    expect(status().range).toBe("A2")
  })
})

const NUMBERS = "art_numbers001"
const VISITS = "art_v1s1ts0001"

/**
 * Sheet artifacts, version 1 of each, read already: the same sheet names in each, so the same
 * renderer shows either.
 */
function sheetCache(): QueryClient {
  const cache = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  const seed = (artifactId: string, csv: Record<string, string>) => {
    const texts: Record<string, string> = {
      "workbook.json": JSON.stringify({
        sheets: Object.keys(csv).map((name) => ({ name })),
      }),
      ...Object.fromEntries(
        Object.entries(csv).map(([name, text]) => [`sheets/${name}.csv`, text])
      ),
    }
    const files = Object.entries(texts).map(([path, text]) => ({
      path,
      file: {
        blobId: `${artifactId}/${path}`,
        digest: `sha256:${"0".repeat(64)}`,
        sizeBytes: text.length,
        mediaType: path.endsWith(".csv") ? "text/csv" : "application/json",
      },
    }))
    cache.setQueryData(getArtifactQueryKey({ path: { artifactId } }), {
      artifact: {
        id: artifactId,
        projectId: "project",
        kind: "sheet",
        title: artifactId,
        owner: { type: "user", id: "user-1" },
        latestVersion: 1,
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      },
      versions: [
        {
          version: 1,
          title: artifactId,
          author: { type: "user", id: "user-1" },
          createdAt: "2026-10-01T12:00:00.000Z",
        },
      ],
    } satisfies GetArtifactResponse)
    cache.setQueryData(getArtifactVersionQueryKey({ path: { artifactId, version: "1" } }), {
      artifactId,
      version: 1,
      title: artifactId,
      entry: "workbook.json",
      files,
      outline: { kind: "sheet", sheets: [], charts: [] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-01T12:00:00.000Z",
    } satisfies GetArtifactVersionResponse)
    for (const file of files) {
      const source = artifactFileSource({ artifactId, version: 1, ...file, fileRef: file.file })
      cache.setQueryData([...source.queryKey, "text"], texts[file.path])
    }
  }
  seed(NUMBERS, {
    Summary: "Quarter,Revenue\nQ3 2026,5560000\n",
    Regions: "Region,Visits\nNorth,1284\n",
  })
  seed(VISITS, {
    Summary: "Region,Visits,Within SLA\nNorth,1284,0.961\n",
    Regions: "Region\nSouth\n",
  })
  return cache
}

function ArtifactViewer({ cache, artifactId }: { cache: QueryClient; artifactId: string }) {
  return (
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <Viewer target={{ type: "artifact", artifactId }} onTargetChange={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("a sheet artifact", () => {
  const selectedTab = () =>
    Array.from(document.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.getAttribute("aria-selected") === "true"
    )

  test("moves along its tabs with the arrow keys, and shows the one it reaches in the panel", async () => {
    // Reproduce by dropping the tablist's `onKeyDown` in WorkbookView: ArrowRight leaves Summary
    // selected, and the tab order holds every tab.
    const ui = render(<ArtifactViewer cache={sheetCache()} artifactId={NUMBERS} />)
    const tabs = () => ui.getAllByRole("tab")
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1])
    const press = async (key: string) => {
      await act(async () => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key })
      })
    }
    tabs()[0]?.focus()
    await press("ArrowRight")
    expect(selectedTab()?.textContent).toBe("Regions")
    // Compared, not matched: a failed match prints the whole page.
    expect(document.activeElement === selectedTab()).toBe(true)
    const panel = ui.getByRole("tabpanel")
    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTab()?.id ?? "")
    expect(selectedTab()?.getAttribute("aria-controls")).toBe(panel.id)
    expect(panel.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe("Sheet Regions")
    await press("ArrowRight")
    expect(selectedTab()?.textContent).toBe("Summary")
    await press("End")
    expect(selectedTab()?.textContent).toBe("Regions")
    await press("Home")
    expect(selectedTab()?.textContent).toBe("Summary")
  })

  test("shows the active cell's whole value above the grid", async () => {
    // Reproduce by dropping `status?.value` from NameBox: the bar shows only the address.
    const ui = render(<ArtifactViewer cache={sheetCache()} artifactId={NUMBERS} />)
    const value = () => ui.container.querySelector("[data-sheet-value]")?.textContent
    expect(value()).toBe("Q3 2026")
    await act(async () => {
      fireEvent.keyDown(ui.getByRole("grid"), { key: "ArrowRight" })
    })
    // The seeded workbook types no column, so Revenue reads as text.
    expect(value()).toBe("5560000")
  })

  test("opens find with Cmd+F inside the sheet, and leaves the browser's find alone outside it", async () => {
    // Reproduce by dropping `onKeyDown` from WorkbookView's root: Cmd+F in the grid opens nothing.
    const ui = render(<ArtifactViewer cache={sheetCache()} artifactId={NUMBERS} />)
    const outside = new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true })
    document.body.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(false)
    expect(ui.queryByRole("search")).toBeNull()

    await act(async () => {
      fireEvent.keyDown(ui.getByRole("grid"), { key: "f", metaKey: true })
      await Bun.sleep(20)
    })
    const input = ui.getByRole("searchbox", { name: "Find in sheet" })
    expect(document.activeElement === input).toBe(true)
    await act(async () => {
      typeInto(input, "q3")
    })
    expect(ui.getByRole("search").textContent).toContain("1 of 1")
    await act(async () => {
      typeInto(input, "nothing like it")
    })
    expect(ui.getByRole("search").textContent).toContain("No matches")

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" })
    })
    expect(ui.queryByRole("search")).toBeNull()
    expect(document.activeElement === ui.getByRole("grid")).toBe(true)
  })

  test("keeps each sheet's columns as the reader left them across its tabs", async () => {
    // Reproduce by not passing `view` to SheetGrid in WorkbookView: Summary's widened column is
    // back to its first width when the reader returns to it.
    const ui = render(<ArtifactViewer cache={sheetCache()} artifactId={NUMBERS} />)
    const width = () =>
      Number(ui.getByRole("separator", { name: "Resize Quarter" }).getAttribute("aria-valuenow"))
    const first = width()
    await act(async () => {
      fireEvent.keyDown(ui.getByRole("separator", { name: "Resize Quarter" }), {
        key: "ArrowRight",
      })
    })
    expect(width()).toBe(first + 16)

    await act(async () => fireEvent.click(ui.getByRole("tab", { name: "Regions" })))
    await act(async () => fireEvent.click(ui.getByRole("tab", { name: "Summary" })))
    expect(width()).toBe(first + 16)
  })

  test("starts afresh on another artifact, though the same renderer shows it", async () => {
    // Reproduce by dropping the `key` on ArtifactBody in ArtifactView: the second artifact opens
    // on the tab chosen in the first, as the panel's Back or a revisited version did.
    const cache = sheetCache()
    const ui = render(<ArtifactViewer cache={cache} artifactId={NUMBERS} />)
    await act(async () => {
      fireEvent.click(ui.getByRole("tab", { name: "Regions" }))
    })
    expect(selectedTab()?.textContent).toBe("Regions")

    ui.rerender(<ArtifactViewer cache={cache} artifactId={VISITS} />)
    expect(selectedTab()?.textContent).toBe("Summary")
    // Its third column, which the first artifact's sheet does not have, gets its own width.
    const third = ui.container.querySelector<HTMLElement>('[data-row="0"][data-column="2"]')
    expect(third?.textContent).toContain("Within SLA")
    expect(Number.parseFloat(third?.style.width ?? "0")).toBeGreaterThan(0)
  })
})
