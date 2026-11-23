// Where a selection's end goes when someone else's change moves the block it was in: its Yjs
// position may resolve to nothing, to the document's start, or into another block that took the
// moved one's place. The block is then found again by what it reads and what it is, and the end
// put at the same place in it; where that is ambiguous, the Yjs position stands. As
// y-prosemirror's selection recovery (MIT) does it.

import type { Attrs, Node } from "./model"

/** Where the end at `oldAbs` in `oldDoc` belongs in `newDoc`, given where its Yjs position put it. */
export function recoverSelectionEndpoint(
  newDoc: Node,
  oldDoc: Node,
  oldAbs: number,
  resolved: number | null
): number | null {
  if (oldAbs < 0 || oldAbs > oldDoc.content.size) return resolved
  const suspect =
    resolved === null ||
    (oldAbs > 1 && resolved <= 1) ||
    isMisresolved(oldDoc, newDoc, oldAbs, resolved)
  if (!suspect) return resolved
  return positionAfterMove(oldDoc, newDoc, oldAbs) ?? resolved
}

/** Whether a position resolved into a different block than the one it was in. */
function isMisresolved(oldDoc: Node, newDoc: Node, oldAbs: number, resolved: number): boolean {
  const $old = oldDoc.resolve(oldAbs)
  const $new = newDoc.resolve(resolved)
  if (!$old.parent.isTextblock) return false
  if (!$new.parent.isTextblock) return true
  if ($old.parent.textContent !== $new.parent.textContent) return true
  if ($old.parentOffset !== 0 && $new.parentOffset === 0) return true
  const bothAtStart = $old.parentOffset === 0 && $new.parentOffset === 0
  const suspicious =
    $old.parentOffset !== $new.parentOffset ||
    $old.parent.type !== $new.parent.type ||
    !attrsEqual($old.parent.attrs, $new.parent.attrs)
  if (!bothAtStart && !suspicious) return false
  const expected = positionAfterMove(oldDoc, newDoc, oldAbs)
  return expected !== null && expected !== resolved
}

/** The position in the block `absPos` was in, found again in `newDoc`; null when ambiguous. */
function positionAfterMove(oldDoc: Node, newDoc: Node, absPos: number): number | null {
  let pos = 0
  let index = 0
  for (; index < oldDoc.childCount; index += 1) {
    const child = oldDoc.child(index)
    if (pos + child.nodeSize > absPos) break
    pos += child.nodeSize
  }
  if (index >= oldDoc.childCount) return null
  const target = oldDoc.child(index)
  const $old = oldDoc.resolve(absPos)
  const place = (start: number, block: Node): number | null => {
    if ($old.depth === 0)
      return Math.max(start + 1, Math.min(start + (absPos - pos), start + block.nodeSize - 1))
    if ($old.depth > 1) {
      const inner = positionAfterMove($old.node(1), block, $old.pos - $old.start(1))
      return inner === null ? null : start + 1 + inner
    }
    if (!block.isTextblock) return null
    return start + 1 + Math.min($old.parentOffset, block.content.size)
  }
  // The same occurrence, counted from the top, of the blocks matching `test`.
  const find = (test: (block: Node) => boolean, unique = false): number | null => {
    let occurrence = 0
    for (let at = 0; at <= index; at += 1) if (test(oldDoc.child(at))) occurrence += 1
    let matches = 0
    let start = -1
    let found: Node | null = null
    let at = 0
    for (let each = 0; each < newDoc.childCount; each += 1) {
      const child = newDoc.child(each)
      if (test(child)) {
        matches += 1
        if (matches === occurrence) {
          start = at
          found = child
        }
      }
      at += child.nodeSize
    }
    if (found === null || (unique && (occurrence !== 1 || matches !== 1))) return null
    return place(start, found)
  }
  const alike = (block: Node) => block.type === target.type && attrsEqual(block.attrs, target.attrs)
  const text = target.textContent
  return (
    find((block) => alike(block) && block.textContent === text) ??
    find((block) => block.type === target.type && block.textContent === text) ??
    (!target.isTextblock || hasDistinctiveAttrs(target) ? find(alike, true) : null) ??
    find(
      (block) =>
        alike(block) &&
        text !== "" &&
        block.textContent !== "" &&
        (text.startsWith(block.textContent) || block.textContent.startsWith(text)),
      true
    )
  )
}

function attrsEqual(a: Attrs, b: Attrs): boolean {
  if (a === b) return true
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** Whether a block has an attribute other than its default, which tells it apart. */
function hasDistinctiveAttrs(node: Node): boolean {
  return Object.keys(node.attrs).some((key) => node.type.defaultAttrs[key] !== node.attrs[key])
}
