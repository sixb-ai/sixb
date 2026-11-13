import { PAGE_MARK_TAGS } from "@sixb/core/artifacts/live"
import type { Editor } from "@tiptap/core"
import type { Fragment, Node as ProseMirrorNode, ResolvedPos, Schema } from "@tiptap/pm/model"
import { NodeSelection, Selection, TextSelection, type Transaction } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import type { EditorRect, PageBlockId } from "./protocol"
import { startTag, tagAttributes } from "./schema"

// What the editor does to a page's blocks: make one, turn one into another, move, copy and delete
// them, and find where a dragged one lands. A page is HTML, so what is made is always markup that
// can stand where it goes: a new block next to a list item goes after the list, not into it.

/** Blocks of words where Enter starts a new line rather than a new block: a cell, a caption. */
export const SINGLE_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "td",
  "th",
  "caption",
  "figcaption",
  "summary",
  "legend",
  "label",
  ...PAGE_MARK_TAGS,
])

export const LIST_TAGS: ReadonlySet<string> = new Set(["ul", "ol", "menu"])

/** Elements only some elements may stand in: a new block goes after them, not into them. */
const HOLDERS: ReadonlySet<string> = new Set([
  ...LIST_TAGS,
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
])

const HEADING_LEVEL: Readonly<Record<string, string>> = {
  heading1: "h1",
  heading2: "h2",
  heading3: "h3",
}

/** The block of words the selection is in, and where it starts. */
export function wordsAt(selection: Selection): { node: ProseMirrorNode; pos: number } | null {
  const { $from } = selection
  if ($from.parent.type.name !== "textBlock" || $from.depth === 0) return null
  return { node: $from.parent, pos: $from.before() }
}

export function tagOf(node: ProseMirrorNode | null | undefined): string {
  return typeof node?.attrs.tag === "string" ? node.attrs.tag : ""
}

/** A block of words, made by the editor: spaced as the block before it when written back. */
export function words(
  schema: Schema,
  tag: string,
  open?: string,
  content?: Fragment | null
): ProseMirrorNode {
  return schema.nodes.textBlock.create(
    { tag, open: open ?? `<${tag}>`, close: `</${tag}>` },
    content ?? null
  )
}

export function box(
  schema: Schema,
  tag: string,
  children: readonly ProseMirrorNode[],
  open?: string
): ProseMirrorNode {
  return schema.nodes.box.create({ tag, open: open ?? `<${tag}>`, close: `</${tag}>` }, children)
}

function raw(schema: Schema, source: string): ProseMirrorNode {
  return schema.nodes.raw.create({ source })
}

/** A start tag without its `id`, which a copy must not repeat. */
export function withoutId(open: string, tag: string): string {
  const attrs = { ...tagAttributes(open) }
  if (!("id" in attrs)) return open
  delete attrs.id
  return startTag(tag, attrs)
}

/**
 * The start tag the page wrote for `tag` nearest before `pos`, else first after it, so a new
 * heading or table looks like the page's others; a plain one where it wrote none.
 */
export function likeOpen(doc: ProseMirrorNode, pos: number, tag: string): string {
  let before: string | null = null
  let after: string | null = null
  doc.descendants((node, at) => {
    if (tagOf(node) !== tag || typeof node.attrs.open !== "string") return true
    if (at < pos) before = node.attrs.open
    else after ??= node.attrs.open
    return true
  })
  const found = before ?? after
  return found ? withoutId(found, tag) : `<${tag}>`
}

/** A new block of the kind `id`, as it is made where `pos` is. */
export function makeBlock(
  schema: Schema,
  doc: ProseMirrorNode,
  pos: number,
  id: PageBlockId
): ProseMirrorNode | null {
  const heading = HEADING_LEVEL[id]
  if (heading) return words(schema, heading, likeOpen(doc, pos, heading))
  switch (id) {
    case "paragraph":
      return words(schema, "p")
    case "quote":
      return words(schema, "blockquote")
    case "bulletList":
      return box(schema, "ul", [words(schema, "li")])
    case "orderedList":
      return box(schema, "ol", [words(schema, "li")])
    case "table": {
      const row = (cell: string) =>
        box(
          schema,
          "tr",
          [1, 2, 3].map(() => words(schema, cell))
        )
      return box(
        schema,
        "table",
        [box(schema, "thead", [row("th")]), box(schema, "tbody", [row("td"), row("td")])],
        likeOpen(doc, pos, "table")
      )
    }
    case "divider":
      return raw(schema, "<hr>")
    case "pageBreak":
      return raw(schema, '<div style="break-after: page"></div>')
    default:
      return null
  }
}

/**
 * Where a block goes after the one at `pos`: right after it, or after the list or table it is
 * part of, where a block of any kind may stand.
 */
export function placeAfter(doc: ProseMirrorNode, pos: number): number {
  const node = doc.nodeAt(pos)
  const $pos = doc.resolve(pos)
  let at = pos + (node?.nodeSize ?? 0)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (HOLDERS.has(tagOf($pos.node(depth)))) at = $pos.after(depth)
  }
  return at
}

/**
 * Puts `made` where the block of words at `pos` is: in its place when it is empty and may be
 * replaced, else after it. Returns where `made` starts.
 */
export function placeBlock(tr: Transaction, pos: number, made: ProseMirrorNode): number {
  const node = tr.doc.nodeAt(pos)
  const after = placeAfter(tr.doc, pos)
  const replaceable =
    node?.type.name === "textBlock" &&
    node.content.size === 0 &&
    after === pos + node.nodeSize &&
    !SINGLE_BLOCK_TAGS.has(tagOf(node))
  if (node && replaceable) {
    tr.replaceWith(pos, pos + node.nodeSize, made)
    return pos
  }
  tr.insert(after, made)
  return after
}

/** Puts the caret in the first words of the block at `at`, or on a new paragraph after it. */
export function caretInto(tr: Transaction, at: number): void {
  const made = tr.doc.nodeAt(at)
  if (!made) return
  if (!made.isAtom) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)))
    return
  }
  const after = at + made.nodeSize
  if (tr.doc.resolve(after).nodeAfter?.type.name !== "textBlock") {
    tr.insert(after, words(tr.doc.type.schema, "p"))
  }
  tr.setSelection(TextSelection.create(tr.doc, after + 1))
}

/** Makes a block of the kind `id` where the caret is, in place of `range`: what `/` typed. */
export function insertBlock(
  editor: Editor,
  id: PageBlockId,
  range?: { readonly from: number; readonly to: number }
): boolean {
  const tr = editor.state.tr
  if (range) tr.delete(range.from, range.to)
  const at = wordsAt(tr.selection)
  if (!at) return false
  const made = makeBlock(editor.schema, tr.doc, at.pos, id)
  if (!made) return false
  caretInto(tr, placeBlock(tr, at.pos, made))
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
  return true
}

/**
 * Turns the block of words at `pos`, or the one the caret is in, into a block of the kind `id`,
 * keeping its words: a paragraph into a heading, a list item out of its list into a paragraph.
 */
export function turnInto(editor: Editor, id: PageBlockId, pos?: number): boolean {
  const { state } = editor
  const target =
    pos === undefined
      ? wordsAt(state.selection)
      : { node: state.doc.nodeAt(pos) as ProseMirrorNode, pos }
  if (!target || !turnable(state.doc, target.pos)) return false
  const { node } = target
  const $pos = state.doc.resolve(target.pos)
  const parent = $pos.parent
  const inList = tagOf(node) === "li" && LIST_TAGS.has(tagOf(parent))
  const tr = state.tr
  // The caret stays where it was among the block's words, wherever the block goes.
  const offset = Math.min(Math.max(state.selection.from - target.pos - 1, 0), node.content.size)
  let at = target.pos

  if (id === "bulletList" || id === "orderedList") {
    const list = id === "bulletList" ? "ul" : "ol"
    if (inList) {
      if (tagOf(parent) === list) return true
      tr.setNodeMarkup($pos.before(), undefined, {
        ...parent.attrs,
        tag: list,
        open: `<${list}>`,
        close: `</${list}>`,
      })
    } else {
      tr.replaceWith(
        target.pos,
        target.pos + node.nodeSize,
        box(editor.schema, list, [words(editor.schema, "li", undefined, node.content)])
      )
      at = target.pos + 1
    }
  } else {
    const tag =
      HEADING_LEVEL[id] ?? (id === "paragraph" ? "p" : id === "quote" ? "blockquote" : null)
    if (!tag) return false
    const open = HEADING_LEVEL[id] ? likeOpen(state.doc, target.pos, tag) : `<${tag}>`
    if (inList) {
      at = liftOut(tr, target.pos, words(editor.schema, tag, open, node.content))
    } else {
      tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, tag, open, close: `</${tag}>` })
    }
  }
  tr.setSelection(TextSelection.create(tr.doc, at + 1 + offset))
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
  return true
}

/**
 * Whether the block at `pos` may be turned into another kind: a block of words that stands where
 * any block may. A cell, a caption, or words in a table's row cannot: a heading there is not HTML.
 */
export function turnable(doc: ProseMirrorNode, pos: number): boolean {
  const node = doc.nodeAt(pos)
  if (node?.type.name !== "textBlock" || SINGLE_BLOCK_TAGS.has(tagOf(node))) return false
  const $pos = doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const tag = tagOf($pos.node(depth))
    if (tag === "table" || tag === "tr" || tag === "thead" || tag === "tbody" || tag === "tfoot") {
      return false
    }
  }
  return true
}

/**
 * Takes the list item at `pos` out of its list as `replacement`: before the list when it is the
 * first item, after it when the last, and between the two halves of the list otherwise. The caret
 * goes into it. Returns where it starts.
 */
export function liftOut(tr: Transaction, pos: number, replacement: ProseMirrorNode): number {
  const item = tr.doc.nodeAt(pos)
  if (!item) return pos
  const $pos = tr.doc.resolve(pos)
  const list = $pos.parent
  const listPos = $pos.before()
  const index = $pos.index()
  let at: number
  if (list.childCount === 1) {
    tr.replaceWith(listPos, listPos + list.nodeSize, replacement)
    at = listPos
  } else if (index === 0) {
    tr.delete(pos, pos + item.nodeSize)
    tr.insert(listPos, replacement)
    at = listPos
  } else if (index === list.childCount - 1) {
    tr.delete(pos, pos + item.nodeSize)
    at = tr.mapping.map(listPos + list.nodeSize)
    tr.insert(at, replacement)
  } else {
    tr.delete(pos, pos + item.nodeSize)
    tr.split(pos, 1)
    at = pos + 1
    tr.insert(at, replacement)
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)))
  return at
}

/** A copy of the block at `pos` right after it, without the ids that would repeat. */
export function duplicate(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return false
  const tag = tagOf(node)
  // A cell or a caption is one of its kind where it stands: a second would break its table.
  if (SINGLE_BLOCK_TAGS.has(tag)) return false
  const open = node.attrs.open
  const copy =
    typeof open === "string" && tag
      ? node.type.create({ ...node.attrs, open: withoutId(open, tag) }, node.content, node.marks)
      : node
  const at = pos + node.nodeSize
  const tr = editor.state.tr.insert(at, copy)
  tr.setSelection(
    copy.isAtom
      ? NodeSelection.create(tr.doc, at)
      : Selection.near(tr.doc.resolve(at + copy.nodeSize - 1), -1)
  )
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
  return true
}

/** Deletes the block at `pos`, and a box it leaves empty with it. */
export function remove(editor: Editor, pos: number): boolean {
  const { doc } = editor.state
  let from = pos
  let node = doc.nodeAt(pos)
  if (!node) return false
  // A box holds a block at least: one left empty goes too.
  let $pos = doc.resolve(from)
  while ($pos.depth > 0 && $pos.parent.childCount === 1) {
    from = $pos.before()
    node = $pos.parent
    $pos = doc.resolve(from)
  }
  const tr = editor.state.tr
  if ($pos.depth === 0 && doc.childCount === 1) {
    tr.replaceWith(0, doc.content.size, words(editor.schema, "p"))
  } else {
    tr.delete(from, from + node.nodeSize)
  }
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), -1))
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
  return true
}

/** Moves the block at `pos` past its sibling before (`-1`) or after (`1`) it. Returns where it is. */
export function move(editor: Editor, pos: number, by: -1 | 1): number | null {
  const { doc } = editor.state
  const node = doc.nodeAt(pos)
  if (!node) return null
  const $pos = doc.resolve(pos)
  const sibling = $pos.parent.maybeChild($pos.index() + by)
  if (!sibling) return null
  const offset = editor.state.selection.from - pos
  const target = by === 1 ? pos + sibling.nodeSize : pos - sibling.nodeSize
  const tr = editor.state.tr.delete(pos, pos + node.nodeSize).insert(target, node)
  const inside = target + Math.min(Math.max(offset, 0), node.nodeSize)
  tr.setSelection(
    node.isAtom ? NodeSelection.create(tr.doc, target) : Selection.near(tr.doc.resolve(inside))
  )
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
  return target
}

/**
 * The block the reader means at a point: the innermost block there, words or a picture or a box;
 * a table's cells and rows, which do not move on their own, mean their table.
 */
export function blockAt(
  view: EditorView,
  x: number,
  y: number
): { node: ProseMirrorNode; pos: number } | null {
  const found = view.posAtCoords({ left: x, top: y })
  if (!found) return null
  const { doc } = view.state
  let pos = found.inside
  let node = pos >= 0 ? doc.nodeAt(pos) : null
  if (!node || node.isInline) {
    const $pos = doc.resolve(found.pos)
    if ($pos.depth === 0) {
      // Between blocks at the top: the block just after, or before.
      const after = $pos.nodeAfter ?? $pos.nodeBefore
      if (!after) return null
      pos = $pos.nodeAfter ? found.pos : found.pos - after.nodeSize
      node = after
    } else {
      pos = $pos.before($pos.depth)
      node = $pos.parent
    }
  }
  // The outermost table around it, if any.
  const $pos = doc.resolve(pos)
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if (tagOf($pos.node(depth)) === "table")
      return { node: $pos.node(depth), pos: $pos.before(depth) }
  }
  return node ? { node, pos } : null
}

/** What a node draws as, measured: a node drawn through its children is as big as they are. */
export function rectOf(dom: globalThis.Node | null | undefined): EditorRect | null {
  if (!(dom instanceof Element)) return null
  const own = dom.getBoundingClientRect()
  if (own.width > 0 || own.height > 0) {
    return { left: own.left, top: own.top, right: own.right, bottom: own.bottom }
  }
  let rect: EditorRect | null = null
  for (const child of Array.from(dom.children)) {
    const inner = rectOf(child)
    if (!inner) continue
    rect = rect
      ? {
          left: Math.min(rect.left, inner.left),
          top: Math.min(rect.top, inner.top),
          right: Math.max(rect.right, inner.right),
          bottom: Math.max(rect.bottom, inner.bottom),
        }
      : inner
  }
  return rect
}

/**
 * Where the block at `dragged` would land, dropped at a point: before or after the block there,
 * whichever half of it the point is in. A list item lands among list items; anything else beside
 * a list, not in it. Null where it cannot land: on itself, or inside itself.
 */
export function dropTarget(
  view: EditorView,
  dragged: number,
  x: number,
  y: number
): { at: number; line: EditorRect } | null {
  const node = view.state.doc.nodeAt(dragged)
  let target = blockAt(view, x, y)
  if (!node || !target) return null
  const item = (each: ProseMirrorNode) => tagOf(each) === "li"
  if (item(node) && !item(target.node)) return null
  if (!item(node) && item(target.node)) {
    const $pos = view.state.doc.resolve(target.pos)
    target = { node: $pos.parent, pos: $pos.before() }
  }
  if (target.pos >= dragged && target.pos < dragged + node.nodeSize) return null
  const rect = rectOf(view.nodeDOM(target.pos))
  if (!rect) return null
  const before = y < (rect.top + rect.bottom) / 2
  const edge = before ? rect.top : rect.bottom
  return {
    at: before ? target.pos : target.pos + target.node.nodeSize,
    line: { left: rect.left, right: rect.right, top: edge, bottom: edge },
  }
}

/**
 * Moves the block at `dragged` to `at`, as a drop does. A box it was all of goes with it, as
 * `remove` takes it: a list whose only item moves into another list leaves no empty list behind.
 */
export function moveTo(editor: Editor, dragged: number, at: number): boolean {
  const { doc } = editor.state
  const node = doc.nodeAt(dragged)
  if (!node || at === dragged || at === dragged + node.nodeSize) return false
  let from = dragged
  let size = node.nodeSize
  let $pos = doc.resolve(from)
  while ($pos.depth > 0 && $pos.parent.childCount === 1) {
    from = $pos.before()
    size = $pos.parent.nodeSize
    $pos = doc.resolve(from)
  }
  if (at > from && at < from + size) return false
  const tr = editor.state.tr.delete(from, from + size)
  const target = tr.mapping.map(at)
  tr.insert(target, node)
  tr.setSelection(
    node.isAtom
      ? NodeSelection.create(tr.doc, target)
      : Selection.near(tr.doc.resolve(target + node.nodeSize - 1), -1)
  )
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
  return true
}

/** The kind of block the block of words at `$pos` is, as "Turn into" names it. */
export function blockKind($pos: ResolvedPos): PageBlockId | null {
  const node = $pos.parent
  if (node.type.name !== "textBlock") return null
  const tag = tagOf(node)
  if (tag === "p") return "paragraph"
  if (tag === "h1") return "heading1"
  if (tag === "h2") return "heading2"
  if (tag === "h3") return "heading3"
  if (tag === "blockquote") return "quote"
  if (tag === "li") {
    const list = $pos.depth > 1 ? tagOf($pos.node($pos.depth - 1)) : ""
    return list === "ol" ? "orderedList" : list === "ul" ? "bulletList" : null
  }
  return null
}
