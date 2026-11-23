// Editing a table as a grid: cells selected together by a drag across them, Shift and an arrow,
// or a triple click, and drawn with a `selectedCell` class; arrows that leave a cell for the next;
// selected cells emptied by Backspace, copied as a table, and cells pasted into a table where
// they fall. A table left ragged by a change is mended. As prosemirror-tables (MIT) does it, with
// Tiptap's table keys (MIT): Backspace with every cell selected deletes the table.

import type { EditorPlugin } from "./editor"
import { keydownHandler } from "./keymap"
import {
  type Attrs,
  Fragment,
  type Node,
  type NodeType,
  type ResolvedPos,
  type Schema,
  Slice,
} from "./model"
import {
  type EditorState,
  NodeSelection,
  Selection,
  type SelectionRange,
  TextSelection,
  type Transaction,
} from "./state"
import { type Mappable, Transform } from "./transform"
import type { Decoration, EditorView } from "./view"

// ── The table's grid ────────────────────────────────────────────────

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

type Problem =
  | { readonly type: "collision"; readonly row: number; readonly pos: number; readonly n: number }
  | { readonly type: "missing"; readonly row: number; readonly n: number }
  | { readonly type: "overlong_rowspan"; readonly pos: number; readonly n: number }
  | { readonly type: "colwidth mismatch"; readonly pos: number; readonly colwidth: number[] }
  | { readonly type: "zero_sized" }

const maps = new WeakMap<Node, TableMap>()

/**
 * Where each cell of a table is in its grid: `map` holds, row after row, the position of the
 * cell covering each slot, relative to the table's start.
 */
export class TableMap {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly map: number[],
    public problems: Problem[] | null
  ) {}

  findCell(pos: number): Rect {
    for (let index = 0; index < this.map.length; index += 1) {
      if (this.map[index] !== pos) continue
      const left = index % this.width
      const top = (index / this.width) | 0
      let right = left + 1
      let bottom = top + 1
      for (let j = 1; right < this.width && this.map[index + j] === pos; j += 1) right += 1
      for (let j = 1; bottom < this.height && this.map[index + this.width * j] === pos; j += 1)
        bottom += 1
      return { left, top, right, bottom }
    }
    throw new RangeError(`[SixbEditor] No cell with offset ${pos} found.`)
  }

  colCount(pos: number): number {
    for (let index = 0; index < this.map.length; index += 1)
      if (this.map[index] === pos) return index % this.width
    throw new RangeError(`[SixbEditor] No cell with offset ${pos} found.`)
  }

  nextCell(pos: number, axis: "horiz" | "vert", dir: number): number | null {
    const { left, right, top, bottom } = this.findCell(pos)
    if (axis === "horiz") {
      if (dir < 0 ? left === 0 : right === this.width) return null
      return this.map[top * this.width + (dir < 0 ? left - 1 : right)] as number
    }
    if (dir < 0 ? top === 0 : bottom === this.height) return null
    return this.map[left + this.width * (dir < 0 ? top - 1 : bottom)] as number
  }

  rectBetween(a: number, b: number): Rect {
    const one = this.findCell(a)
    const two = this.findCell(b)
    return {
      left: Math.min(one.left, two.left),
      top: Math.min(one.top, two.top),
      right: Math.max(one.right, two.right),
      bottom: Math.max(one.bottom, two.bottom),
    }
  }

  cellsInRect(rect: Rect): number[] {
    const result: number[] = []
    const seen = new Set<number>()
    for (let row = rect.top; row < rect.bottom; row += 1) {
      for (let col = rect.left; col < rect.right; col += 1) {
        const index = row * this.width + col
        const pos = this.map[index] as number
        if (seen.has(pos)) continue
        seen.add(pos)
        if (
          (col === rect.left && col && this.map[index - 1] === pos) ||
          (row === rect.top && row && this.map[index - this.width] === pos)
        )
          continue
        result.push(pos)
      }
    }
    return result
  }

  positionAt(row: number, col: number, table: Node): number {
    for (let index = 0, rowStart = 0; ; index += 1) {
      const rowEnd = rowStart + table.child(index).nodeSize
      if (index === row) {
        let at = col + row * this.width
        const rowEndIndex = (row + 1) * this.width
        while (at < rowEndIndex && (this.map[at] as number) < rowStart) at += 1
        return at === rowEndIndex ? rowEnd - 1 : (this.map[at] as number)
      }
      rowStart = rowEnd
    }
  }

  static get(table: Node): TableMap {
    let found = maps.get(table)
    if (!found) {
      found = computeMap(table)
      maps.set(table, found)
    }
    return found
  }
}

function computeMap(table: Node): TableMap {
  if (table.type.spec.tableRole !== "table")
    throw new RangeError(`[SixbEditor] Not a table node: ${table.type.name}`)
  const width = findWidth(table)
  const height = table.childCount
  const map: number[] = new Array(width * height).fill(0)
  let mapPos = 0
  let problems: Problem[] | null = null
  const colWidths: number[] = []
  for (let row = 0, pos = 0; row < height; row += 1) {
    const rowNode = table.child(row)
    pos += 1
    for (let index = 0; ; index += 1) {
      while (mapPos < map.length && map[mapPos] !== 0) mapPos += 1
      if (index === rowNode.childCount) break
      const cellNode = rowNode.child(index)
      const { colspan, rowspan, colwidth } = cellNode.attrs as {
        colspan: number
        rowspan: number
        colwidth: number[] | null
      }
      for (let h = 0; h < rowspan; h += 1) {
        if (h + row >= height) {
          problems ??= []
          problems.push({ type: "overlong_rowspan", pos, n: rowspan - h })
          break
        }
        const start = mapPos + h * width
        for (let w = 0; w < colspan; w += 1) {
          if (map[start + w] === 0) map[start + w] = pos
          else {
            problems ??= []
            problems.push({ type: "collision", row, pos, n: colspan - w })
          }
          const colW = colwidth?.[w]
          if (colW) {
            const widthIndex = ((start + w) % width) * 2
            const previous = colWidths[widthIndex]
            if (previous == null || (previous !== colW && colWidths[widthIndex + 1] === 1)) {
              colWidths[widthIndex] = colW
              colWidths[widthIndex + 1] = 1
            } else if (previous === colW) {
              colWidths[widthIndex + 1] = (colWidths[widthIndex + 1] as number) + 1
            }
          }
        }
      }
      mapPos += colspan
      pos += cellNode.nodeSize
    }
    const expectedPos = (row + 1) * width
    let missing = 0
    while (mapPos < expectedPos) if (map[mapPos++] === 0) missing += 1
    if (missing) {
      problems ??= []
      problems.push({ type: "missing", row, n: missing })
    }
    pos += 1
  }
  if (width === 0 || height === 0) {
    problems ??= []
    problems.push({ type: "zero_sized" })
  }
  const tableMap = new TableMap(width, height, map, problems)
  let badWidths = false
  for (let index = 0; !badWidths && index < colWidths.length; index += 2) {
    if (colWidths[index] != null && (colWidths[index + 1] as number) < height) badWidths = true
  }
  if (badWidths) findBadColWidths(tableMap, colWidths, table)
  return tableMap
}

function findWidth(table: Node): number {
  let width = -1
  let hasRowSpan = false
  for (let row = 0; row < table.childCount; row += 1) {
    const rowNode = table.child(row)
    let rowWidth = 0
    if (hasRowSpan) {
      for (let j = 0; j < row; j += 1) {
        const previousRow = table.child(j)
        for (let index = 0; index < previousRow.childCount; index += 1) {
          const cell = previousRow.child(index)
          if (j + (cell.attrs.rowspan as number) > row) rowWidth += cell.attrs.colspan as number
        }
      }
    }
    for (let index = 0; index < rowNode.childCount; index += 1) {
      const cell = rowNode.child(index)
      rowWidth += cell.attrs.colspan as number
      if ((cell.attrs.rowspan as number) > 1) hasRowSpan = true
    }
    if (width === -1) width = rowWidth
    else if (width !== rowWidth) width = Math.max(width, rowWidth)
  }
  return width
}

function findBadColWidths(map: TableMap, colWidths: number[], table: Node): void {
  map.problems ??= []
  const seen = new Set<number>()
  for (let index = 0; index < map.map.length; index += 1) {
    const pos = map.map[index] as number
    if (seen.has(pos)) continue
    seen.add(pos)
    const node = table.nodeAt(pos)
    if (!node) throw new RangeError(`[SixbEditor] No cell with offset ${pos} found.`)
    let updated: number[] | null = null
    const attrs = node.attrs as { colspan: number; colwidth: number[] | null }
    for (let j = 0; j < attrs.colspan; j += 1) {
      const colWidth = colWidths[((index + j) % map.width) * 2]
      if (colWidth != null && (!attrs.colwidth || attrs.colwidth[j] !== colWidth)) {
        updated ??= attrs.colwidth ? attrs.colwidth.slice() : new Array(attrs.colspan).fill(0)
        updated[j] = colWidth
      }
    }
    if (updated) map.problems.unshift({ type: "colwidth mismatch", pos, colwidth: updated })
  }
}

// ── Finding cells ───────────────────────────────────────────────────

function isCell(type: NodeType): boolean {
  const role = type.spec.tableRole
  return role === "cell" || role === "header_cell"
}

/** The table's node types, by their roles. */
function tableNodeTypes(schema: Schema): Record<string, NodeType> {
  const types: Record<string, NodeType> = {}
  for (const type of Object.values(schema.nodes))
    if (type.spec.tableRole) types[type.spec.tableRole] = type
  return types
}

/** The position before the cell `$pos` is in, resolved, or null outside a table. */
export function cellAround($pos: ResolvedPos): ResolvedPos | null {
  for (let depth = $pos.depth - 1; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.spec.tableRole === "row")
      return $pos.node(0).resolve($pos.before(depth + 1))
  }
  return null
}

export function isInTable(state: { readonly selection: Selection }): boolean {
  const $head = state.selection.$head
  for (let depth = $head.depth; depth > 0; depth -= 1)
    if ($head.node(depth).type.spec.tableRole === "row") return true
  return false
}

function selectionCell(state: { readonly selection: Selection }): ResolvedPos {
  const selection = state.selection
  if (selection instanceof CellSelection)
    return selection.$anchorCell.pos > selection.$headCell.pos
      ? selection.$anchorCell
      : selection.$headCell
  if (selection instanceof NodeSelection && selection.node.type.spec.tableRole === "cell")
    return selection.$anchor
  const $cell = cellAround(selection.$head) ?? cellNear(selection.$head)
  if ($cell) return $cell
  throw new RangeError(`[SixbEditor] No cell found around position ${selection.head}.`)
}

function cellNear($pos: ResolvedPos): ResolvedPos | null {
  for (let after = $pos.nodeAfter, pos = $pos.pos; after; after = after.firstChild, pos += 1) {
    if (isCell(after.type)) return $pos.doc.resolve(pos)
  }
  for (let before = $pos.nodeBefore, pos = $pos.pos; before; before = before.lastChild, pos -= 1) {
    if (isCell(before.type)) return $pos.doc.resolve(pos - before.nodeSize)
  }
  return null
}

function pointsAtCell($pos: ResolvedPos): boolean {
  return $pos.parent.type.spec.tableRole === "row" && !!$pos.nodeAfter
}

function inSameTable($a: ResolvedPos, $b: ResolvedPos): boolean {
  return $a.depth === $b.depth && $a.pos >= $b.start(-1) && $a.pos <= $b.end(-1)
}

function nextCell($pos: ResolvedPos, axis: "horiz" | "vert", dir: number): ResolvedPos | null {
  const table = $pos.node(-1)
  const tableStart = $pos.start(-1)
  const moved = TableMap.get(table).nextCell($pos.pos - tableStart, axis, dir)
  return moved == null ? null : $pos.node(0).resolve(tableStart + moved)
}

function removeColSpan(attrs: Attrs, pos: number, n = 1): Attrs {
  const result: Record<string, unknown> = { ...attrs, colspan: (attrs.colspan as number) - n }
  if (result.colwidth) {
    const widths = (result.colwidth as number[]).slice()
    widths.splice(pos, n)
    result.colwidth = widths.some((width) => width > 0) ? widths : null
  }
  return result
}

// ── Selected cells ──────────────────────────────────────────────────

/** Cells selected together, from the cell `$anchorCell` points at to the one `$headCell` does. */
export class CellSelection extends Selection {
  private readonly cellRanges: readonly SelectionRange[]

  constructor(
    readonly $anchorCell: ResolvedPos,
    readonly $headCell: ResolvedPos = $anchorCell
  ) {
    const table = $anchorCell.node(-1)
    const map = TableMap.get(table)
    const tableStart = $anchorCell.start(-1)
    const rect = map.rectBetween($anchorCell.pos - tableStart, $headCell.pos - tableStart)
    const doc = $anchorCell.node(0)
    const cells = map.cellsInRect(rect).filter((pos) => pos !== $headCell.pos - tableStart)
    cells.unshift($headCell.pos - tableStart)
    const ranges = cells.map((pos) => {
      const cell = table.nodeAt(pos)
      if (!cell) throw new RangeError(`[SixbEditor] No cell with offset ${pos} found.`)
      const from = tableStart + pos + 1
      return { $from: doc.resolve(from), $to: doc.resolve(from + cell.content.size) }
    })
    const first = ranges[0] as SelectionRange
    super(first.$from, first.$to)
    this.cellRanges = ranges
  }

  override get ranges(): readonly SelectionRange[] {
    return this.cellRanges
  }

  map(doc: Node, mapping: Mappable): Selection {
    const $anchorCell = doc.resolve(mapping.map(this.$anchorCell.pos))
    const $headCell = doc.resolve(mapping.map(this.$headCell.pos))
    if (
      pointsAtCell($anchorCell) &&
      pointsAtCell($headCell) &&
      inSameTable($anchorCell, $headCell)
    ) {
      const tableChanged = this.$anchorCell.node(-1) !== $anchorCell.node(-1)
      if (tableChanged && this.isRowSelection())
        return CellSelection.rowSelection($anchorCell, $headCell)
      if (tableChanged && this.isColSelection())
        return CellSelection.colSelection($anchorCell, $headCell)
      return new CellSelection($anchorCell, $headCell)
    }
    return TextSelection.between($anchorCell, $headCell)
  }

  override content(): Slice {
    const table = this.$anchorCell.node(-1)
    const map = TableMap.get(table)
    const tableStart = this.$anchorCell.start(-1)
    const rect = map.rectBetween(this.$anchorCell.pos - tableStart, this.$headCell.pos - tableStart)
    const seen = new Set<number>()
    const rows: Node[] = []
    for (let row = rect.top; row < rect.bottom; row += 1) {
      const rowContent: Node[] = []
      for (
        let index = row * map.width + rect.left, col = rect.left;
        col < rect.right;
        col += 1, index += 1
      ) {
        const pos = map.map[index] as number
        if (seen.has(pos)) continue
        seen.add(pos)
        const cellRect = map.findCell(pos)
        let cell = table.nodeAt(pos)
        if (!cell) throw new RangeError(`[SixbEditor] No cell with offset ${pos} found.`)
        const extraLeft = rect.left - cellRect.left
        const extraRight = cellRect.right - rect.right
        if (extraLeft > 0 || extraRight > 0) {
          let attrs = cell.attrs
          if (extraLeft > 0) attrs = removeColSpan(attrs, 0, extraLeft)
          if (extraRight > 0)
            attrs = removeColSpan(attrs, (attrs.colspan as number) - extraRight, extraRight)
          if (cellRect.left < rect.left) {
            const made = cell.type.createAndFill(attrs)
            if (!made)
              throw new RangeError(
                `[SixbEditor] Could not create a cell with ${JSON.stringify(attrs)}.`
              )
            cell = made
          } else {
            cell = cell.type.create(attrs, cell.content)
          }
        }
        if (cellRect.top < rect.top || cellRect.bottom > rect.bottom) {
          const attrs = {
            ...cell.attrs,
            rowspan: Math.min(cellRect.bottom, rect.bottom) - Math.max(cellRect.top, rect.top),
          }
          cell =
            cellRect.top < rect.top
              ? (cell.type.createAndFill(attrs) as Node)
              : cell.type.create(attrs, cell.content)
        }
        rowContent.push(cell)
      }
      rows.push(table.child(row).copy(Fragment.from(rowContent)))
    }
    const fragment =
      this.isColSelection() && this.isRowSelection()
        ? Fragment.from(table)
        : Fragment.fromArray(rows)
    return new Slice(fragment, 1, 1)
  }

  /** Empties every selected cell, putting `content` in the first. */
  override replace(tr: Transaction, content = Slice.empty): void {
    const mapFrom = tr.steps.length
    this.cellRanges.forEach(({ $from, $to }, index) => {
      const mapping = tr.mapping.slice(mapFrom)
      tr.replace(mapping.map($from.pos), mapping.map($to.pos), index ? Slice.empty : content)
    })
    const selection = Selection.findFrom(tr.doc.resolve(tr.mapping.slice(mapFrom).map(this.to)), -1)
    if (selection) tr.setSelection(selection)
  }

  override replaceWith(tr: Transaction, node: Node): void {
    this.replace(tr, new Slice(Fragment.from(node), 0, 0))
  }

  forEachCell(each: (node: Node, pos: number) => void): void {
    const table = this.$anchorCell.node(-1)
    const map = TableMap.get(table)
    const tableStart = this.$anchorCell.start(-1)
    const cells = map.cellsInRect(
      map.rectBetween(this.$anchorCell.pos - tableStart, this.$headCell.pos - tableStart)
    )
    for (const pos of cells) each(table.nodeAt(pos) as Node, tableStart + pos)
  }

  isColSelection(): boolean {
    const anchorTop = this.$anchorCell.index(-1)
    const headTop = this.$headCell.index(-1)
    if (Math.min(anchorTop, headTop) > 0) return false
    const anchorBottom = anchorTop + ((this.$anchorCell.nodeAfter as Node).attrs.rowspan as number)
    const headBottom = headTop + ((this.$headCell.nodeAfter as Node).attrs.rowspan as number)
    return Math.max(anchorBottom, headBottom) === this.$headCell.node(-1).childCount
  }

  isRowSelection(): boolean {
    const table = this.$anchorCell.node(-1)
    const map = TableMap.get(table)
    const tableStart = this.$anchorCell.start(-1)
    const anchorLeft = map.colCount(this.$anchorCell.pos - tableStart)
    const headLeft = map.colCount(this.$headCell.pos - tableStart)
    if (Math.min(anchorLeft, headLeft) > 0) return false
    const anchorRight = anchorLeft + ((this.$anchorCell.nodeAfter as Node).attrs.colspan as number)
    const headRight = headLeft + ((this.$headCell.nodeAfter as Node).attrs.colspan as number)
    return Math.max(anchorRight, headRight) === map.width
  }

  eq(other: Selection): boolean {
    return (
      other instanceof CellSelection &&
      other.$anchorCell.pos === this.$anchorCell.pos &&
      other.$headCell.pos === this.$headCell.pos
    )
  }

  static colSelection($anchor: ResolvedPos, $head: ResolvedPos = $anchor): CellSelection {
    let $anchorCell = $anchor
    let $headCell = $head
    const table = $anchorCell.node(-1)
    const map = TableMap.get(table)
    const tableStart = $anchorCell.start(-1)
    const anchorRect = map.findCell($anchorCell.pos - tableStart)
    const headRect = map.findCell($headCell.pos - tableStart)
    const doc = $anchorCell.node(0)
    if (anchorRect.top <= headRect.top) {
      if (anchorRect.top > 0)
        $anchorCell = doc.resolve(tableStart + (map.map[anchorRect.left] as number))
      if (headRect.bottom < map.height)
        $headCell = doc.resolve(
          tableStart + (map.map[map.width * (map.height - 1) + headRect.right - 1] as number)
        )
    } else {
      if (headRect.top > 0) $headCell = doc.resolve(tableStart + (map.map[headRect.left] as number))
      if (anchorRect.bottom < map.height)
        $anchorCell = doc.resolve(
          tableStart + (map.map[map.width * (map.height - 1) + anchorRect.right - 1] as number)
        )
    }
    return new CellSelection($anchorCell, $headCell)
  }

  static rowSelection($anchor: ResolvedPos, $head: ResolvedPos = $anchor): CellSelection {
    let $anchorCell = $anchor
    let $headCell = $head
    const table = $anchorCell.node(-1)
    const map = TableMap.get(table)
    const tableStart = $anchorCell.start(-1)
    const anchorRect = map.findCell($anchorCell.pos - tableStart)
    const headRect = map.findCell($headCell.pos - tableStart)
    const doc = $anchorCell.node(0)
    if (anchorRect.left <= headRect.left) {
      if (anchorRect.left > 0)
        $anchorCell = doc.resolve(tableStart + (map.map[anchorRect.top * map.width] as number))
      if (headRect.right < map.width)
        $headCell = doc.resolve(
          tableStart + (map.map[map.width * (headRect.top + 1) - 1] as number)
        )
    } else {
      if (headRect.left > 0)
        $headCell = doc.resolve(tableStart + (map.map[headRect.top * map.width] as number))
      if (anchorRect.right < map.width)
        $anchorCell = doc.resolve(
          tableStart + (map.map[map.width * (anchorRect.top + 1) - 1] as number)
        )
    }
    return new CellSelection($anchorCell, $headCell)
  }

  static create(doc: Node, anchorCell: number, headCell = anchorCell): CellSelection {
    return new CellSelection(doc.resolve(anchorCell), doc.resolve(headCell))
  }
}

/** A text selection that crosses from one cell into the next ends at the first cell's edge. */
function normalizeSelection(state: EditorState, given: Transaction | null): Transaction | null {
  let tr = given
  const selection = (tr ?? state).selection
  const doc = (tr ?? state).doc
  let normalized: Selection | null = null
  const role = selection instanceof NodeSelection ? selection.node.type.spec.tableRole : undefined
  if (selection instanceof NodeSelection && role) {
    if (role === "cell" || role === "header_cell")
      normalized = CellSelection.create(doc, selection.from)
    else if (role === "row") {
      const $cell = doc.resolve(selection.from + 1)
      normalized = CellSelection.rowSelection($cell, $cell)
    } else {
      const map = TableMap.get(selection.node)
      const start = selection.from + 1
      normalized = CellSelection.create(
        doc,
        start + 1,
        start + (map.map[map.width * map.height - 1] as number)
      )
    }
  } else if (selection instanceof TextSelection && isCellBoundarySelection(selection)) {
    normalized = TextSelection.create(doc, selection.from)
  } else if (selection instanceof TextSelection && isTextSelectionAcrossCells(selection)) {
    normalized = TextSelection.create(doc, selection.$from.start(), selection.$from.end())
  }
  if (normalized) {
    tr ??= state.tr
    tr.setSelection(normalized)
  }
  return tr
}

function isCellBoundarySelection({ $from, $to }: Selection): boolean {
  if ($from.pos === $to.pos || $from.pos < $to.pos - 6) return false
  let afterFrom = $from.pos
  let beforeTo = $to.pos
  let depth = $from.depth
  for (; depth >= 0; depth -= 1, afterFrom += 1)
    if ($from.after(depth + 1) < $from.end(depth)) break
  for (let at = $to.depth; at >= 0; at -= 1, beforeTo -= 1)
    if ($to.before(at + 1) > $to.start(at)) break
  return afterFrom === beforeTo && /row|table/.test($from.node(depth).type.spec.tableRole ?? "")
}

function isTextSelectionAcrossCells({ $from, $to }: Selection): boolean {
  const cellOf = ($pos: ResolvedPos) => {
    for (let depth = $pos.depth; depth > 0; depth -= 1)
      if (isCell($pos.node(depth).type)) return $pos.node(depth)
    return undefined
  }
  return cellOf($from) !== cellOf($to) && $to.parentOffset === 0
}

// ── Mending tables ──────────────────────────────────────────────────

/** Calls `each` for the nodes of `current` that differ from `old`'s, as far down as they do. */
function changedDescendants(
  old: Node,
  current: Node,
  offset: number,
  each: (node: Node, pos: number) => void
): void {
  const oldSize = old.childCount
  const currentSize = current.childCount
  let at = offset
  outer: for (let index = 0, j = 0; index < currentSize; index += 1) {
    const child = current.child(index)
    for (let scan = j, end = Math.min(oldSize, index + 3); scan < end; scan += 1) {
      if (old.child(scan) === child) {
        j = scan + 1
        at += child.nodeSize
        continue outer
      }
    }
    each(child, at)
    if (j < oldSize && old.child(j).sameMarkup(child))
      changedDescendants(old.child(j), child, at + 1, each)
    else child.nodesBetween(0, child.content.size, (node, pos) => each(node, pos), at + 1)
    at += child.nodeSize
  }
}

/** A transaction mending every table a change left ragged, or null when none is. */
function fixTables(state: EditorState, oldState: EditorState): Transaction | null {
  let tr: Transaction | null = null
  const check = (node: Node, pos: number) => {
    if (node.type.spec.tableRole === "table") tr = fixTable(state, node, pos, tr)
  }
  if (oldState.doc !== state.doc) changedDescendants(oldState.doc, state.doc, 0, check)
  return tr
}

function fixTable(
  state: EditorState,
  table: Node,
  tablePos: number,
  given: Transaction | null
): Transaction | null {
  const map = TableMap.get(table)
  if (!map.problems) return given
  const tr = given ?? state.tr
  const mustAdd: number[] = new Array(map.height).fill(0)
  for (const problem of map.problems) {
    if (problem.type === "collision") {
      const cell = table.nodeAt(problem.pos)
      if (!cell) continue
      const attrs = cell.attrs
      for (let j = 0; j < (attrs.rowspan as number); j += 1)
        mustAdd[problem.row + j] = (mustAdd[problem.row + j] as number) + problem.n
      tr.setNodeMarkup(
        tr.mapping.map(tablePos + 1 + problem.pos),
        null,
        removeColSpan(attrs, (attrs.colspan as number) - problem.n, problem.n)
      )
    } else if (problem.type === "missing") {
      mustAdd[problem.row] = (mustAdd[problem.row] as number) + problem.n
    } else if (problem.type === "overlong_rowspan") {
      const cell = table.nodeAt(problem.pos)
      if (!cell) continue
      tr.setNodeMarkup(tr.mapping.map(tablePos + 1 + problem.pos), null, {
        ...cell.attrs,
        rowspan: (cell.attrs.rowspan as number) - problem.n,
      })
    } else if (problem.type === "colwidth mismatch") {
      const cell = table.nodeAt(problem.pos)
      if (!cell) continue
      tr.setNodeMarkup(tr.mapping.map(tablePos + 1 + problem.pos), null, {
        ...cell.attrs,
        colwidth: problem.colwidth,
      })
    } else {
      const pos = tr.mapping.map(tablePos)
      tr.delete(pos, pos + table.nodeSize)
    }
  }
  let first: number | null = null
  let last: number | null = null
  mustAdd.forEach((count, index) => {
    if (!count) return
    first ??= index
    last = index
  })
  for (let index = 0, pos = tablePos + 1; index < map.height; index += 1) {
    const row = table.child(index)
    const end = pos + row.nodeSize
    const add = mustAdd[index] as number
    if (add > 0) {
      const role = row.firstChild?.type.spec.tableRole ?? "cell"
      const nodes: Node[] = []
      for (let j = 0; j < add; j += 1) {
        const made = tableNodeTypes(state.schema)[role]?.createAndFill()
        if (made) nodes.push(made)
      }
      const side = (index === 0 || first === index - 1) && last === index ? pos + 1 : end - 1
      tr.insert(tr.mapping.map(side), nodes)
    }
    pos = end
  }
  return tr
}

// ── Pasting cells ───────────────────────────────────────────────────

interface Cells {
  readonly width: number
  readonly height: number
  readonly rows: Fragment[]
}

/** The rectangle of cells a slice holds, or null when it holds no cells or rows. */
function pastedCells(slice: Slice): Cells | null {
  if (slice.size === 0) return null
  let { content, openStart, openEnd } = slice
  while (
    content.childCount === 1 &&
    ((openStart > 0 && openEnd > 0) || content.child(0).type.spec.tableRole === "table")
  ) {
    openStart -= 1
    openEnd -= 1
    content = content.child(0).content
  }
  const first = content.child(0)
  const role = first.type.spec.tableRole
  const schema = first.type.schema
  const rows: Fragment[] = []
  if (role === "row") {
    for (let index = 0; index < content.childCount; index += 1) {
      let cells = content.child(index).content
      const left = index ? 0 : Math.max(0, openStart - 1)
      const right = index < content.childCount - 1 ? 0 : Math.max(0, openEnd - 1)
      if (left || right)
        cells = fitSlice(
          tableNodeTypes(schema).row as NodeType,
          new Slice(cells, left, right)
        ).content
      rows.push(cells)
    }
  } else if (role === "cell" || role === "header_cell") {
    rows.push(
      openStart || openEnd
        ? fitSlice(tableNodeTypes(schema).row as NodeType, new Slice(content, openStart, openEnd))
            .content
        : content
    )
  } else {
    return null
  }
  return ensureRectangular(schema, rows)
}

function ensureRectangular(schema: Schema, rows: Fragment[]): Cells {
  const widths: number[] = []
  rows.forEach((row, index) => {
    for (let j = row.childCount - 1; j >= 0; j -= 1) {
      const { rowspan, colspan } = row.child(j).attrs as { rowspan: number; colspan: number }
      for (let r = index; r < index + rowspan; r += 1) widths[r] = (widths[r] ?? 0) + colspan
    }
  })
  let width = 0
  for (const each of widths) width = Math.max(width, each)
  for (let r = 0; r < widths.length; r += 1) {
    if (r >= rows.length) rows.push(Fragment.empty)
    if ((widths[r] as number) < width) {
      const empty = (tableNodeTypes(schema).cell as NodeType).createAndFill() as Node
      const cells: Node[] = []
      for (let index = widths[r] as number; index < width; index += 1) cells.push(empty)
      rows[r] = (rows[r] as Fragment).append(Fragment.fromArray(cells))
    }
  }
  return { height: rows.length, width, rows }
}

function fitSlice(type: NodeType, slice: Slice): Node {
  const node = type.createAndFill() as Node
  return new Transform(node).replace(0, node.content.size, slice).doc
}

/** The cells cut, or repeated, to cover `newWidth` by `newHeight`. */
function clipCells({ width, height, rows }: Cells, newWidth: number, newHeight: number): Cells {
  let currentRows = rows
  let currentWidth = width
  let currentHeight = height
  if (currentWidth !== newWidth) {
    const added: number[] = []
    const newRows: Fragment[] = []
    currentRows.forEach((fragment, row) => {
      const cells: Node[] = []
      for (let col = added[row] ?? 0, index = 0; col < newWidth; index += 1) {
        let cell = fragment.child(index % fragment.childCount)
        const colspan = cell.attrs.colspan as number
        if (col + colspan > newWidth)
          cell = cell.type.create(
            removeColSpan(cell.attrs, colspan, col + colspan - newWidth),
            cell.content
          )
        cells.push(cell)
        col += cell.attrs.colspan as number
        for (let j = 1; j < (cell.attrs.rowspan as number); j += 1)
          added[row + j] = (added[row + j] ?? 0) + (cell.attrs.colspan as number)
      }
      newRows.push(Fragment.fromArray(cells))
    })
    currentRows = newRows
    currentWidth = newWidth
  }
  if (currentHeight !== newHeight) {
    const newRows: Fragment[] = []
    for (let row = 0, index = 0; row < newHeight; row += 1, index += 1) {
      const cells: Node[] = []
      const source = currentRows[index % currentHeight] as Fragment
      for (let j = 0; j < source.childCount; j += 1) {
        let cell = source.child(j)
        if (row + (cell.attrs.rowspan as number) > newHeight) {
          cell = cell.type.create(
            { ...cell.attrs, rowspan: Math.max(1, newHeight - (cell.attrs.rowspan as number)) },
            cell.content
          )
        }
        cells.push(cell)
      }
      newRows.push(Fragment.fromArray(cells))
    }
    currentRows = newRows
    currentHeight = newHeight
  }
  return { width: currentWidth, height: currentHeight, rows: currentRows }
}

function growTable(
  tr: Transaction,
  map: TableMap,
  table: Node,
  start: number,
  width: number,
  height: number,
  mapFrom: number
): boolean {
  const types = tableNodeTypes(tr.doc.type.schema)
  let empty: Node | undefined
  let emptyHead: Node | undefined
  const cellNode = () => (empty ??= (types.cell as NodeType).createAndFill() as Node)
  const headNode = () => (emptyHead ??= (types.header_cell as NodeType).createAndFill() as Node)
  if (width > map.width) {
    for (let row = 0, rowEnd = 0; row < map.height; row += 1) {
      const rowNode = table.child(row)
      rowEnd += rowNode.nodeSize
      const add =
        rowNode.lastChild == null || rowNode.lastChild.type === types.cell ? cellNode() : headNode()
      const cells: Node[] = []
      for (let index = map.width; index < width; index += 1) cells.push(add)
      tr.insert(tr.mapping.slice(mapFrom).map(rowEnd - 1 + start), cells)
    }
  }
  if (height > map.height) {
    const cells: Node[] = []
    for (
      let index = 0, rowStart = (map.height - 1) * map.width;
      index < Math.max(map.width, width);
      index += 1
    ) {
      const header =
        index >= map.width
          ? false
          : (table.nodeAt(map.map[rowStart + index] as number) as Node).type === types.header_cell
      cells.push(header ? headNode() : cellNode())
    }
    const emptyRow = (types.row as NodeType).create(null, Fragment.fromArray(cells))
    const rows: Node[] = []
    for (let index = map.height; index < height; index += 1) rows.push(emptyRow)
    tr.insert(tr.mapping.slice(mapFrom).map(start + table.nodeSize - 2), rows)
  }
  return !!(empty || emptyHead)
}

function isolateHorizontal(
  tr: Transaction,
  map: TableMap,
  table: Node,
  start: number,
  left: number,
  right: number,
  top: number,
  mapFrom: number
): boolean {
  if (top === 0 || top === map.height) return false
  let found = false
  for (let col = left; col < right; col += 1) {
    const index = top * map.width + col
    const pos = map.map[index] as number
    if (map.map[index - map.width] !== pos) continue
    found = true
    const cell = table.nodeAt(pos) as Node
    const { top: cellTop, left: cellLeft } = map.findCell(pos)
    tr.setNodeMarkup(tr.mapping.slice(mapFrom).map(pos + start), null, {
      ...cell.attrs,
      rowspan: top - cellTop,
    })
    tr.insert(
      tr.mapping.slice(mapFrom).map(map.positionAt(top, cellLeft, table)),
      cell.type.createAndFill({
        ...cell.attrs,
        rowspan: cellTop + (cell.attrs.rowspan as number) - top,
      }) as Node
    )
    col += (cell.attrs.colspan as number) - 1
  }
  return found
}

function isolateVertical(
  tr: Transaction,
  map: TableMap,
  table: Node,
  start: number,
  top: number,
  bottom: number,
  left: number,
  mapFrom: number
): boolean {
  if (left === 0 || left === map.width) return false
  let found = false
  for (let row = top; row < bottom; row += 1) {
    const index = row * map.width + left
    const pos = map.map[index] as number
    if (map.map[index - 1] !== pos) continue
    found = true
    const cell = table.nodeAt(pos) as Node
    const cellLeft = map.colCount(pos)
    const updatePos = tr.mapping.slice(mapFrom).map(pos + start)
    tr.setNodeMarkup(
      updatePos,
      null,
      removeColSpan(cell.attrs, left - cellLeft, (cell.attrs.colspan as number) - (left - cellLeft))
    )
    tr.insert(
      updatePos + cell.nodeSize,
      cell.type.createAndFill(removeColSpan(cell.attrs, 0, left - cellLeft)) as Node
    )
    row += (cell.attrs.rowspan as number) - 1
  }
  return found
}

/** Puts `cells` into the table starting at `tableStart`, over `rect`, growing it where needed. */
function insertCells(
  view: EditorView,
  tableStart: number,
  rect: { top: number; left: number },
  cells: Cells
): void {
  const state = view.state
  const tr = state.tr
  let table = (tableStart ? state.doc.nodeAt(tableStart - 1) : state.doc) as Node
  let map = TableMap.get(table)
  const { top, left } = rect
  const right = left + cells.width
  const bottom = top + cells.height
  let mapFrom = 0
  const recompute = () => {
    table = (tableStart ? tr.doc.nodeAt(tableStart - 1) : tr.doc) as Node
    map = TableMap.get(table)
    mapFrom = tr.mapping.maps.length
  }
  if (growTable(tr, map, table, tableStart, right, bottom, mapFrom)) recompute()
  if (isolateHorizontal(tr, map, table, tableStart, left, right, top, mapFrom)) recompute()
  if (isolateHorizontal(tr, map, table, tableStart, left, right, bottom, mapFrom)) recompute()
  if (isolateVertical(tr, map, table, tableStart, top, bottom, left, mapFrom)) recompute()
  if (isolateVertical(tr, map, table, tableStart, top, bottom, right, mapFrom)) recompute()
  for (let row = top; row < bottom; row += 1) {
    const from = map.positionAt(row, left, table)
    const to = map.positionAt(row, right, table)
    tr.replace(
      tr.mapping.slice(mapFrom).map(from + tableStart),
      tr.mapping.slice(mapFrom).map(to + tableStart),
      new Slice(cells.rows[row - top] as Fragment, 0, 0)
    )
  }
  recompute()
  tr.setSelection(
    new CellSelection(
      tr.doc.resolve(tableStart + map.positionAt(top, left, table)),
      tr.doc.resolve(tableStart + map.positionAt(bottom - 1, right - 1, table))
    )
  )
  view.dispatch(tr)
}

// ── Keys, the mouse and the clipboard ───────────────────────────────

function setSelection(view: EditorView, selection: Selection): boolean {
  if (selection.eq(view.state.selection)) return false
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
  return true
}

/** The cell the caret is at the edge of, toward `dir`, where the arrow would leave it. */
function atEndOfCell(view: EditorView, axis: "horiz" | "vert", dir: number): number | null {
  if (!(view.state.selection instanceof TextSelection)) return null
  const { $head } = view.state.selection
  for (let depth = $head.depth - 1; depth >= 0; depth -= 1) {
    const parent = $head.node(depth)
    if (
      (dir < 0 ? $head.index(depth) : $head.indexAfter(depth)) !== (dir < 0 ? 0 : parent.childCount)
    )
      return null
    if (isCell(parent.type)) {
      const direction = axis === "vert" ? (dir > 0 ? "down" : "up") : dir > 0 ? "right" : "left"
      return view.endOfTextblock(direction) ? $head.before(depth) : null
    }
  }
  return null
}

function arrow(axis: "horiz" | "vert", dir: number) {
  return (view: EditorView): boolean => {
    const { state } = view
    const selection = state.selection
    if (selection instanceof CellSelection)
      return setSelection(view, Selection.near(selection.$headCell, dir))
    if (axis !== "horiz" && !selection.empty) return false
    const end = atEndOfCell(view, axis, dir)
    if (end == null) return false
    if (axis === "horiz")
      return setSelection(view, Selection.near(state.doc.resolve(selection.head + dir), dir))
    const $cell = state.doc.resolve(end)
    const $next = nextCell($cell, axis, dir)
    let next: Selection
    if ($next) next = Selection.near($next, 1)
    else if (dir < 0) next = Selection.near(state.doc.resolve($cell.before(-1)), -1)
    else next = Selection.near(state.doc.resolve($cell.after(-1)), 1)
    return setSelection(view, next)
  }
}

function shiftArrow(axis: "horiz" | "vert", dir: number) {
  return (view: EditorView): boolean => {
    const { state } = view
    let cells: CellSelection
    if (state.selection instanceof CellSelection) {
      cells = state.selection
    } else {
      const end = atEndOfCell(view, axis, dir)
      if (end == null) return false
      cells = new CellSelection(state.doc.resolve(end))
    }
    const $head = nextCell(cells.$headCell, axis, dir)
    if (!$head) return false
    return setSelection(view, new CellSelection(cells.$anchorCell, $head))
  }
}

/** Empties the selected cells that hold anything. */
function deleteCellSelection(view: EditorView): boolean {
  const selection = view.state.selection
  if (!(selection instanceof CellSelection)) return false
  const tr = view.state.tr
  const baseContent = ((tableNodeTypes(view.state.schema).cell as NodeType).createAndFill() as Node)
    .content
  selection.forEachCell((cell, pos) => {
    if (!cell.content.eq(baseContent))
      tr.replace(
        tr.mapping.map(pos + 1),
        tr.mapping.map(pos + cell.nodeSize - 1),
        new Slice(baseContent, 0, 0)
      )
  })
  if (tr.docChanged) view.dispatch(tr)
  return true
}

/** Deletes the table when every one of its cells is selected. */
function deleteTableWhenAllCellsSelected(view: EditorView): boolean {
  const selection = view.state.selection
  if (!(selection instanceof CellSelection)) return false
  const $from = (selection.ranges[0] as SelectionRange).$from
  let tableDepth = -1
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.spec.tableRole === "table") {
      tableDepth = depth
      break
    }
  }
  let cellCount = 0
  if (tableDepth > 0) {
    $from.node(tableDepth).descendants((node) => {
      if (node.type.spec.tableRole === "table") return false
      if (isCell(node.type)) cellCount += 1
      return true
    })
  }
  if (cellCount !== selection.ranges.length) return false
  const $anchor = view.state.selection.$anchor
  for (let depth = $anchor.depth; depth > 0; depth -= 1) {
    if ($anchor.node(depth).type.spec.tableRole === "table") {
      view.dispatch(
        view.state.tr.delete($anchor.before(depth), $anchor.after(depth)).scrollIntoView()
      )
      return true
    }
  }
  return true
}

function domInCell(view: EditorView, target: EventTarget | null): globalThis.Node | null {
  for (let dom = target as globalThis.Node | null; dom && dom !== view.dom; dom = dom.parentNode) {
    if (dom.nodeName === "TD" || dom.nodeName === "TH") return dom
  }
  return null
}

function cellUnderMouse(view: EditorView, event: MouseEvent): ResolvedPos | null {
  const found = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!found) return null
  const { inside, pos } = found
  return (
    (inside >= 0 && cellAround(view.state.doc.resolve(inside))) ||
    cellAround(view.state.doc.resolve(pos))
  )
}

/** Tiptap's table keys: with every cell selected, Backspace or Delete deletes the table. */
export const tableDeleteKeys = {
  Backspace: deleteTableWhenAllCellsSelected,
  "Mod-Backspace": deleteTableWhenAllCellsSelected,
  Delete: deleteTableWhenAllCellsSelected,
  "Mod-Delete": deleteTableWhenAllCellsSelected,
}

/** Selecting, moving among, deleting, copying and pasting cells, and mending tables. */
export function tableEditing(): EditorPlugin {
  /** The cell a drag across cells started in, while it lasts. */
  let dragAnchor: number | null = null
  const keys = keydownHandler([
    {
      ArrowLeft: arrow("horiz", -1),
      ArrowRight: arrow("horiz", 1),
      ArrowUp: arrow("vert", -1),
      ArrowDown: arrow("vert", 1),
      "Shift-ArrowLeft": shiftArrow("horiz", -1),
      "Shift-ArrowRight": shiftArrow("horiz", 1),
      "Shift-ArrowUp": shiftArrow("vert", -1),
      "Shift-ArrowDown": shiftArrow("vert", 1),
      Backspace: deleteCellSelection,
      "Mod-Backspace": deleteCellSelection,
      Delete: deleteCellSelection,
      "Mod-Delete": deleteCellSelection,
    },
  ])

  const mousedown = (view: EditorView, startEvent: MouseEvent): boolean => {
    if (startEvent.button !== 0 || startEvent.ctrlKey || startEvent.metaKey) return false
    const startCell = domInCell(view, startEvent.target)
    const select = ($anchor: ResolvedPos, event: MouseEvent) => {
      let $head = cellUnderMouse(view, event)
      const starting = dragAnchor == null
      if (!$head || !inSameTable($anchor, $head)) {
        if (!starting) return
        $head = $anchor
      }
      const selection = new CellSelection($anchor, $head)
      if (starting || !view.state.selection.eq(selection)) {
        if (starting) dragAnchor = $anchor.pos
        view.dispatch(view.state.tr.setSelection(selection))
      }
    }
    // Shift and a press in another cell selects from the caret's cell to that one.
    const $anchor =
      startEvent.shiftKey && startCell ? cellAround(view.state.selection.$anchor) : null
    if (startEvent.shiftKey && view.state.selection instanceof CellSelection) {
      select(view.state.selection.$anchorCell, startEvent)
      startEvent.preventDefault()
    } else if ($anchor && cellUnderMouse(view, startEvent)?.pos !== $anchor.pos) {
      select($anchor, startEvent)
      startEvent.preventDefault()
    } else if (!startCell) {
      return false
    }
    const root = view.document
    const stop = () => {
      root.removeEventListener("mouseup", stop)
      root.removeEventListener("dragstart", stop)
      root.removeEventListener("mousemove", move)
      if (dragAnchor != null) {
        dragAnchor = null
        view.dispatch(view.state.tr)
      }
    }
    const move = (event: Event) => {
      const mouse = event as MouseEvent
      let $from: ResolvedPos | null = null
      if (dragAnchor != null) {
        $from = view.state.doc.resolve(dragAnchor)
      } else if (domInCell(view, mouse.target) !== startCell) {
        $from = cellUnderMouse(view, startEvent)
        if (!$from) {
          stop()
          return
        }
      }
      if ($from) select($from, mouse)
    }
    root.addEventListener("mouseup", stop)
    root.addEventListener("dragstart", stop)
    root.addEventListener("mousemove", move)
    return false
  }

  return {
    apply: (tr) => {
      if (dragAnchor == null || !tr.docChanged) return
      const mapped = tr.mapping.mapResult(dragAnchor)
      dragAnchor = mapped.deleted ? null : mapped.pos
    },
    decorations: (state): Decoration[] => {
      if (!(state.selection instanceof CellSelection)) return []
      const cells: Decoration[] = []
      state.selection.forEachCell((node, pos) => {
        cells.push({
          kind: "node",
          from: pos,
          to: pos + node.nodeSize,
          attrs: { class: "selectedCell" },
        })
      })
      return cells
    },
    handleDOMEvents: {
      mousedown: (view, event) => mousedown(view, event as MouseEvent),
    },
    // While cells are being selected by the mouse, the browser's selection says nothing.
    createSelectionBetween: (view) => (dragAnchor != null ? view.state.selection : null),
    handleTripleClick: (view, pos) => {
      const $cell = cellAround(view.state.doc.resolve(pos))
      if (!$cell) return false
      view.dispatch(view.state.tr.setSelection(new CellSelection($cell)))
      return true
    },
    handleKeyDown: (view, event) => keys(view, event),
    handlePaste: (view, _event, slice) => {
      if (!isInTable(view.state)) return false
      let cells = pastedCells(slice)
      const selection = view.state.selection
      if (selection instanceof CellSelection) {
        cells ??= {
          width: 1,
          height: 1,
          rows: [
            Fragment.from(fitSlice(tableNodeTypes(view.state.schema).cell as NodeType, slice)),
          ],
        }
        const table = selection.$anchorCell.node(-1)
        const start = selection.$anchorCell.start(-1)
        const rect = TableMap.get(table).rectBetween(
          selection.$anchorCell.pos - start,
          selection.$headCell.pos - start
        )
        insertCells(
          view,
          start,
          rect,
          clipCells(cells, rect.right - rect.left, rect.bottom - rect.top)
        )
        return true
      }
      if (!cells) return false
      const $cell = selectionCell(view.state)
      const start = $cell.start(-1)
      insertCells(view, start, TableMap.get($cell.node(-1)).findCell($cell.pos - start), cells)
      return true
    },
    appendTransaction: (_transactions, before, after) =>
      normalizeSelection(after, fixTables(after, before)),
  }
}

/** A right click inside several selected cells keeps them selected, for the menu it opens. */
export function keepCellsOnContextMenu(): EditorPlugin {
  return {
    handleDOMEvents: {
      mousedown: (view, event) => {
        const mouse = event as MouseEvent
        if (mouse.button !== 2) return false
        const selection = view.state.selection
        if (!(selection instanceof CellSelection) || selection.ranges.length < 2) return false
        let clickPos: number | null =
          view.posAtCoords({ left: mouse.clientX, top: mouse.clientY })?.pos ?? null
        if (clickPos == null && mouse.target instanceof view.window.Node) {
          try {
            clickPos = view.posFromDOM(mouse.target, 0, -1)
          } catch {
            clickPos = null
          }
        }
        if (clickPos == null) return false
        let inside = false
        selection.forEachCell((cell, cellPos) => {
          if ((clickPos as number) >= cellPos && (clickPos as number) < cellPos + cell.nodeSize)
            inside = true
        })
        if (!inside) return false
        mouse.preventDefault()
        return true
      },
    },
  }
}
