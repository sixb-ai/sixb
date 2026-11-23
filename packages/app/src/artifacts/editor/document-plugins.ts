import {
  type Command,
  clearNodes,
  exitCode,
  findCutAfter,
  findCutBefore,
  findParentNode,
  first,
  getMarkRange,
  insertContentAt,
  isNodeActive,
  joinBackward,
  lift,
  liftListItem,
  run,
  setMark,
  setNode,
  sinkListItem,
  splitListItem,
  toggleList,
  toggleMark,
  toggleNode,
  toggleWrap,
} from "./core/commands"
import type { EditorPlugin } from "./core/editor"
import { gapCursorPlugin } from "./core/gapcursor"
import { Fragment, type MarkType, type Node, type NodeType, Slice } from "./core/model"
import { markPasteRule, type PasteFound, pasteRules } from "./core/pasterules"
import { type InputRule, InputRules } from "./core/plugins"
import { NodeSelection, Selection, TextSelection, type Transaction } from "./core/state"
import { keepCellsOnContextMenu, tableDeleteKeys, tableEditing } from "./core/tables"
import { canJoin, findWrapping, joinPoint, ReplaceStep, replaceStep } from "./core/transform"
import type { EditorView, InlineDecoration } from "./core/view"
import { findLinks, wordLink } from "./links"
import { isAllowedUri, documentSchema as schema } from "./schema"

// The keys and input rules a Markdown document's editor has, in the order that decides which
// takes a key first: lists before the core keys, code before lists, a table before them all.

const nodes = schema.nodes as Record<string, NodeType>
const marks = schema.marks as Record<string, MarkType>
const isList = (type: NodeType) => type.isInGroup("list")
const key = (command: Command) => (view: EditorView) => run(view, command)

// ── Input rules ─────────────────────────────────────────────────────────

function markRule(find: RegExp, type: MarkType): InputRule {
  return {
    find,
    handler: ({ state, tr, range, match }) => {
      const captured = match[match.length - 1]
      const full = match[0]
      if (!captured) return true
      const startSpaces = full.search(/\S/)
      const textStart = range.from + full.indexOf(captured)
      const textEnd = textStart + captured.length
      let excluded = false
      state.doc.nodesBetween(range.from, range.to, (node, pos) => {
        for (const mark of node.marks) {
          if (
            mark.type.excluded.includes(type) &&
            mark.type !== type &&
            pos + node.nodeSize > textStart
          )
            excluded = true
        }
        return true
      })
      if (excluded) return false
      if (textEnd < range.to) tr.delete(textEnd, range.to)
      if (textStart > range.from) tr.delete(range.from + startSpaces, textStart)
      const markEnd = range.from + startSpaces + captured.length
      tr.addMark(range.from + startSpaces, markEnd, type.create())
      tr.removeStoredMark(type)
      return true
    },
  }
}

function textblockRule(
  find: RegExp,
  type: NodeType,
  attrs?: (match: RegExpExecArray) => Record<string, unknown>
): InputRule {
  return {
    find,
    handler: ({ state, tr, range, match }) => {
      const $start = state.doc.resolve(range.from)
      if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), type))
        return false
      tr.delete(range.from, range.to).setBlockType(
        range.from,
        range.from,
        type,
        attrs?.(match) ?? {}
      )
      return true
    },
  }
}

function wrappingRule(
  find: RegExp,
  type: NodeType,
  attrs?: (match: RegExpExecArray) => Record<string, unknown>,
  joinPredicate?: (match: RegExpExecArray, node: Node) => boolean
): InputRule {
  return {
    find,
    handler: ({ tr, range, match }) => {
      tr.delete(range.from, range.to)
      const $start = tr.doc.resolve(range.from)
      const blockRange = $start.blockRange()
      const wrapping = blockRange && findWrapping(blockRange, type, attrs?.(match) ?? {})
      if (!blockRange || !wrapping) return false
      tr.wrap(blockRange, wrapping)
      const before = tr.doc.resolve(range.from - 1).nodeBefore
      if (
        before &&
        before.type === type &&
        canJoin(tr.doc, range.from - 1) &&
        (!joinPredicate || joinPredicate(match, before))
      )
        tr.join(range.from - 1)
      return true
    },
  }
}

function nodeRule(
  find: RegExp,
  type: NodeType,
  attrs?: (match: RegExpExecArray) => Record<string, unknown>
): InputRule {
  return {
    find,
    handler: ({ tr, range, match }) => {
      const made = type.create(attrs?.(match) ?? {})
      const start = range.from
      let end = range.to
      if (match[1]) {
        const offset = match[0].lastIndexOf(match[1])
        let matchStart = start + offset
        if (matchStart > end) matchStart = end
        else end = matchStart + match[1].length
        const lastChar = match[0][match[0].length - 1] as string
        tr.insertText(lastChar, start + match[0].length - 1)
        tr.replaceWith(matchStart, end, made)
      } else if (match[0]) {
        const insertionStart = type.isInline ? start : start - 1
        tr.insert(insertionStart, made).delete(tr.mapping.map(start), tr.mapping.map(end))
      }
      tr.scrollIntoView()
      return true
    },
  }
}

/** Inline code typed between single backticks, with no backtick just before or after them. */
function codeMatch(text: string): RegExpExecArray | null {
  const match = /(^|[^`])`([^`]+)`(?!`)$/.exec(text)
  if (!match) return null
  const prefix = match[1] ?? ""
  const result = [match[0].slice(prefix.length), match[2] as string] as unknown as RegExpExecArray
  result.index = match.index + prefix.length
  result.input = text
  return result
}

// ── Lists ───────────────────────────────────────────────────────────────

function isAtStartOfNode(tr: Transaction): boolean {
  const { $from, $to } = tr.selection
  return $from.parentOffset === 0 && $from.pos === $to.pos
}

/** Backspace at the start of a list's first item lifts it out; after a list, joins into its last item. */
function listBackspace(
  rules: () => InputRules,
  item: NodeType,
  wrappers: readonly NodeType[]
): (view: EditorView) => boolean {
  return (view) => {
    const tr = view.state.tr
    if (rules().undo(tr)) {
      view.dispatch(tr)
      return true
    }
    const selection = view.state.selection
    if (selection.from !== selection.to) return false
    const { $anchor } = selection
    const previous = view.state.doc.resolve(Math.max(0, $anchor.pos - 2)).node()
    if (!isNodeActive(tr, item) && wrappers.includes(previous.type)) {
      const $list = view.state.doc.resolve($anchor.before() - 1)
      let last: { node: Node; pos: number } | null = null
      $list.node().descendants((node, pos) => {
        if (node.type === item) last = { node, pos }
        return true
      })
      if (!last) return false
      const $last = view.state.doc.resolve($list.start() + (last as { pos: number }).pos + 1)
      const target = $last.end()
      const moved = view.state.tr
        .delete($anchor.before(), $anchor.after())
        .insert(target, $anchor.parent)
      moved.setSelection(TextSelection.create(moved.doc, target + 1))
      joinTextblockBackward(moved)
      view.dispatch(moved)
      return true
    }
    if (!isNodeActive(tr, item) || !isAtStartOfNode(tr)) return false
    const { $from } = selection
    const itemDepth = $from.depth - 1
    if ($from.node(itemDepth).type !== item || $from.index(itemDepth) !== 0) return false
    return run(view, liftListItem(item))
  }
}

function joinTextblockBackward(tr: Transaction): boolean {
  const selection = tr.selection
  const $cursor = selection instanceof TextSelection ? selection.$cursor : null
  if (!$cursor || $cursor.parentOffset > 0) return false
  const $cut = findCutBefore($cursor)
  if (!$cut) return false
  let before = $cut.nodeBefore as Node
  let beforePos = $cut.pos - 1
  for (; !before.isTextblock; beforePos -= 1) {
    if (before.type.spec.isolating || !before.lastChild) return false
    before = before.lastChild
  }
  let after = $cut.nodeAfter as Node
  let afterPos = $cut.pos + 1
  for (; !after.isTextblock; afterPos += 1) {
    if (after.type.spec.isolating || !after.firstChild) return false
    after = after.firstChild
  }
  const step = replaceStep(tr.doc, beforePos, afterPos, Slice.empty)
  if (
    !step ||
    !(step instanceof ReplaceStep) ||
    step.from !== beforePos ||
    step.slice.size >= afterPos - beforePos
  )
    return false
  tr.step(step)
  tr.setSelection(TextSelection.create(tr.doc, beforePos))
  return true
}

/** The depth of the list item at `pos`, or false where there is none. */
function itemDepthAt(doc: Node, item: NodeType, pos: number): number | false {
  if (pos < 0 || pos > doc.content.size) return false
  const $pos = doc.resolve(pos)
  for (let depth = Math.min(20, $pos.depth); depth > 0; depth -= 1)
    if ($pos.node(depth).type === item) return depth
  return false
}

/** Delete at the end of a list item joins the next item's words onto it. */
function listDelete(item: NodeType): (view: EditorView) => boolean {
  return (view) => {
    const { state } = view
    const selection = state.selection
    const tr = state.tr
    if (!isNodeActive(tr, item)) return false
    const parent = findParentNode(selection.$from, (node) => node.type === item)
    if (
      !parent ||
      selection.$anchor.pos + 1 !== state.doc.resolve(parent.pos + 1).end() ||
      !selection.empty
    )
      return false
    // The list item the caret is in, where its depth starts counting.
    let depth = selection.$from.depth
    let pos = selection.$from.pos
    while (depth > 0 && selection.$from.node(depth).type !== item) {
      depth -= 1
      pos -= 1
    }
    const nextDepth = itemDepthAt(state.doc, item, pos + 4)
    if (nextDepth !== false && nextDepth > depth) {
      // The nested list after the caret comes up a level, then joins onto the item.
      return run(view, (each) => {
        each.setSelection(
          TextSelection.create(each.doc, Math.min(selection.from + 4, each.doc.content.size))
        )
        if (isNodeActive(each, item)) lift(each)
        joinBackward(each)
        return true
      })
    }
    if (nextDepth !== false && nextDepth < depth) return run(view, joinTextblockForward)
    return run(view, (each) => {
      const point = joinPoint(each.doc, each.selection.$from.pos, 1)
      if (point === undefined) return false
      try {
        each.join(point, 2)
        return true
      } catch {
        return false
      }
    })
  }
}

function joinTextblockForward(tr: Transaction): boolean {
  const selection = tr.selection
  const $cursor = selection instanceof TextSelection ? selection.$cursor : null
  if (!$cursor || $cursor.parentOffset < $cursor.parent.content.size) return false
  const $cut = findCutAfter($cursor)
  if (!$cut) return false
  let before = $cut.nodeBefore as Node
  let beforePos = $cut.pos - 1
  for (; !before.isTextblock; beforePos -= 1) {
    if (before.type.spec.isolating || !before.lastChild) return false
    before = before.lastChild
  }
  let after = $cut.nodeAfter as Node
  let afterPos = $cut.pos + 1
  for (; !after.isTextblock; afterPos += 1) {
    if (after.type.spec.isolating || !after.firstChild) return false
    after = after.firstChild
  }
  const step = replaceStep(tr.doc, beforePos, afterPos, Slice.empty)
  if (
    !step ||
    !(step instanceof ReplaceStep) ||
    step.from !== beforePos ||
    step.slice.size >= afterPos - beforePos
  )
    return false
  tr.step(step)
  tr.setSelection(TextSelection.create(tr.doc, beforePos))
  return true
}

/** Tab at the start of a block right after a list puts it in the list's last item. */
function listTab(item: NodeType, wrappers: readonly NodeType[]): (view: EditorView) => boolean {
  return (view) => {
    const selection = view.state.selection
    if (!selection.empty) return false
    const { $from } = selection
    if ($from.parentOffset !== 0 || !$from.parent.isTextblock || isNodeActive(view.state.tr, item))
      return false
    const index = $from.index(-1)
    const previous = index > 0 ? $from.node(-1).child(index - 1) : null
    if (!previous || !wrappers.includes(previous.type)) return false
    const last = previous.lastChild
    if (!last || last.type !== item) return false
    const block = $from.parent
    if (!last.canReplace(last.childCount, last.childCount, Fragment.from(block))) return false
    const start = $from.before()
    const end = $from.after()
    const inside = start - 2
    const tr = view.state.tr.delete(start, end).insert(inside, Fragment.from(block))
    tr.setSelection(TextSelection.create(tr.doc, inside + 1)).scrollIntoView()
    view.dispatch(tr)
    return true
  }
}

// ── Code ────────────────────────────────────────────────────────────────

const codeBlockKeys = {
  "Mod-Alt-c": key(toggleNode(nodes.codeBlock as NodeType, nodes.paragraph as NodeType)),
  Backspace: (view: EditorView) => {
    const { empty, $anchor } = view.state.selection
    if (!empty || $anchor.parent.type !== nodes.codeBlock) return false
    if ($anchor.pos === 1 || !$anchor.parent.textContent.length) return run(view, clearNodes)
    return false
  },
  Enter: (view: EditorView) => {
    const { $from, empty } = view.state.selection
    if (!empty || $from.parent.type !== nodes.codeBlock) return false
    const atEnd = $from.parentOffset === $from.parent.nodeSize - 2
    if (!atEnd || !$from.parent.textContent.endsWith("\n\n")) return false
    return run(view, (tr) => {
      tr.delete($from.pos - 2, $from.pos)
      return exitCode(tr)
    })
  },
  ArrowUp: (view: EditorView) => {
    const { $from, empty } = view.state.selection
    if (!empty || $from.parent.type !== nodes.codeBlock || $from.parentOffset !== 0) return false
    const before = $from.before()
    if (before > 0) return false
    return run(view, (tr) => {
      tr.insert(before, (nodes.paragraph as NodeType).create())
      tr.setSelection(TextSelection.create(tr.doc, before + 1))
      return true
    })
  },
  ArrowDown: (view: EditorView) => {
    const { $from, empty } = view.state.selection
    if (!empty || $from.parent.type !== nodes.codeBlock) return false
    if ($from.parentOffset !== $from.parent.nodeSize - 2) return false
    const after = $from.after()
    if (view.state.doc.nodeAt(after))
      return run(view, (tr) => !!tr.setSelection(Selection.near(tr.doc.resolve(after))))
    return run(view, exitCode)
  },
}

// ── Blockquotes ─────────────────────────────────────────────────────────

function blockquoteBackspace(view: EditorView): boolean {
  const selection = view.state.selection
  if (!selection.empty) return false
  const { $from } = selection
  if ($from.parentOffset !== 0) return false
  const parentDepth = $from.depth - 1
  if (parentDepth < 0) return false
  const parent = $from.node(parentDepth)
  const index = $from.index(parentDepth)
  if (index === 0) return false
  const type = nodes.blockquote as NodeType
  if (parent.type === type) return run(view, (tr) => isNodeActive(tr, type) && lift(tr))
  const previous = parent.child(index - 1)
  if (previous.type !== type || !previous.lastChild?.isTextblock) return false
  const target = $from.before() - 2
  const content = $from.parent.content
  const tr = view.state.tr.replace(target, $from.after(), new Slice(content, 0, 0))
  tr.setSelection(TextSelection.create(tr.doc, target + content.size)).scrollIntoView()
  view.dispatch(tr)
  return true
}

// ── Tables ──────────────────────────────────────────────────────────────

function cellAround(tr: Transaction): { depth: number; pos: number } | null {
  const { $head } = tr.selection
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const role = $head.node(depth).type.spec.tableRole
    if (role === "cell" || role === "header_cell") return { depth, pos: $head.before(depth) }
  }
  return null
}

/** The cells of the table around `pos`, in reading order, with where each starts. */
function cellsOf(doc: Node, tablePos: number): number[] {
  const table = doc.nodeAt(tablePos) as Node
  const cells: number[] = []
  table.forEach((row, rowOffset) => {
    row.forEach((_cell, cellOffset) => {
      cells.push(tablePos + 1 + rowOffset + 1 + cellOffset)
    })
  })
  return cells
}

function goToCell(dir: 1 | -1): Command {
  return (tr) => {
    const cell = cellAround(tr)
    if (!cell) return false
    const tablePos = tr.selection.$head.before(cell.depth - 2)
    const cells = cellsOf(tr.doc, tablePos)
    const next = cells[cells.indexOf(cell.pos) + dir]
    if (next === undefined) return false
    const node = tr.doc.nodeAt(next) as Node
    // The next cell's words, selected whole, as a table's cells are entered.
    tr.setSelection(
      TextSelection.between(tr.doc.resolve(next), tr.doc.resolve(next + node.nodeSize))
    ).scrollIntoView()
    return true
  }
}

/** A row after the caret's, its cells each the kind of the cell above it, as tables add rows. */
const addRowAfter: Command = (tr) => {
  const cell = cellAround(tr)
  if (!cell) return false
  const rowPos = tr.selection.$head.before(cell.depth - 1)
  const row = tr.doc.nodeAt(rowPos) as Node
  const cells: Node[] = []
  row.forEach((each) => {
    cells.push(each.type.createAndFill() as Node)
  })
  tr.insert(rowPos + row.nodeSize, (nodes.tableRow as NodeType).create(null, cells))
  return true
}

const tableKeys = {
  Tab: (view: EditorView) => {
    if (run(view, goToCell(1))) return true
    const tr = view.state.tr
    if (!cellAround(tr)) return false
    return run(view, (each) => addRowAfter(each) && goToCell(1)(each))
  },
  "Shift-Tab": (view: EditorView) => run(view, goToCell(-1)),
  ...tableDeleteKeys,
}

// ── Links ───────────────────────────────────────────────────────────────

const WHITESPACE = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/
const WHITESPACE_END = new RegExp(`${WHITESPACE.source}$`)
const WHITESPACE_TRAILING = new RegExp(`${WHITESPACE.source}+$`)

/** The ranges a set of transactions changed, in the last one's document. */
function changedRanges(transactions: readonly Transaction[]): { from: number; to: number }[] {
  const maps = transactions.flatMap((tr) => tr.mapping.maps)
  const steps = transactions.flatMap((tr) => tr.steps)
  const ranges: { from: number; to: number }[] = []
  maps.forEach((map, index) => {
    const local: { from: number; to: number }[] = []
    if (!map.ranges.length) {
      const step = steps[index] as { from?: number; to?: number }
      if (step.from !== undefined && step.to !== undefined)
        local.push({ from: step.from, to: step.to })
    } else {
      map.forEach((from, to) => {
        local.push({ from, to })
      })
    }
    const after = maps.slice(index)
    const through = (pos: number, assoc: number) =>
      after.reduce((at, each) => each.map(at, assoc), pos)
    for (const { from, to } of local) ranges.push({ from: through(from, -1), to: through(to, 1) })
  })
  const seen = new Set<string>()
  return ranges.filter((range) => {
    const key = `${range.from}-${range.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A link typed on stays off the space typed after it. */
function unlinkTrailingWhitespace(
  tr: Transaction,
  range: { from: number; to: number },
  type: MarkType
): void {
  const $end = tr.doc.resolve(range.to)
  if (!$end.nodeBefore?.isText) return
  const inserted = tr.doc.textBetween(range.from, range.to, "\ufffc", "\ufffc")
  const trailing = WHITESPACE_TRAILING.exec(inserted)?.[0]
  if (!trailing) return
  const whitespaceFrom = range.to - trailing.length
  let linked: import("./core/model").Mark | null = null
  tr.doc.nodesBetween(whitespaceFrom, range.to, (node) => {
    linked ??= node.marks.find((mark) => mark.type === type) ?? null
    return true
  })
  if (!linked) return
  const after = $end.nodeAfter
  if (after && (linked as import("./core/model").Mark).isInSet(after.marks)) return
  const storedMarks = tr.storedMarks
  tr.removeMark(whitespaceFrom, range.to, type)
  tr.setStoredMarks(storedMarks)
  if (tr.selection.empty && tr.selection.from === range.to) tr.removeStoredMark(type)
}

/** An address typed and ended with a space, or pasted among blocks, links itself. */
const autolink: EditorPlugin = {
  appendTransaction: (transactions, before, after) => {
    const changed = transactions.some((tr) => tr.docChanged) && !before.doc.eq(after.doc)
    if (!changed || transactions.some((tr) => tr.getMeta("preventAutolink"))) return null
    const type = marks.link as MarkType
    const tr = after.tr
    const steps = transactions.flatMap((each) => each.steps)
    const maps = transactions.flatMap((each) => each.mapping.maps)
    const inserted: { from: number; to: number }[] = []
    steps.forEach((step, index) => {
      if (!(step instanceof ReplaceStep) || !step.slice.size) return
      const rest = maps.slice(index + 1)
      const from = rest.reduce((at, map) => map.map(at, 1), step.from)
      const to = rest.reduce((at, map) => map.map(at, -1), step.from + step.slice.size)
      if (from < to) inserted.push({ from, to })
    })
    inserted.sort((left, right) => right.to - left.to)
    for (const range of inserted) unlinkTrailingWhitespace(tr, range, type)
    const doc = after.doc
    for (const range of changedRanges(transactions)) {
      const blocks: { node: Node; pos: number }[] = []
      doc.nodesBetween(
        Math.max(0, range.from),
        Math.min(range.to, doc.content.size),
        (node, pos) => {
          if (node.isTextblock) blocks.push({ node, pos })
          return true
        }
      )
      let block: { node: Node; pos: number } | undefined
      let textBefore: string | undefined
      if (blocks.length > 1) {
        block = blocks[0]
        textBefore = block
          ? doc.textBetween(block.pos, block.pos + block.node.nodeSize, undefined, " ")
          : undefined
      } else if (blocks.length) {
        const endText = doc.textBetween(range.from, range.to, " ", " ")
        if (!WHITESPACE_END.test(endText)) continue
        block = blocks[0]
        textBefore = block ? doc.textBetween(block.pos, range.to, undefined, " ") : undefined
      }
      if (!block || !textBefore) continue
      const words = textBefore.split(WHITESPACE).filter(Boolean)
      const last = words[words.length - 1]
      if (!last) continue
      const offset = block.pos + textBefore.lastIndexOf(last)
      const link = wordLink(last)
      if (!link || !isAllowedUri(link.value)) continue
      const from = offset + link.start + 1
      const to = offset + link.end + 1
      if (doc.rangeHasMark(from, to, marks.code as MarkType)) continue
      let hasLink = false
      doc.nodesBetween(from, to, (node) => {
        if (node.marks.some((mark) => mark.type === type)) hasLink = true
        return true
      })
      if (hasLink) continue
      tr.addMark(from, to, type.create({ href: link.href }))
    }
    return tr.steps.length ? tr : null
  },
}

/** Inline code pasted between single backticks, with no backtick just before them. */
function pastedCode(text: string): PasteFound[] {
  const found: PasteFound[] = []
  const pattern = /`([^`]+)`(?!`)/g
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > 0 && text[match.index - 1] === "`") continue
    found.push({ index: match.index, text: match[0], replaceWith: match[1] as string })
  }
  return found
}

/** The addresses in pasted words that link themselves. */
function pastedLinks(text: string): PasteFound[] {
  return findLinks(text)
    .filter((link) => isAllowedUri(link.value) && linksItself(link.value))
    .map((link) => ({ text: link.value, data: { href: link.href }, index: link.start }))
}

/** Whether an address links itself: it names a protocol, or a host with a dot that is not a number. */
function linksItself(url: string): boolean {
  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  const hasMaybeProtocol = /^[a-z][a-z0-9+.-]*:/i.test(url)
  if (hasProtocol || (hasMaybeProtocol && !url.includes("@"))) return true
  const hostname = (url.includes("@") ? (url.split("@").pop() as string) : url).split(
    /[/?#:]/
  )[0] as string
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false
  return /\./.test(hostname)
}

/** An address pasted over selected words links them. */
const linkOnPaste: EditorPlugin = {
  handlePaste: (view, _event, slice) => {
    const { selection } = view.state
    if (selection.empty) return false
    let text = ""
    slice.content.forEach((node) => {
      text += node.textContent
    })
    const link = findLinks(text).find((each) => each.value === text)
    if (!text || !link) return false
    return run(view, setMark(marks.link as MarkType, { href: link.href }))
  },
}

// ── Soft breaks ─────────────────────────────────────────────────────────

/**
 * A line break within a paragraph's Markdown, as the Agent writes them: the document page reads
 * it as a space, and so does the editor, while the text keeps it. Code keeps its lines.
 */
export const softBreaks: EditorPlugin = {
  textblockDecorations: (node) => {
    if (node.type.spec.code) return []
    const found: InlineDecoration[] = []
    let offset = 0
    node.forEach((child) => {
      if (child.isText) {
        for (const match of (child.text ?? "").matchAll(/\r?\n|\r/g)) {
          const at = offset + match.index
          found.push({
            kind: "inline",
            from: at,
            to: at + match[0].length,
            attrs: { class: "sixb-soft-break" },
          })
        }
      }
      offset += child.nodeSize
    })
    return found
  },
}

// ── The whole set ───────────────────────────────────────────────────────

export interface DocumentPluginsOptions {
  /** Plugins that come before the lists' keys: the block shortcuts, the `/` menu, carets. */
  readonly before: readonly EditorPlugin[]
  readonly history: EditorPlugin
  readonly base: (rules: InputRules) => EditorPlugin
}

/** The plugins of a Markdown document's editor, in the order they take keys and typing. */
export function documentPlugins(options: DocumentPluginsOptions): EditorPlugin[] {
  const allRules: InputRules[] = []
  const rules = (list: InputRule[]) => {
    const made = new InputRules(list)
    allRules.push(made)
    return made.plugin()
  }
  const anyRules = {
    undo: (tr: Transaction) => allRules.some((each) => each.undo(tr)),
  } as unknown as InputRules
  const heading = nodes.heading as NodeType
  const paragraph = nodes.paragraph as NodeType
  const listWrappers = [nodes.bulletList, nodes.orderedList] as NodeType[]
  return [
    // Pasted syntax and addresses, ahead of every other plugin's follow-up.
    ...pasteRules([
      markPasteRule(pastedLinks, marks.link as MarkType, (match) => ({ href: match.data?.href })),
      markPasteRule(/(?:^|\s)(~~(?!\s+~~)((?:[^~]+))~~(?!\s+~~))/g, marks.strike as MarkType),
      markPasteRule(/(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))/g, marks.italic as MarkType),
      markPasteRule(/(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))/g, marks.italic as MarkType),
      markPasteRule(pastedCode, marks.code as MarkType),
      markPasteRule(/(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))/g, marks.bold as MarkType),
      markPasteRule(/(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))/g, marks.bold as MarkType),
    ]),
    options.history,
    { keys: { "Mod-Alt-0": key(setNode(paragraph)) } },
    autolink,
    linkOnPaste,
    ...options.before,
    { keys: tableKeys },
    tableEditing(),
    keepCellsOnContextMenu(),
    {
      keys: {
        Enter: key(splitListItem(nodes.taskItem as NodeType)),
        "Shift-Tab": key(liftListItem(nodes.taskItem as NodeType)),
        Tab: key(sinkListItem(nodes.taskItem as NodeType)),
      },
    },
    rules([
      wrappingRule(/^\s*(\[([( |x])?\])\s$/, nodes.taskItem as NodeType, (match) => ({
        checked: match[match.length - 1] === "x",
      })),
    ]),
    {
      keys: {
        "Mod-Shift-9": key(
          toggleList(nodes.taskList as NodeType, nodes.taskItem as NodeType, isList)
        ),
      },
    },
    rules([
      nodeRule(
        /(?:^|\s)(!\[(.+|:?)]\((\S+)(?:(?:\s+)["'](\S+)["'])?\))$/,
        nodes.image as NodeType,
        (match) => {
          const [, , alt, src, title] = match
          return { src, alt, title }
        }
      ),
    ]),
    { keys: codeBlockKeys },
    rules([
      textblockRule(/^```([a-z]+)?[\s\n]$/, nodes.codeBlock as NodeType, (match) => ({
        language: match[1],
      })),
      textblockRule(/^~~~([a-z]+)?[\s\n]$/, nodes.codeBlock as NodeType, (match) => ({
        language: match[1],
      })),
    ]),
    { keys: { "Mod-Shift-s": key(toggleMark(marks.strike as MarkType)) } },
    rules([markRule(/(?:^|\s)(~~(?!\s+~~)((?:[^~]+))~~(?!\s+~~))$/, marks.strike as MarkType)]),
    {
      keys: {
        "Mod-Shift-7": key(
          toggleList(nodes.orderedList as NodeType, nodes.listItem as NodeType, isList)
        ),
      },
    },
    rules([
      wrappingRule(
        /^(\d+)\.\s$/,
        nodes.orderedList as NodeType,
        (match) => ({ start: Number(match[1]) }),
        (match, node) => node.childCount + Number(node.attrs.start) === Number(match[1])
      ),
    ]),
    {
      keys: {
        Delete: (view) =>
          listDelete(nodes.listItem as NodeType)(view) ||
          listDelete(nodes.taskItem as NodeType)(view),
        "Mod-Delete": (view) =>
          listDelete(nodes.listItem as NodeType)(view) ||
          listDelete(nodes.taskItem as NodeType)(view),
        Backspace: (view) =>
          listBackspace(() => anyRules, nodes.listItem as NodeType, listWrappers)(view) ||
          listBackspace(() => anyRules, nodes.taskItem as NodeType, [nodes.taskList as NodeType])(
            view
          ),
        "Mod-Backspace": (view) =>
          listBackspace(() => anyRules, nodes.listItem as NodeType, listWrappers)(view) ||
          listBackspace(() => anyRules, nodes.taskItem as NodeType, [nodes.taskList as NodeType])(
            view
          ),
        Tab: (view) =>
          listTab(nodes.listItem as NodeType, listWrappers)(view) ||
          listTab(nodes.taskItem as NodeType, [nodes.taskList as NodeType])(view),
      },
    },
    {
      keys: {
        Enter: key(splitListItem(nodes.listItem as NodeType)),
        Tab: key(sinkListItem(nodes.listItem as NodeType)),
        "Shift-Tab": key(liftListItem(nodes.listItem as NodeType)),
      },
    },
    {
      keys: {
        "Mod-i": key(toggleMark(marks.italic as MarkType)),
        "Mod-I": key(toggleMark(marks.italic as MarkType)),
      },
    },
    rules([
      markRule(/(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/, marks.italic as MarkType),
      markRule(/(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/, marks.italic as MarkType),
    ]),
    rules([nodeRule(/^(?:---|—-|___\s|\*\*\*\s)$/, nodes.horizontalRule as NodeType)]),
    {
      keys: Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((level) => [
          `Mod-Alt-${level}`,
          key(toggleNode(heading, paragraph, { level })),
        ])
      ),
    },
    rules(
      [1, 2, 3, 4, 5, 6].map((level) =>
        textblockRule(new RegExp(`^(#{1,${level}})\\s$`), heading, () => ({ level }))
      )
    ),
    { keys: { "Mod-Enter": key(setHardBreak), "Shift-Enter": key(setHardBreak) } },
    gapCursorPlugin(),
    { keys: { "Mod-e": key(toggleMark(marks.code as MarkType)) } },
    rules([{ find: codeMatch, handler: markRule(/$^/, marks.code as MarkType).handler }]),
    {
      keys: {
        "Mod-Shift-8": key(
          toggleList(nodes.bulletList as NodeType, nodes.listItem as NodeType, isList)
        ),
      },
    },
    rules([wrappingRule(/^\s*([-+*])\s$/, nodes.bulletList as NodeType)]),
    {
      keys: {
        "Mod-Shift-b": key(toggleWrap(nodes.blockquote as NodeType)),
        Backspace: blockquoteBackspace,
      },
    },
    rules([wrappingRule(/^\s*>\s$/, nodes.blockquote as NodeType)]),
    {
      keys: {
        "Mod-b": key(toggleMark(marks.bold as MarkType)),
        "Mod-B": key(toggleMark(marks.bold as MarkType)),
      },
    },
    rules([
      markRule(/(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/, marks.bold as MarkType),
      markRule(/(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))$/, marks.bold as MarkType),
    ]),
    options.base(anyRules),
  ]
}

/** Shift-Enter: out of a code block, else a line break, keeping the marks typed on. */
const setHardBreak: Command = first(exitCode, (tr) => {
  const { selection, storedMarks } = tr
  if (selection.$from.parent.type.spec.isolating) return false
  const marksBefore = storedMarks ?? (selection.$to.parentOffset ? selection.$from.marks() : null)
  insertContentAt(
    { from: selection.from, to: selection.to },
    (nodes.hardBreak as NodeType).create()
  )(tr)
  if (marksBefore) tr.ensureMarks(marksBefore)
  return true
})

/** The run of text around the caret carrying a link, for the toolbar's link field. */
export function linkRange(tr: Transaction): { from: number; to: number } | undefined {
  return getMarkRange(tr.selection.$from, marks.link as MarkType)
}

export { joinBackward, NodeSelection, first }
