import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { parseCsv, parseWorkbook } from "@sixb/core/artifacts"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { Window } from "happy-dom"
import { SheetGrid, type SheetGridStatus } from "../src/artifacts/renderers/sheet/grid"
import { sheetModel } from "../src/artifacts/renderers/sheet/model"
import { rangeLabel } from "../src/artifacts/renderers/sheet/selection"

const browser = new Window({ url: "https://app.sixb.test" })
const globals = [
  "window",
  "self",
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
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()
const copied: string[] = []
beforeAll(() => {
  const values = browser as unknown as Record<string, unknown>
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window" || key === "self"
          ? browser
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : values[key],
    })
  }
  // happy-dom lays nothing out: give the grid a viewport, so it draws every column of the sheet.
  for (const [property, value] of [
    ["clientWidth", 1200],
    ["clientHeight", 800],
  ] as const) {
    Object.defineProperty(browser.HTMLElement.prototype, property, { get: () => value })
  }
  Object.defineProperty(browser.navigator, "clipboard", {
    value: { writeText: async (text: string) => void copied.push(text) },
  })
})
afterEach(() => {
  cleanup()
  copied.length = 0
})
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
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

function mount() {
  const statuses: SheetGridStatus[] = []
  const view = render(
    <SheetGrid model={model} locale="en-US" onStatusChange={(status) => statuses.push(status)} />
  )
  const grid = view.getByRole("grid")
  const cell = (row: number, column: number) => {
    const element = grid.querySelector(`[data-row="${row}"][data-column="${column}"]`)
    if (!element) throw new Error(`No cell at row ${row}, column ${column}`)
    return element
  }
  const status = () => {
    const last = statuses.at(-1)
    if (!last) throw new Error("The grid reported no selection.")
    return { range: rangeLabel(last.range), column: last.column?.name, ...last.stats }
  }
  const press = async (key: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}) => {
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
      count: 3,
      numericCount: 3,
      sum: 13_580_000,
      average: 13_580_000 / 3,
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

  test("sorts by a column's values, then the other way, then back to the sheet's order", async () => {
    const { grid, cell } = mount()
    const quarters = () => [1, 2, 3].map((row) => cell(row, 0).textContent?.trim())
    const sort = grid.querySelector('button[aria-label="Sort by Revenue"]')
    if (!sort) throw new Error("No sort control for Revenue.")

    await act(async () => fireEvent.click(sort))
    expect(quarters()).toEqual(["Q1 2026", "Q4 2025", "Q2 2026"])
    await act(async () => fireEvent.click(sort))
    expect(quarters()).toEqual(["Q2 2026", "Q4 2025", "Q1 2026"])
    await act(async () => fireEvent.click(sort))
    expect(quarters()).toEqual(["Q4 2025", "Q1 2026", "Q2 2026"])
  })
})
