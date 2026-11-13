import { type Editor, Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state"
import {
  duplicate,
  LIST_TAGS,
  liftOut,
  move,
  SINGLE_BLOCK_TAGS,
  tagOf,
  withoutId,
  words,
  wordsAt,
} from "./commands"
import type { PageMark } from "./protocol"

// The keys of a page, Notion's where a page allows them. Enter starts a new paragraph, or a new
// item in a list; Backspace at the start of a heading makes it a paragraph, and of a list's first
// item takes it out of the list. What would merge two boxes of the design, a section into the one
// before it or a cell into its neighbour, does nothing: the design's structure is changed by the
// block handle, never by a stray key.

/** After a block of these, Enter makes a paragraph; after any other, a block like it. */
const ENDS_IN_PARAGRAPH: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "address",
])

export interface PageKeysOptions {
  readonly toggleMark: (editor: Editor, mark: PageMark) => void
  readonly onLink: () => void
}

export const PageKeys = Extension.create<PageKeysOptions>({
  name: "pageKeys",
  addOptions: () => ({ toggleMark: () => {}, onLink: () => {} }),
  addKeyboardShortcuts() {
    const editor = this.editor
    const mark = (name: PageMark) => () => {
      this.options.toggleMark(editor, name)
      return true
    }
    const current = () => {
      const at = wordsAt(editor.state.selection)
      if (at) return at
      const { selection } = editor.state
      return selection instanceof NodeSelection
        ? { node: selection.node, pos: selection.from }
        : null
    }
    return {
      Enter: () => enter(editor),
      "Shift-Enter": () => lineBreak(editor),
      Backspace: () => backspace(editor),
      Delete: () => forwardDelete(editor),
      // The body is the editor, so the browser would scroll the whole page to its end as well.
      Home: () => toLineEdge(editor, "backward", false),
      End: () => toLineEdge(editor, "forward", false),
      "Shift-Home": () => toLineEdge(editor, "backward", true),
      "Shift-End": () => toLineEdge(editor, "forward", true),
      Tab: () => nextCell(editor, 1),
      "Shift-Tab": () => nextCell(editor, -1),
      "Mod-b": mark("bold"),
      "Mod-i": mark("italic"),
      "Mod-u": mark("underline"),
      "Mod-Shift-s": mark("strike"),
      "Mod-e": mark("code"),
      "Mod-k": () => {
        if (editor.state.selection.empty) return false
        this.options.onLink()
        return true
      },
      "Mod-d": () => {
        const at = current()
        return at ? duplicate(editor, at.pos) : false
      },
      "Alt-Shift-ArrowUp": () => {
        const at = current()
        if (at) move(editor, at.pos, -1)
        return true
      },
      "Alt-Shift-ArrowDown": () => {
        const at = current()
        if (at) move(editor, at.pos, 1)
        return true
      },
    }
  },
})

/** Moves the caret, or extends the selection, to the start or end of the line it is on. */
function toLineEdge(editor: Editor, direction: "forward" | "backward", extend: boolean): boolean {
  const selection = editor.view.dom.ownerDocument.getSelection()
  if (!selection || typeof selection.modify !== "function") return false
  selection.modify(extend ? "extend" : "move", direction, "lineboundary")
  return true
}

function lineBreak(editor: Editor): boolean {
  const at = wordsAt(editor.state.selection)
  if (!at) return false
  if (tagOf(at.node) === "pre") return editor.commands.insertContent("\n")
  return editor.commands.insertContent({ type: "hardBreak" })
}

/**
 * Enter: a new block after the one the caret is in, which takes the words after the caret. In
 * `<pre>`, a new line; in a cell or a caption, a line break. An empty list item ends its list.
 */
function enter(editor: Editor): boolean {
  if (!(editor.state.selection instanceof TextSelection)) return false
  const first = wordsAt(editor.state.selection)
  if (!first) return false
  const tag = tagOf(first.node)
  if (tag === "pre") return editor.commands.insertContent("\n")
  if (SINGLE_BLOCK_TAGS.has(tag)) return lineBreak(editor)

  const tr = editor.state.tr
  if (!tr.selection.empty) tr.deleteSelection()
  const at = wordsAt(tr.selection)
  if (!at) return false
  const { node, pos } = at
  const $pos = tr.doc.resolve(pos)
  const inList = tag === "li" && LIST_TAGS.has(tagOf($pos.parent))

  if (inList && node.content.size === 0) {
    liftOut(tr, pos, words(editor.schema, "p"))
    editor.view.dispatch(tr.scrollIntoView())
    return true
  }

  const offset = tr.selection.$from.parentOffset
  const open = typeof node.attrs.open === "string" ? withoutId(node.attrs.open, tag) : `<${tag}>`
  const next =
    ENDS_IN_PARAGRAPH.has(tag) || (!inList && tag !== "dt" && tag !== "dd")
      ? words(editor.schema, "p")
      : words(editor.schema, tag, open)

  if (offset === 0 && node.content.size > 0) {
    // At the start of words: an empty block before them, which they keep their kind beside.
    tr.insert(pos, ENDS_IN_PARAGRAPH.has(tag) ? words(editor.schema, "p") : copyOf(node, open))
  } else if (offset === node.content.size) {
    tr.insert(pos + node.nodeSize, next)
    tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize + 1))
  } else {
    // In the middle: the words after the caret go to a block like this one.
    tr.split(tr.selection.from, 1, [
      { type: node.type, attrs: { ...node.attrs, open, before: null, inner: null } },
    ])
  }
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/** An empty block of words like `node`, without its id. */
function copyOf(node: ProseMirrorNode, open: string): ProseMirrorNode {
  return node.type.create({ ...node.attrs, open, before: null, inner: null })
}

/**
 * Backspace at the start of a block of words: a heading or a quote becomes a paragraph, a list's
 * first item leaves the list, and what would merge across boxes of the design does nothing. An
 * empty block after a picture or another block goes, and the caret with it.
 */
function backspace(editor: Editor): boolean {
  const { selection } = editor.state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const at = wordsAt(selection)
  if (!at || selection.$from.parentOffset > 0) return false
  const { node, pos } = at
  const tag = tagOf(node)
  const $pos = editor.state.doc.resolve(pos)
  const index = $pos.index()
  const tr = editor.state.tr

  if (ENDS_IN_PARAGRAPH.has(tag) && node.content.size > 0) {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, tag: "p", open: "<p>", close: "</p>" })
    editor.view.dispatch(tr)
    return true
  }
  if (tag === "li" && LIST_TAGS.has(tagOf($pos.parent))) {
    if (index > 0) return false
    liftOut(tr, pos, words(editor.schema, "p", undefined, node.content))
    editor.view.dispatch(tr.scrollIntoView())
    return true
  }
  if (SINGLE_BLOCK_TAGS.has(tag)) return true

  const previous = index > 0 ? $pos.parent.child(index - 1) : null
  if (!previous) {
    // The first block in its box: leaving it would merge it into what comes before.
    if (node.content.size > 0 || $pos.depth === 0 || $pos.parent.childCount === 1) return true
    tr.delete(pos, pos + node.nodeSize)
    tr.setSelection(Selection.near(tr.doc.resolve(pos), -1))
    editor.view.dispatch(tr.scrollIntoView())
    return true
  }
  if (previous.type.name === "textBlock") return false

  const previousPos = pos - previous.nodeSize
  if (node.content.size === 0) {
    tr.delete(pos, pos + node.nodeSize)
    tr.setSelection(
      previous.isAtom
        ? NodeSelection.create(tr.doc, previousPos)
        : Selection.near(tr.doc.resolve(pos), -1)
    )
  } else if (previous.isAtom) {
    tr.setSelection(NodeSelection.create(tr.doc, previousPos))
  } else {
    tr.setSelection(Selection.near(tr.doc.resolve(pos), -1))
  }
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/** Delete at the end of a block of words, as Backspace at the start of the next. */
function forwardDelete(editor: Editor): boolean {
  const { selection } = editor.state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const at = wordsAt(selection)
  if (!at || selection.$from.parentOffset < at.node.content.size) return false
  if (SINGLE_BLOCK_TAGS.has(tagOf(at.node))) return true
  const $pos = editor.state.doc.resolve(at.pos)
  const next = $pos.parent.maybeChild($pos.index() + 1)
  // The last block in its box, or before something that is not words: nothing merges.
  if (!next) return true
  if (next.type.name !== "textBlock") {
    const after = at.pos + at.node.nodeSize
    const tr = editor.state.tr
    if (at.node.content.size === 0) tr.delete(at.pos, after)
    else if (next.isAtom) tr.setSelection(NodeSelection.create(tr.doc, after))
    editor.view.dispatch(tr.scrollIntoView())
    return true
  }
  return false
}

/** Tab in a table moves to the next cell, Shift-Tab to the one before; elsewhere it stays put. */
function nextCell(editor: Editor, by: -1 | 1): boolean {
  const at = wordsAt(editor.state.selection)
  const tag = tagOf(at?.node)
  if (!at || (tag !== "td" && tag !== "th")) return true
  const cells: number[] = []
  const $pos = editor.state.doc.resolve(at.pos)
  let tableDepth = 0
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (tagOf($pos.node(depth)) === "table") tableDepth = depth
  }
  if (tableDepth === 0) return true
  const table = $pos.node(tableDepth)
  const start = $pos.start(tableDepth)
  table.descendants((node, offset) => {
    if (node.type.name === "textBlock" && (tagOf(node) === "td" || tagOf(node) === "th")) {
      cells.push(start + offset)
    }
    return node.type.name !== "textBlock"
  })
  const target = cells[cells.indexOf(at.pos) + by]
  if (target === undefined) return true
  const cell = editor.state.doc.nodeAt(target) as ProseMirrorNode
  const tr = editor.state.tr.setSelection(
    TextSelection.create(editor.state.doc, target + 1, target + 1 + cell.content.size)
  )
  editor.view.dispatch(tr.scrollIntoView())
  return true
}
