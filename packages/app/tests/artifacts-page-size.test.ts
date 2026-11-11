import { describe, expect, test } from "bun:test"
import {
  fitScale,
  type PageSize,
  sizeSuggestions,
  snapSize,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomStep,
} from "../src/artifacts/renderers/canvas/page-size"
import { pagePlacement, stagePadding } from "../src/artifacts/renderers/canvas/page-zoom"

// An opened board's page as the reader looks at it: the zoom it opens at, the steps it zooms by,
// and the sizes a resize snaps to.

const ROOM = { width: 1392, height: 752 }

describe("an opened board's zoom", () => {
  test("opens a landscape board whole, and a page taller than wide fitted to its width", () => {
    expect(fitScale({ w: 1440, h: 900 }, ROOM, "open")).toBeCloseTo(752 / 900)
    // Reproduce by fitting it whole again: the page opens at a third of its size.
    expect(fitScale({ w: 1200, h: 2140 }, ROOM, "open")).toBe(1)
    // Fit shows the whole page, whatever its shape.
    expect(fitScale({ w: 1200, h: 2140 }, ROOM, "whole")).toBeCloseTo(752 / 2140)
  })

  test("never enlarges a tall page past its own size to fit its width, and shows one nearly whole whole", () => {
    // A long phone page fitted to the room's width would be three times its size. Reproduce by
    // dropping the `Math.max(whole, 1)` bound: it opens at 2.5.
    expect(fitScale({ w: 390, h: 2000 }, ROOM, "open")).toBe(1)
    // At 89% it fits whole, where 100% would scroll a few pixels. Reproduce by dropping the 0.8
    // rule: it opens at 100%, cut off at its foot.
    expect(fitScale({ w: 390, h: 844 }, ROOM, "open")).toBeCloseTo(752 / 844)
  })

  test("zooms in and out a fifth at a time, as far as the canvas does", () => {
    expect(zoomStep(1, "in")).toBeCloseTo(1.2)
    expect(zoomStep(1, "out")).toBeCloseTo(1 / 1.2)
    expect(zoomStep(2.4, "in")).toBe(ZOOM_MAX)
    expect(zoomStep(0.11, "out")).toBe(ZOOM_MIN)
    expect(fitScale({ w: 100, h: 100 }, ROOM, "whole")).toBe(ZOOM_MAX)
  })

  test("keeps the page in the middle while it fits, from the padding once it doesn't, and where a resize holds it", () => {
    const view = { width: 1440, height: 800 }
    const pad = stagePadding(view)
    expect(pagePlacement(view, { width: 400, height: 200 }, pad)).toEqual({
      left: 520,
      top: 300,
      width: 1440,
      height: 800,
    })
    expect(pagePlacement(view, { width: 2000, height: 1000 }, pad)).toEqual({
      left: 24,
      top: 24,
      width: 2048,
      height: 1048,
    })
    expect(pagePlacement(view, { width: 900, height: 200 }, pad, { left: 520, top: 300 })).toEqual({
      left: 520,
      top: 300,
      width: 1444,
      height: 800,
    })
    // On a phone, its foot stays clear of the zoom bar.
    expect(stagePadding({ width: 390, height: 700 })).toEqual({ side: 12, top: 12, bottom: 64 })
  })
})

describe("an opened board's sizes", () => {
  const board: PageSize = { w: 1200, h: 800 }
  const suggestions = sizeSuggestions(board, 2140)
  const right = { w: true, h: false }
  const bottom = { w: false, h: true }
  const corner = { w: true, h: true }

  test("suggests the board's size, the full page once it is measured, and the common screens", () => {
    expect(suggestions.heights).toEqual([
      { name: "board", h: 800 },
      { name: "full", h: 2140 },
    ])
    expect(suggestions.widths.map((each) => each.name)).toEqual([
      "board",
      "phone",
      "tablet",
      "laptop",
      "desktop",
    ])
    expect(sizeSuggestions(board, null).heights).toEqual([{ name: "board", h: 800 }])
    // A screen the board's size already is, is not named twice.
    expect(sizeSuggestions({ w: 390, h: 844 }, null).sizes.map((each) => each.name)).toEqual([
      "board",
      "tablet",
      "desktop",
    ])
  })

  test("snaps an edge to the nearest suggestion within reach, and to the grid otherwise", () => {
    // The board's width is listed first, the laptop's is nearer. Reproduce by taking the first
    // suggestion within reach: it snaps to 1200.
    expect(snapSize({ w: 1250, h: 800 }, right, suggestions, 60)).toMatchObject({
      size: { w: 1280, h: 800 },
      w: { name: "laptop" },
      h: null,
    })
    expect(snapSize({ w: 1100, h: 800 }, right, suggestions, 8)).toEqual({
      size: { w: 1104, h: 800 },
      w: null,
      h: null,
    })
    expect(snapSize({ w: 1200, h: 2133 }, bottom, suggestions, 8)).toMatchObject({
      size: { w: 1200, h: 2140 },
      h: { name: "full" },
    })
  })

  test("snaps the corner to a screen when both edges are near one, else each edge on its own", () => {
    expect(snapSize({ w: 395, h: 840 }, corner, suggestions, 8)).toMatchObject({
      size: { w: 390, h: 844 },
      w: { name: "phone", h: 844 },
    })
    expect(snapSize({ w: 395, h: 2135 }, corner, suggestions, 8)).toMatchObject({
      size: { w: 390, h: 2140 },
      w: { name: "phone" },
      h: { name: "full" },
    })
  })

  test("goes where the pointer is with Alt held, and never below what still reads as a page", () => {
    // Reproduce by ignoring `free`: it snaps to the phone's width.
    expect(snapSize({ w: 393.4, h: 800 }, right, suggestions, 8, true)).toEqual({
      size: { w: 393, h: 800 },
      w: null,
      h: null,
    })
    expect(snapSize({ w: 10, h: 10 }, corner, suggestions, 8).size).toEqual({ w: 240, h: 160 })
    // A board smaller than that still reaches its own size.
    expect(
      snapSize({ w: 10, h: 10 }, corner, sizeSuggestions({ w: 120, h: 90 }, null), 8).size
    ).toEqual({ w: 120, h: 90 })
  })
})
