import type { CSSProperties } from "react"

const COLUMNS = 96
const ROWS = 24
const BLOCK = 8

// Brand blue, mixed into the page background so the mosaic suits light and dark themes.
const TONES = [8, 18, 38, 68, 100].map(
  (percent) => `color-mix(in oklch, #007aff ${percent}%, var(--background))`
)

interface Cell {
  readonly column: number
  readonly row: number
  readonly size: number
  readonly tone: string
}

/** Blue blocks rising from the bottom edge, highest at the sides; drawn once, the same every time. */
export function Mosaic({ className }: { readonly className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
        aspectRatio: `${COLUMNS} / ${ROWS}`,
        gap: "1px",
      }}
    >
      {CELLS.map((cell) => (
        <span key={`${cell.column}-${cell.row}`} style={cellStyle(cell)} />
      ))}
    </div>
  )
}

function cellStyle(cell: Cell): CSSProperties {
  return {
    gridColumn: `${cell.column + 1} / span ${cell.size}`,
    gridRow: `${cell.row + 1} / span ${cell.size}`,
    background: cell.tone,
  }
}

const CELLS = buildCells()

/**
 * A quadtree over the grid: blocks below the surface stay whole where they are deep, split as they
 * near it, and darken with depth. A seeded hash adds a few extra splits, so the result is fixed.
 */
function buildCells(): Cell[] {
  // Row where the blocks begin in each column: a valley in the middle under the composer.
  const surface = Array.from({ length: COLUMNS }, (_, x) => {
    const valley = Math.exp(-(((x - 47.5) / 21) ** 2))
    return Math.round(4 + 10.5 * valley + 1.4 * Math.sin(x * 0.37) + 0.9 * Math.sin(x * 0.13 + 1.2))
  })
  const cells: Cell[] = []

  const visit = (column: number, row: number, size: number) => {
    let shallowest = Number.POSITIVE_INFINITY
    let deepest = Number.NEGATIVE_INFINITY
    for (let x = column; x < column + size; x++) {
      const top = surface[x] ?? 0
      shallowest = Math.min(shallowest, row - top)
      deepest = Math.max(deepest, row + size - 1 - top)
    }
    if (deepest < 0) return

    const allowed = shallowest >= 9 ? 8 : shallowest >= 5 ? 4 : shallowest >= 2 ? 2 : 1
    if (size > 1 && (shallowest < 0 || size > allowed || noise(column, row, size) < 0.16)) {
      const half = size / 2
      visit(column, row, half)
      visit(column + half, row, half)
      visit(column, row + half, half)
      visit(column + half, row + half, half)
      return
    }
    if (shallowest < 0) return

    const depth = shallowest + (size - 1) / 2
    const tone = depth < 1 ? 0 : depth < 2.5 ? 1 : depth < 5 ? 2 : depth < 9 ? 3 : 4
    cells.push({ column, row, size, tone: TONES[tone] ?? TONES[0] ?? "" })
  }

  for (let row = 0; row < ROWS; row += BLOCK) {
    for (let column = 0; column < COLUMNS; column += BLOCK) visit(column, row, BLOCK)
  }
  return cells
}

function noise(a: number, b: number, c: number): number {
  const n = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453
  return n - Math.floor(n)
}
