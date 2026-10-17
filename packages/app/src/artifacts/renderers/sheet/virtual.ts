// The grid draws only the rows and columns in view. Rows share one height; columns have their
// own widths, so their positions are prefix sums searched by bisection.

/** `offsets[i]` is where item `i` starts; `offsets[n]` is the total. */
export function prefixOffsets(sizes: readonly number[]): number[] {
  const offsets = [0]
  for (const size of sizes) offsets.push((offsets.at(-1) ?? 0) + size)
  return offsets
}

/** The first and last item, by index, that overlap `[from, to)`, widened by `overscan` items. */
export function visibleSpan(
  offsets: readonly number[],
  from: number,
  to: number,
  overscan = 0
): { readonly first: number; readonly last: number } {
  const count = offsets.length - 1
  if (count <= 0) return { first: 0, last: -1 }
  const first = Math.max(0, itemAt(offsets, from) - overscan)
  const last = Math.min(count - 1, itemAt(offsets, Math.max(from, to - 1)) + overscan)
  return { first, last }
}

/** The same window for items of one size, without building offsets for every row. */
export function visibleRowSpan(
  rowHeight: number,
  count: number,
  from: number,
  to: number,
  overscan = 0
): { readonly first: number; readonly last: number } {
  if (count <= 0) return { first: 0, last: -1 }
  const first = Math.max(0, Math.floor(from / rowHeight) - overscan)
  const last = Math.min(count - 1, Math.floor(Math.max(from, to - 1) / rowHeight) + overscan)
  return { first, last }
}

/** The item whose span holds `position`, clamped to the items there are. */
function itemAt(offsets: readonly number[], position: number): number {
  let low = 0
  let high = offsets.length - 2
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((offsets[middle] ?? 0) <= position) low = middle
    else high = middle - 1
  }
  return Math.max(0, low)
}
