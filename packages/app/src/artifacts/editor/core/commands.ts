// What keys and menus do to a document: split and join blocks, lift and wrap them, mark words,
// make and leave lists. A command adds its steps to a transaction and says whether it applied;
// one that does not apply leaves the transaction as it was. They do what ProseMirror's commands
// and TipTap's (both MIT) do.

import {
  type Attrs,
  type ContentMatch,
  Fragment,
  type Mark,
  type MarkType,
  type Node,
  NodeRange,
  type NodeType,
  type ResolvedPos,
  Slice,
} from "./model"
import { AllSelection, NodeSelection, Selection, TextSelection, type Transaction } from "./state"
import {
  canJoin,
  canSplit,
  findWrapping,
  liftTarget,
  ReplaceAroundStep,
  ReplaceStep,
  replaceStep,
  type TypeAfter,
} from "./transform"
import type { EditorView } from "./view"

export type Command = (tr: Transaction, view?: EditorView) => boolean

/** The first command that applies. */
export function first(...commands: readonly Command[]): Command {
  return (tr, view) => commands.some((command) => command(tr, view))
}

/** Runs a command on the view's state and dispatches what it changed. */
export function run(view: EditorView, command: Command): boolean {
  const tr = view.state.tr
  if (!command(tr, view)) return false
  if (tr.docChanged || tr.selectionSet || tr.storedMarksSet || tr.scrolled) view.dispatch(tr)
  return true
}

// ── Deleting and joining ────────────────────────────────────────────────

export const deleteSelection: Command = (tr) => {
  const selection = tr.selection
  if (selection.empty) return false
  const marks =
    selection instanceof TextSelection ? selection.$from.marksAcross(selection.$to) : null
  tr.deleteRange(selection.from, selection.to)
  if (!tr.selection.empty) tr.setSelection(Selection.near(tr.doc.resolve(tr.selection.from)))
  if (marks) tr.ensureMarks(marks)
  tr.scrollIntoView()
  return true
}

function atBlockStart(tr: Transaction, view?: EditorView): ResolvedPos | null {
  const selection = tr.selection
  const $cursor = selection instanceof TextSelection ? selection.$cursor : null
  if (!$cursor) return null
  if (
    view && tr.doc === view.state.doc ? !view.endOfTextblock("backward") : $cursor.parentOffset > 0
  )
    return null
  return $cursor
}

function atBlockEnd(tr: Transaction, view?: EditorView): ResolvedPos | null {
  const selection = tr.selection
  const $cursor = selection instanceof TextSelection ? selection.$cursor : null
  if (!$cursor) return null
  if (
    view && tr.doc === view.state.doc
      ? !view.endOfTextblock("forward")
      : $cursor.parentOffset < $cursor.parent.content.size
  )
    return null
  return $cursor
}

export function findCutBefore($pos: ResolvedPos): ResolvedPos | null {
  if (!$pos.parent.type.spec.isolating) {
    for (let depth = $pos.depth - 1; depth >= 0; depth -= 1) {
      if ($pos.index(depth) > 0) return $pos.doc.resolve($pos.before(depth + 1))
      if ($pos.node(depth).type.spec.isolating) break
    }
  }
  return null
}

export function findCutAfter($pos: ResolvedPos): ResolvedPos | null {
  if (!$pos.parent.type.spec.isolating) {
    for (let depth = $pos.depth - 1; depth >= 0; depth -= 1) {
      const parent = $pos.node(depth)
      if ($pos.index(depth) + 1 < parent.childCount) return $pos.doc.resolve($pos.after(depth + 1))
      if (parent.type.spec.isolating) break
    }
  }
  return null
}

function textblockAt(node: Node, side: "start" | "end", only = false): boolean {
  for (
    let scan: Node | null = node;
    scan;
    scan = side === "start" ? scan.firstChild : scan.lastChild
  ) {
    if (scan.isTextblock) return true
    if (only && scan.childCount !== 1) return false
  }
  return false
}

export const joinBackward: Command = (tr, view) => {
  const $cursor = atBlockStart(tr, view)
  if (!$cursor) return false
  const $cut = findCutBefore($cursor)
  if (!$cut) {
    const range = $cursor.blockRange()
    const target = range && liftTarget(range)
    if (!range || target === null || target === undefined) return false
    tr.lift(range, target).scrollIntoView()
    return true
  }
  const before = $cut.nodeBefore as Node
  if (deleteBarrier(tr, $cut, -1)) return true
  if (
    $cursor.parent.content.size === 0 &&
    (textblockAt(before, "end") || NodeSelection.isSelectable(before))
  ) {
    for (let depth = $cursor.depth; ; depth -= 1) {
      const step = replaceStep(tr.doc, $cursor.before(depth), $cursor.after(depth), Slice.empty)
      if (step instanceof ReplaceStep && step.slice.size < step.to - step.from) {
        tr.step(step)
        tr.setSelection(
          textblockAt(before, "end")
            ? (Selection.findFrom(tr.doc.resolve(tr.mapping.map($cut.pos, -1)), -1) as Selection)
            : NodeSelection.create(tr.doc, $cut.pos - before.nodeSize)
        )
        tr.scrollIntoView()
        return true
      }
      if (depth === 1 || $cursor.node(depth - 1).childCount > 1) break
    }
  }
  if (before.isAtom && $cut.depth === $cursor.depth - 1) {
    tr.delete($cut.pos - before.nodeSize, $cut.pos).scrollIntoView()
    return true
  }
  return false
}

export const joinForward: Command = (tr, view) => {
  const $cursor = atBlockEnd(tr, view)
  if (!$cursor) return false
  const $cut = findCutAfter($cursor)
  if (!$cut) return false
  const after = $cut.nodeAfter as Node
  if (deleteBarrier(tr, $cut, 1)) return true
  if (
    $cursor.parent.content.size === 0 &&
    (textblockAt(after, "start") || NodeSelection.isSelectable(after))
  ) {
    const step = replaceStep(tr.doc, $cursor.before(), $cursor.after(), Slice.empty)
    if (step instanceof ReplaceStep && step.slice.size < step.to - step.from) {
      tr.step(step)
      tr.setSelection(
        textblockAt(after, "start")
          ? (Selection.findFrom(tr.doc.resolve(tr.mapping.map($cut.pos)), 1) as Selection)
          : NodeSelection.create(tr.doc, tr.mapping.map($cut.pos))
      )
      tr.scrollIntoView()
      return true
    }
  }
  if (after.isAtom && $cut.depth === $cursor.depth - 1) {
    tr.delete($cut.pos, $cut.pos + after.nodeSize).scrollIntoView()
    return true
  }
  return false
}

export const selectNodeBackward: Command = (tr, view) => {
  const { $head, empty } = tr.selection
  if (!empty) return false
  let $cut: ResolvedPos | null = $head
  if ($head.parent.isTextblock) {
    if (
      view && tr.doc === view.state.doc ? !view.endOfTextblock("backward") : $head.parentOffset > 0
    )
      return false
    $cut = findCutBefore($head)
  }
  const node = $cut?.nodeBefore
  if (!$cut || !node || !NodeSelection.isSelectable(node)) return false
  tr.setSelection(NodeSelection.create(tr.doc, $cut.pos - node.nodeSize)).scrollIntoView()
  return true
}

export const selectNodeForward: Command = (tr, view) => {
  const { $head, empty } = tr.selection
  if (!empty) return false
  let $cut: ResolvedPos | null = $head
  if ($head.parent.isTextblock) {
    if (
      view && tr.doc === view.state.doc
        ? !view.endOfTextblock("forward")
        : $head.parentOffset < $head.parent.content.size
    )
      return false
    $cut = findCutAfter($head)
  }
  const node = $cut?.nodeAfter
  if (!$cut || !node || !NodeSelection.isSelectable(node)) return false
  tr.setSelection(NodeSelection.create(tr.doc, $cut.pos)).scrollIntoView()
  return true
}

function joinMaybeClear(tr: Transaction, $pos: ResolvedPos): boolean {
  const before = $pos.nodeBefore
  const after = $pos.nodeAfter
  const index = $pos.index()
  if (!before || !after || !before.type.compatibleContent(after.type)) return false
  if (!before.content.size && $pos.parent.canReplace(index - 1, index)) {
    tr.delete($pos.pos - before.nodeSize, $pos.pos).scrollIntoView()
    return true
  }
  if (
    !$pos.parent.canReplace(index, index + 1) ||
    !(after.isTextblock || canJoin(tr.doc, $pos.pos))
  )
    return false
  tr.join($pos.pos).scrollIntoView()
  return true
}

function deleteBarrier(tr: Transaction, $cut: ResolvedPos, dir: number): boolean {
  const before = $cut.nodeBefore as Node
  const after = $cut.nodeAfter as Node
  const isolated = before.type.spec.isolating || after.type.spec.isolating
  if (!isolated && joinMaybeClear(tr, $cut)) return true
  const canDelAfter = !isolated && $cut.parent.canReplace($cut.index(), $cut.index() + 1)
  const match = before.contentMatchAt(before.childCount)
  const conn = canDelAfter ? match.findWrapping(after.type) : null
  if (
    canDelAfter &&
    conn &&
    (match.matchType((conn[0] ?? after.type) as NodeType) as ContentMatch | null)?.validEnd
  ) {
    const end = $cut.pos + after.nodeSize
    let wrap = Fragment.empty
    for (let index = conn.length - 1; index >= 0; index -= 1)
      wrap = Fragment.from((conn[index] as NodeType).create(null, wrap))
    wrap = Fragment.from(before.copy(wrap))
    tr.step(
      new ReplaceAroundStep(
        $cut.pos - 1,
        end,
        $cut.pos,
        end,
        new Slice(wrap, 1, 0),
        conn.length,
        true
      )
    )
    const $joinAt = tr.doc.resolve(end + 2 * conn.length)
    if ($joinAt.nodeAfter && $joinAt.nodeAfter.type === before.type && canJoin(tr.doc, $joinAt.pos))
      tr.join($joinAt.pos)
    tr.scrollIntoView()
    return true
  }
  const selectionAfter =
    after.type.spec.isolating || (dir > 0 && isolated) ? null : Selection.findFrom($cut, 1)
  const range = selectionAfter?.$from.blockRange(selectionAfter.$to)
  const target = range ? liftTarget(range) : null
  if (range && target !== null && target >= $cut.depth) {
    tr.lift(range, target).scrollIntoView()
    return true
  }
  if (canDelAfter && textblockAt(after, "start", true) && textblockAt(before, "end")) {
    let at = before
    const wrap: Node[] = []
    for (;;) {
      wrap.push(at)
      if (at.isTextblock) break
      at = at.lastChild as Node
    }
    let afterText = after
    let afterDepth = 1
    for (; !afterText.isTextblock; afterText = afterText.firstChild as Node) afterDepth += 1
    if (at.canReplace(at.childCount, at.childCount, afterText.content)) {
      let end = Fragment.empty
      for (let index = wrap.length - 1; index >= 0; index -= 1)
        end = Fragment.from((wrap[index] as Node).copy(end))
      tr.step(
        new ReplaceAroundStep(
          $cut.pos - wrap.length,
          $cut.pos + after.nodeSize,
          $cut.pos + afterDepth,
          $cut.pos + after.nodeSize - afterDepth,
          new Slice(end, wrap.length, 0),
          0,
          true
        )
      )
      tr.scrollIntoView()
      return true
    }
  }
  return false
}

/** Deletes the empty block the caret is in, when it is the only kind there. */
export const deleteCurrentNode: Command = (tr) => {
  const current = tr.selection.$anchor.node()
  if (current.content.size > 0) return false
  const $pos = tr.selection.$anchor
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type === current.type) {
      tr.delete($pos.before(depth), $pos.after(depth)).scrollIntoView()
      return true
    }
  }
  return false
}

// ── Splitting, lifting, wrapping ────────────────────────────────────────

export const lift: Command = (tr) => {
  const { $from, $to } = tr.selection
  const range = $from.blockRange($to)
  const target = range && liftTarget(range)
  if (!range || target === null || target === undefined) return false
  tr.lift(range, target).scrollIntoView()
  return true
}

export const newlineInCode: Command = (tr) => {
  const { $head, $anchor } = tr.selection
  if (!$head.parent.type.spec.code || !$head.sameParent($anchor)) return false
  tr.insertText("\n").scrollIntoView()
  return true
}

export function defaultBlockAt(match: ContentMatch): NodeType | null {
  for (let index = 0; index < match.edgeCount; index += 1) {
    const { type } = match.edge(index)
    if (type.isTextblock) return type
  }
  return null
}

export const exitCode: Command = (tr) => {
  const { $head, $anchor } = tr.selection
  if (!$head.parent.type.spec.code || !$head.sameParent($anchor)) return false
  const above = $head.node(-1)
  const after = $head.indexAfter(-1)
  const type = defaultBlockAt(above.contentMatchAt(after))
  if (!type || !above.canReplaceWith(after, after, type)) return false
  const pos = $head.after()
  tr.replaceWith(pos, pos, type.createAndFill() as Node)
  tr.setSelection(Selection.near(tr.doc.resolve(pos), 1)).scrollIntoView()
  return true
}

export const createParagraphNear: Command = (tr) => {
  const selection = tr.selection
  const { $from, $to } = selection
  if (selection instanceof AllSelection || $from.parent.inlineContent || $to.parent.inlineContent)
    return false
  const type = defaultBlockAt($to.parent.contentMatchAt($to.indexAfter()))
  if (!type?.isTextblock) return false
  const side = (!$from.parentOffset && $to.index() < $to.parent.childCount ? $from : $to).pos
  tr.insert(side, type.createAndFill() as Node)
  tr.setSelection(TextSelection.create(tr.doc, side + 1)).scrollIntoView()
  return true
}

export const liftEmptyBlock: Command = (tr) => {
  const selection = tr.selection
  const $cursor = selection instanceof TextSelection ? selection.$cursor : null
  if (!$cursor || $cursor.parent.content.size) return false
  if ($cursor.depth > 1 && $cursor.after() !== $cursor.end(-1)) {
    const before = $cursor.before()
    if (canSplit(tr.doc, before)) {
      tr.split(before).scrollIntoView()
      return true
    }
  }
  const range = $cursor.blockRange()
  const target = range && liftTarget(range)
  if (!range || target === null || target === undefined) return false
  tr.lift(range, target).scrollIntoView()
  return true
}

/** Attributes a node keeps when Enter splits it: none of ours carry over. */
function splitAttributes(_node: Node): Attrs {
  return {}
}

/** Enter in a textblock: the words after the caret move to a new block; marks typed on carry on. */
export const splitBlock: Command = (tr) => {
  const selection = tr.selection
  const { $from, $to } = selection
  const storedMarks = tr.storedMarks
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    if (!$from.parentOffset || !canSplit(tr.doc, $from.pos)) return false
    keepMarks(tr, storedMarks, selection)
    tr.split($from.pos).scrollIntoView()
    return true
  }
  if (!$from.parent.isBlock) return false
  const atEnd = $to.parentOffset === $to.parent.content.size
  const deflt =
    $from.depth === 0 ? null : defaultBlockAt($from.node(-1).contentMatchAt($from.indexAfter(-1)))
  const newAttrs = splitAttributes($from.node())
  let types: TypeAfter[] | undefined =
    atEnd && deflt ? [{ type: deflt, attrs: newAttrs }] : undefined
  const deletes = selection instanceof TextSelection && !selection.empty
  let splitDoc = tr.doc
  let splitPos = $from.pos
  if (deletes) {
    const scratch = cloneTransaction(tr)
    const before = scratch.steps.length
    scratch.deleteSelection()
    splitDoc = scratch.doc
    splitPos = scratch.mapping.slice(before).map($from.pos)
  }
  let can = canSplit(splitDoc, splitPos, 1, types)
  if (!types && !can && canSplit(splitDoc, splitPos, 1, deflt ? [{ type: deflt }] : undefined)) {
    can = true
    types = deflt ? [{ type: deflt, attrs: newAttrs }] : undefined
  }
  if (can) {
    const mapFrom = tr.steps.length
    if (selection instanceof TextSelection) tr.deleteSelection()
    tr.split(tr.mapping.slice(mapFrom).map($from.pos), 1, types)
    if (deflt && !atEnd && !$from.parentOffset && $from.parent.type !== deflt) {
      const firstPos = tr.mapping.slice(mapFrom).map($from.before())
      const $first = tr.doc.resolve(firstPos)
      if ($from.node(-1).canReplaceWith($first.index(), $first.index() + 1, deflt)) {
        tr.setNodeMarkup(tr.mapping.slice(mapFrom).map($from.before()), deflt)
      }
    }
  }
  keepMarks(tr, storedMarks, selection)
  tr.scrollIntoView()
  return can
}

/** The marks typing would take before a split, kept for the text typed after it. */
function keepMarks(
  tr: Transaction,
  storedMarks: readonly Mark[] | null,
  selection: Selection
): void {
  const marks = storedMarks ?? (selection.$to.parentOffset ? selection.$from.marks() : null)
  if (marks) tr.ensureMarks(marks)
}

export const selectAll: Command = (tr) => {
  tr.setSelection(new AllSelection(tr.doc))
  return true
}

function selectTextblockSide(side: number): Command {
  return (tr) => {
    const selection = tr.selection
    const $pos = side < 0 ? selection.$from : selection.$to
    let depth = $pos.depth
    while ($pos.node(depth).isInline) {
      if (!depth) return false
      depth -= 1
    }
    if (!$pos.node(depth).isTextblock) return false
    tr.setSelection(TextSelection.create(tr.doc, side < 0 ? $pos.start(depth) : $pos.end(depth)))
    return true
  }
}

export const selectTextblockStart = selectTextblockSide(-1)
export const selectTextblockEnd = selectTextblockSide(1)

export function wrapIn(type: NodeType, attrs: Attrs | null = null): Command {
  return (tr) => {
    const { $from, $to } = tr.selection
    const range = $from.blockRange($to)
    const wrapping = range && findWrapping(range, type, attrs)
    if (!range || !wrapping) return false
    tr.wrap(range, wrapping).scrollIntoView()
    return true
  }
}

export function setBlockType(type: NodeType, attrs: Attrs | null = null): Command {
  return (tr) => {
    const { from, to } = tr.selection
    let applicable = false
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (applicable) return false
      if (!node.isTextblock || node.hasMarkup(type, type.computeAttrs(attrs))) return true
      if (node.type === type) {
        applicable = true
      } else {
        const $pos = tr.doc.resolve(pos)
        const index = $pos.index()
        applicable = $pos.parent.canReplaceWith(index, index + 1, type)
      }
      return true
    })
    if (!applicable) return false
    tr.setBlockType(from, to, type, attrs).scrollIntoView()
    return true
  }
}

/** Lifts every block in the selection out of what wraps it, and makes textblocks the default kind. */
export const clearNodes: Command = (tr) => {
  const { from, to } = tr.selection
  const startMaps = tr.mapping.maps.length
  let sweeps = 1
  tr.doc.nodesBetween(from, to, (_node, pos) => {
    sweeps = Math.max(sweeps, tr.doc.resolve(pos).depth + 1)
    return true
  })
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const before = tr.doc
    const sweepMaps = tr.mapping.maps.length
    const rangeMapping = tr.mapping.slice(startMaps)
    before.nodesBetween(rangeMapping.map(from), rangeMapping.map(to), (node, pos) => {
      if (node.type.isText) return true
      const sweepMapping = tr.mapping.slice(sweepMaps)
      const $mappedFrom = tr.doc.resolve(sweepMapping.map(pos))
      const $mappedTo = tr.doc.resolve(sweepMapping.map(pos + node.nodeSize))
      const range = $mappedFrom.blockRange($mappedTo)
      if (!range) return true
      const target = liftTarget(range)
      if (node.type.isTextblock) {
        const { defaultType } = $mappedFrom.parent.contentMatchAt($mappedFrom.index())
        const at = tr.doc.nodeAt(range.start)
        if (
          defaultType &&
          at &&
          !at.hasMarkup(defaultType) &&
          defaultType.validContent(at.content)
        ) {
          tr.setNodeMarkup(range.start, defaultType)
        }
      }
      if (target !== null) tr.lift(range, target)
      return true
    })
    if (tr.doc.eq(before)) break
  }
  return true
}

/** Makes the selection's textblocks of `type`, lifting them out of what wraps them if they must. */
export function setNode(type: NodeType, attrs: Attrs = {}): Command {
  return (tr) => {
    if (!type.isTextblock) return false
    const { $anchor, $head } = tr.selection
    const wanted = { ...($anchor.sameParent($head) ? $anchor.parent.attrs : {}), ...attrs }
    if (!setBlockType(type, wanted)(cloneTransaction(tr))) clearNodes(tr)
    return setBlockType(type, wanted)(tr)
  }
}

/** A transaction holding what `tr` holds, to try a command on without changing `tr`. */
export function cloneTransaction(tr: Transaction): Transaction {
  const copy = tr.state.tr
  for (const step of tr.steps) copy.step(step)
  if (tr.selectionSet) copy.setSelection(tr.selection)
  return copy
}

export function toggleNode(type: NodeType, toggleType: NodeType, attrs: Attrs = {}): Command {
  return (tr) => {
    const active = isNodeActive(tr, type, attrs)
    const { $anchor, $head } = tr.selection
    const copied = $anchor.sameParent($head) ? $anchor.parent.attrs : {}
    if (active) return setNode(toggleType, copied)(tr)
    return setNode(type, { ...copied, ...attrs })(tr)
  }
}

export function toggleWrap(type: NodeType, attrs: Attrs = {}): Command {
  return (tr) => (isNodeActive(tr, type, attrs) ? liftOf(type, attrs)(tr) : wrapIn(type, attrs)(tr))
}

function liftOf(type: NodeType, attrs: Attrs = {}): Command {
  return (tr) => isNodeActive(tr, type, attrs) && lift(tr)
}

// ── Lists ───────────────────────────────────────────────────────────────

/** Enter in a list item: a new item, or, in an empty last one, out of the list it ends. */
export function splitListItem(type: NodeType): Command {
  return (tr) => {
    const selection = tr.selection
    const { $from, $to } = selection
    const node = selection instanceof NodeSelection ? selection.node : null
    if (node?.isBlock || $from.depth < 2 || !$from.sameParent($to)) return false
    const grandParent = $from.node(-1)
    if (grandParent.type !== type) return false
    if ($from.parent.content.size === 0 && $from.node(-1).childCount === $from.indexAfter(-1)) {
      if (
        $from.depth === 2 ||
        $from.node(-3).type !== type ||
        $from.index(-2) !== $from.node(-2).childCount - 1
      )
        return false
      let wrap = Fragment.empty
      const depthBefore = $from.index(-1) ? 1 : $from.index(-2) ? 2 : 3
      for (let depth = $from.depth - depthBefore; depth >= $from.depth - 3; depth -= 1)
        wrap = Fragment.from($from.node(depth).copy(wrap))
      const depthAfter =
        $from.indexAfter(-1) < $from.node(-2).childCount
          ? 1
          : $from.indexAfter(-2) < $from.node(-3).childCount
            ? 2
            : 3
      const nextType =
        type.contentMatch.defaultType?.createAndFill(splitAttributes($from.node())) ?? undefined
      wrap = wrap.append(Fragment.from(type.createAndFill(null, nextType) ?? undefined))
      const start = $from.before($from.depth - (depthBefore - 1))
      tr.replace(start, $from.after(-depthAfter), new Slice(wrap, 4 - depthBefore, 0))
      let sel = -1
      tr.doc.nodesBetween(start, tr.doc.content.size, (each, pos) => {
        if (sel > -1) return false
        if (each.isTextblock && each.content.size === 0) sel = pos + 1
        return true
      })
      if (sel > -1) tr.setSelection(Selection.near(tr.doc.resolve(sel)))
      tr.scrollIntoView()
      return true
    }
    const nextType = $to.pos === $from.end() ? grandParent.contentMatchAt(0).defaultType : null
    const itemAttrs = withoutUnsplittable(grandParent)
    const splitsAtStart = $from.parentOffset === 0 && $from.index(-1) === 0
    const itemStart = $from.before(-1)
    const storedMarks = tr.storedMarks
    const scratch = cloneTransaction(tr)
    scratch.delete($from.pos, $to.pos)
    if (!canSplit(scratch.doc, $from.pos, 2)) return false
    tr.delete($from.pos, $to.pos)
    const trailing = splitsAtStart ? grandParent.attrs : itemAttrs
    const types: TypeAfter[] = nextType
      ? [
          { type, attrs: trailing },
          { type: nextType, attrs: {} },
        ]
      : [{ type, attrs: trailing }]
    tr.split($from.pos, 2, types).scrollIntoView()
    if (splitsAtStart) tr.setNodeMarkup(itemStart, undefined, itemAttrs)
    const marks = storedMarks ?? (selection.$to.parentOffset ? selection.$from.marks() : null)
    if (marks) tr.ensureMarks(marks)
    return true
  }
}

/** A list item's attributes for the item a split makes: a to-do starts unchecked. */
function withoutUnsplittable(item: Node): Attrs {
  return "checked" in item.attrs ? { ...item.attrs, checked: false } : item.attrs
}

function isItem(type: NodeType, node: Node | null | undefined): boolean {
  return !!node && node.type === type
}

export function liftListItem(type: NodeType): Command {
  return (tr) => {
    const { $from, $to } = tr.selection
    const range = $from.blockRange(
      $to,
      (node) => node.childCount > 0 && isItem(type, node.firstChild)
    )
    if (!range) return false
    if (isItem(type, $from.node(range.depth - 1))) return liftToOuterList(tr, range)
    return liftOutOfList(tr, range)
  }
}

function liftToOuterList(tr: Transaction, start: NodeRange): boolean {
  let range = start
  const end = range.end
  const endOfList = range.$to.end(range.depth)
  const itemType = range.parent.child(range.endIndex - 1).type
  const scratch = cloneTransaction(tr)
  if (end < endOfList) {
    scratch.step(
      new ReplaceAroundStep(
        end - 1,
        endOfList,
        end,
        endOfList,
        new Slice(Fragment.from(itemType.create(null, range.parent.copy())), 1, 0),
        1,
        true
      )
    )
    range = new NodeRange(
      scratch.doc.resolve(range.$from.pos),
      scratch.doc.resolve(endOfList),
      range.depth
    )
  }
  const target = liftTarget(range)
  if (target === null) return false
  for (const step of scratch.steps.slice(tr.steps.length)) tr.step(step)
  tr.lift(range, target)
  const $after = tr.doc.resolve(tr.mapping.map(end, -1) - 1)
  if (canJoin(tr.doc, $after.pos) && $after.nodeBefore?.type === $after.nodeAfter?.type)
    tr.join($after.pos)
  tr.scrollIntoView()
  return true
}

function liftOutOfList(tr: Transaction, range: NodeRange): boolean {
  const scratch = cloneTransaction(tr)
  const list = range.parent
  for (
    let pos = range.end, index = range.endIndex - 1, end = range.startIndex;
    index > end;
    index -= 1
  ) {
    pos -= list.child(index).nodeSize
    scratch.delete(pos - 1, pos + 1)
  }
  const $start = scratch.doc.resolve(range.start)
  const item = $start.nodeAfter as Node
  if (scratch.mapping.slice(tr.steps.length).map(range.end) !== range.start + item.nodeSize)
    return false
  const atStart = range.startIndex === 0
  const atEnd = range.endIndex === list.childCount
  const parent = $start.node(-1)
  const indexBefore = $start.index(-1)
  if (
    !parent.canReplace(
      indexBefore + (atStart ? 0 : 1),
      indexBefore + 1,
      item.content.append(atEnd ? Fragment.empty : Fragment.from(list))
    )
  ) {
    return false
  }
  const startPos = $start.pos
  const endPos = startPos + item.nodeSize
  scratch.step(
    new ReplaceAroundStep(
      startPos - (atStart ? 1 : 0),
      endPos + (atEnd ? 1 : 0),
      startPos + 1,
      endPos - 1,
      new Slice(
        (atStart ? Fragment.empty : Fragment.from(list.copy(Fragment.empty))).append(
          atEnd ? Fragment.empty : Fragment.from(list.copy(Fragment.empty))
        ),
        atStart ? 0 : 1,
        atEnd ? 0 : 1
      ),
      atStart ? 0 : 1
    )
  )
  for (const step of scratch.steps.slice(tr.steps.length)) tr.step(step)
  tr.scrollIntoView()
  return true
}

export function sinkListItem(type: NodeType): Command {
  return (tr) => {
    const { $from, $to } = tr.selection
    const range = $from.blockRange(
      $to,
      (node) => node.childCount > 0 && isItem(type, node.firstChild)
    )
    if (!range) return false
    const startIndex = range.startIndex
    if (startIndex === 0) return false
    const parent = range.parent
    const nodeBefore = parent.child(startIndex - 1)
    if (!isItem(type, nodeBefore)) return false
    const nestedBefore = !!nodeBefore.lastChild && nodeBefore.lastChild.type === parent.type
    const inner = Fragment.from(
      nestedBefore ? (nodeBefore.lastChild?.lastChild?.type.create() ?? null) : null
    )
    const slice = new Slice(
      Fragment.from(nodeBefore.type.create(null, Fragment.from(parent.type.create(null, inner)))),
      nestedBefore ? 3 : 1,
      0
    )
    const before = range.start
    const after = range.end
    tr.step(
      new ReplaceAroundStep(before - (nestedBefore ? 3 : 1), after, before, after, slice, 1, true)
    ).scrollIntoView()
    return true
  }
}

export function wrapInList(listType: NodeType, attrs: Attrs | null = null): Command {
  return (tr) => {
    const { $from, $to } = tr.selection
    let range = $from.blockRange($to)
    if (!range) return false
    let doJoin = false
    let outerRange = range
    const doc = range.$from.doc
    if (
      range.depth >= 2 &&
      range.$from.node(range.depth - 1).type.compatibleContent(listType) &&
      range.startIndex === 0
    ) {
      if (range.$from.index(range.depth - 1) === 0) return false
      const $insert = doc.resolve(range.start - 2)
      outerRange = new NodeRange($insert, $insert, range.depth)
      if (range.endIndex < range.parent.childCount)
        range = new NodeRange(range.$from, doc.resolve(range.$to.end(range.depth)), range.depth)
      doJoin = true
    }
    const wrap = findWrapping(outerRange, listType, attrs, range)
    if (!wrap) return false
    let content = Fragment.empty
    for (let index = wrap.length - 1; index >= 0; index -= 1) {
      const wrapper = wrap[index] as { type: NodeType; attrs: Attrs | null }
      content = Fragment.from(wrapper.type.create(wrapper.attrs, content))
    }
    tr.step(
      new ReplaceAroundStep(
        range.start - (doJoin ? 2 : 0),
        range.end,
        range.start,
        range.end,
        new Slice(content, 0, 0),
        wrap.length,
        true
      )
    )
    let found = 0
    wrap.forEach((wrapper, index) => {
      if (wrapper.type === listType) found = index + 1
    })
    const splitDepth = wrap.length - found
    let splitPos = range.start + wrap.length - (doJoin ? 2 : 0)
    const parent = range.parent
    for (
      let index = range.startIndex, end = range.endIndex, isFirst = true;
      index < end;
      index += 1, isFirst = false
    ) {
      if (!isFirst && splitDepth && canSplit(tr.doc, splitPos, splitDepth)) {
        tr.split(splitPos, splitDepth)
        splitPos += 2 * splitDepth
      }
      splitPos += parent.child(index).nodeSize
    }
    tr.scrollIntoView()
    return true
  }
}

/** Turns the selection's blocks into a list, another kind of list, or out of the list they are in. */
export function toggleList(
  listType: NodeType,
  itemType: NodeType,
  isList: (type: NodeType) => boolean
): Command {
  return (tr) => {
    const selection = tr.selection
    const { $from, $to } = selection
    const range = $from.blockRange($to)
    if (!range) return false
    const parentList = findParentNode(selection.$from, (node) => isList(node.type))
    const inside = !!parentList && range.depth >= 1 && range.depth - parentList.depth <= 1
    if (inside && parentList) {
      if (parentList.node.type === listType) return liftListItem(itemType)(tr)
      if (listType.validContent(parentList.node.content)) {
        tr.setNodeMarkup(parentList.pos, listType)
        joinListBackwards(tr, listType)
        joinListForwards(tr, listType)
        return true
      }
      // Another kind of list with other items: each item becomes one of ours.
      const items: Node[] = []
      parentList.node.forEach((item) => {
        items.push(itemType.create(null, item.content))
      })
      const content = Fragment.from(items)
      if (!listType.validContent(content)) return false
      const { $anchor, $head } = tr.selection
      const offsets = { anchor: $anchor.pos - parentList.pos, head: $head.pos - parentList.pos }
      tr.replaceWith(
        parentList.pos,
        parentList.pos + parentList.node.nodeSize,
        listType.create(null, content)
      )
      const size = tr.doc.content.size
      tr.setSelection(
        TextSelection.create(
          tr.doc,
          Math.min(parentList.pos + offsets.anchor, size),
          Math.min(parentList.pos + offsets.head, size)
        )
      )
      joinListBackwards(tr, listType)
      joinListForwards(tr, listType)
      return true
    }
    if (!wrapInList(listType)(cloneTransaction(tr))) clearNodes(tr)
    if (!wrapInList(listType)(tr)) return false
    joinListBackwards(tr, listType)
    joinListForwards(tr, listType)
    return true
  }
}

function joinListBackwards(tr: Transaction, listType: NodeType): boolean {
  const list = findParentNode(tr.selection.$from, (node) => node.type === listType)
  if (!list) return true
  const before = tr.doc.resolve(Math.max(0, list.pos - 1)).before(list.depth)
  if (before === undefined) return true
  const nodeBefore = tr.doc.nodeAt(before)
  if (list.node.type === nodeBefore?.type && canJoin(tr.doc, list.pos)) tr.join(list.pos)
  return true
}

function joinListForwards(tr: Transaction, listType: NodeType): boolean {
  const list = findParentNode(tr.selection.$from, (node) => node.type === listType)
  if (!list) return true
  const after = tr.doc.resolve(list.start).after(list.depth)
  if (after === undefined) return true
  const nodeAfter = tr.doc.nodeAt(after)
  if (list.node.type === nodeAfter?.type && canJoin(tr.doc, after)) tr.join(after)
  return true
}

export function findParentNode(
  $pos: ResolvedPos,
  predicate: (node: Node) => boolean
): { pos: number; start: number; depth: number; node: Node } | undefined {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (predicate(node))
      return { pos: depth > 0 ? $pos.before(depth) : 0, start: $pos.start(depth), depth, node }
  }
  return undefined
}

// ── Marks ───────────────────────────────────────────────────────────────

function attrsInclude(attrs: Attrs, wanted: Attrs): boolean {
  return Object.entries(wanted).every(([key, value]) => attrs[key] === value)
}

export function isNodeActive(tr: Transaction, type: NodeType | null, attrs: Attrs = {}): boolean {
  const { from, to, empty } = tr.selection
  const ranges: { node: Node; from: number; to: number }[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) return true
    ranges.push({ node, from: Math.max(from, pos), to: Math.min(to, pos + node.nodeSize) })
    return true
  })
  const matched = ranges.filter(
    (range) => (!type || range.node.type === type) && attrsInclude(range.node.attrs, attrs)
  )
  if (empty) return matched.length > 0
  return matched.reduce((sum, range) => sum + range.to - range.from, 0) >= to - from
}

export function isMarkActive(tr: Transaction, type: MarkType | null, attrs: Attrs = {}): boolean {
  const { empty, from, to } = tr.selection
  if (empty) {
    return (tr.storedMarks ?? tr.selection.$from.marks()).some(
      (mark) => (!type || mark.type === type) && attrsInclude(mark.attrs, attrs)
    )
  }
  let selectionRange = 0
  const markRanges: { mark: Mark; from: number; to: number }[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (type && node.inlineContent && !node.type.allowsMarkType(type)) return false
    if (!node.isText && !node.marks.length) return true
    const rangeFrom = Math.max(from, pos)
    const rangeTo = Math.min(to, pos + node.nodeSize)
    selectionRange += rangeTo - rangeFrom
    for (const mark of node.marks) markRanges.push({ mark, from: rangeFrom, to: rangeTo })
    return true
  })
  if (selectionRange === 0) return false
  const matched = markRanges
    .filter((range) => (!type || range.mark.type === type) && attrsInclude(range.mark.attrs, attrs))
    .reduce((sum, range) => sum + range.to - range.from, 0)
  const excluded = markRanges
    .filter((range) => !type || (range.mark.type !== type && range.mark.type.excludes(type)))
    .reduce((sum, range) => sum + range.to - range.from, 0)
  const range = matched > 0 ? matched + excluded : matched
  return range >= selectionRange
}

/** The run of text around `$pos` carrying a mark of `type`. */
export function getMarkRange(
  $pos: ResolvedPos,
  type: MarkType,
  attrs?: Attrs
): { from: number; to: number } | undefined {
  let start = $pos.parent.childAfter($pos.parentOffset)
  if (!start.node?.marks.some((mark) => mark.type === type))
    start = $pos.parent.childBefore($pos.parentOffset)
  if (!start.node?.marks.some((mark) => mark.type === type)) return undefined
  const wanted = attrs ?? start.node.marks.find((mark) => mark.type === type)?.attrs ?? {}
  const has = (node: Node) =>
    node.marks.some(
      (mark) =>
        mark.type === type &&
        attrsInclude(
          Object.fromEntries(Object.keys(wanted).map((key) => [key, mark.attrs[key]])),
          wanted
        )
    )
  if (!has(start.node)) return undefined
  let startIndex = start.index
  let startPos = $pos.start() + start.offset
  let endIndex = startIndex + 1
  let endPos = startPos + start.node.nodeSize
  while (startIndex > 0 && has($pos.parent.child(startIndex - 1))) {
    startIndex -= 1
    startPos -= $pos.parent.child(startIndex).nodeSize
  }
  while (endIndex < $pos.parent.childCount && has($pos.parent.child(endIndex))) {
    endPos += $pos.parent.child(endIndex).nodeSize
    endIndex += 1
  }
  return { from: startPos, to: endPos }
}

export function getMarkAttributes(tr: Transaction, type: MarkType): Attrs {
  const { from, to, empty } = tr.selection
  const marks: Mark[] = []
  if (empty) {
    if (tr.storedMarks) marks.push(...tr.storedMarks)
    marks.push(...tr.selection.$head.marks())
  } else {
    tr.doc.nodesBetween(from, to, (node) => {
      marks.push(...node.marks)
      return true
    })
  }
  const mark = marks.find((each) => each.type === type)
  return mark ? { ...mark.attrs } : {}
}

function canSetMark(tr: Transaction, storedMarks: readonly Mark[] | null, type: MarkType): boolean {
  const selection = tr.selection
  const cursor = selection instanceof TextSelection ? selection.$cursor : null
  if (cursor) {
    const current = storedMarks ?? cursor.marks()
    return (
      cursor.parent.type.allowsMarkType(type) &&
      (!!type.isInSet(current) || !current.some((mark) => mark.type.excludes(type)))
    )
  }
  const { $from, $to } = selection
  let supported =
    $from.depth === 0 ? tr.doc.inlineContent && tr.doc.type.allowsMarkType(type) : false
  tr.doc.nodesBetween($from.pos, $to.pos, (node, _pos, parent) => {
    if (supported) return false
    if (node.isInline) {
      const parentAllows = !parent || parent.type.allowsMarkType(type)
      const marksAllow =
        !!type.isInSet(node.marks) || !node.marks.some((mark) => mark.type.excludes(type))
      supported = parentAllows && marksAllow
    }
    return !supported
  })
  return supported
}

export function setMark(type: MarkType, attrs: Attrs = {}): Command {
  return (tr) => {
    const selection = tr.selection
    const storedMarks = tr.storedMarks
    const can = canSetMark(tr, storedMarks, type)
    if (selection.empty) {
      tr.addStoredMark(type.create({ ...getMarkAttributes(tr, type), ...attrs }))
    } else {
      const { from, to } = selection
      const doc = tr.doc
      doc.nodesBetween(from, to, (node, pos) => {
        const start = Math.max(pos, from)
        const end = Math.min(pos + node.nodeSize, to)
        const existing = node.marks.filter((mark) => mark.type === type)
        if (existing.length)
          for (const mark of existing)
            tr.addMark(start, end, type.create({ ...mark.attrs, ...attrs }))
        else tr.addMark(start, end, type.create(attrs))
        return true
      })
    }
    return can
  }
}

export function unsetMark(
  type: MarkType,
  options: { extendEmptyMarkRange?: boolean } = {}
): Command {
  return (tr) => {
    const selection = tr.selection
    const { $from, empty } = selection
    if (empty && options.extendEmptyMarkRange) {
      let { from, to } = selection
      const attrs = $from.marks().find((mark) => mark.type === type)?.attrs
      const range = getMarkRange($from, type, attrs)
      if (range) {
        from = range.from
        to = range.to
      }
      tr.removeMark(from, to, type)
    } else {
      tr.removeMark(selection.from, selection.to, type)
    }
    tr.removeStoredMark(type)
    return true
  }
}

export function toggleMark(
  type: MarkType,
  attrs: Attrs = {},
  options: { extendEmptyMarkRange?: boolean } = {}
): Command {
  return (tr) =>
    isMarkActive(tr, type, attrs) ? unsetMark(type, options)(tr) : setMark(type, attrs)(tr)
}

/** Selects the whole run of text carrying a mark of `type` around the caret. */
export function extendMarkRange(type: MarkType, attrs?: Attrs): Command {
  return (tr) => {
    const { $from, from, to } = tr.selection
    const range = getMarkRange($from, type, attrs)
    if (range && range.from <= from && range.to >= to)
      tr.setSelection(TextSelection.create(tr.doc, range.from, range.to))
    return true
  }
}

// ── Inserting ───────────────────────────────────────────────────────────

/** Sets the caret, or selects text, clamped to the document. */
export function setTextSelection(from: number, to = from): Command {
  return (tr) => {
    const size = tr.doc.content.size
    const clamp = (pos: number) => Math.min(Math.max(pos, 0), size)
    const selection = TextSelection.between(tr.doc.resolve(clamp(from)), tr.doc.resolve(clamp(to)))
    tr.setSelection(selection)
    return true
  }
}

/** Inserts nodes, or text, at a position or over a range, the caret after them. */
export function insertContentAt(
  position: number | { from: number; to: number },
  content: Node | Fragment | readonly Node[] | string
): Command {
  return (tr) => {
    let { from, to } = typeof position === "number" ? { from: position, to: position } : position
    const nodes: readonly Node[] =
      typeof content === "string"
        ? content
          ? [tr.doc.type.schema.textNode(content)]
          : []
        : content instanceof Fragment
          ? content.content
          : Array.isArray(content)
            ? content
            : [content as Node]
    let onlyText = true
    let onlyBlocks = true
    for (const node of nodes) {
      onlyText = onlyText ? node.isText && node.marks.length === 0 : false
      onlyBlocks = onlyBlocks ? node.isBlock : false
    }
    if (from === to && onlyBlocks) {
      const { parent } = tr.doc.resolve(from)
      if (parent.isTextblock && !parent.type.spec.code && !parent.childCount) {
        from -= 1
        to += 1
      }
    }
    if (onlyText) {
      tr.insertText(nodes.map((node) => node.text ?? "").join(""), from, to)
    } else {
      const $from = tr.doc.resolve(from)
      const node = $from.node()
      if (
        $from.parentOffset === 0 &&
        (node.isText || node.isTextblock) &&
        node.content.size > 0 &&
        onlyBlocks
      )
        from = Math.max(0, from - 1)
      tr.replaceWith(from, to, nodes)
    }
    selectionToInsertionEnd(tr, tr.steps.length - 1, -1)
    return true
  }
}

function selectionToInsertionEnd(tr: Transaction, startLength: number, bias: number): void {
  const last = tr.steps.length - 1
  if (last < startLength) return
  const step = tr.steps[last]
  if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return
  let end = 0
  tr.mapping.maps[last]?.forEach((_from, _to, _newFrom, newTo) => {
    if (end === 0) end = newTo
  })
  tr.setSelection(Selection.near(tr.doc.resolve(end), bias))
}

/** Puts the caret at a position, or at the start or end, where the editor will take focus. */
export function focusAt(position: number | "start" | "end" | null): Command {
  return (tr) => {
    if (position === null) return true
    const doc = tr.doc
    const selection =
      position === "start"
        ? Selection.atStart(doc)
        : position === "end"
          ? Selection.atEnd(doc)
          : TextSelection.near(doc.resolve(Math.min(Math.max(position, 0), doc.content.size)))
    tr.setSelection(selection)
    return true
  }
}
