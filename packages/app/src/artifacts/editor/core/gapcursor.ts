// A caret between two blocks where no text can be, after a table before a picture: drawn as a
// short line, and typed into as a new paragraph. As ProseMirror's gap cursor (MIT) places it.

import type { EditorPlugin } from "./editor"
import { Fragment, type Node, type ResolvedPos, Slice } from "./model"
import { NodeSelection, Selection, TextSelection } from "./state"
import type { Mappable } from "./transform"

export class GapCursor extends Selection {
  constructor($pos: ResolvedPos) {
    super($pos, $pos)
  }

  map(doc: Node, mapping: Mappable): Selection {
    const $pos = doc.resolve(mapping.map(this.head))
    return GapCursor.valid($pos) ? new GapCursor($pos) : Selection.near($pos)
  }

  override content(): Slice {
    return Slice.empty
  }

  eq(other: Selection): boolean {
    return other instanceof GapCursor && other.head === this.head
  }

  /** Whether a gap cursor can stand at `$pos`: between blocks, where a paragraph could go. */
  static valid($pos: ResolvedPos): boolean {
    const parent = $pos.parent
    if (parent.isTextblock || !closedBefore($pos) || !closedAfter($pos)) return false
    const deflt = parent.contentMatchAt($pos.index()).defaultType
    return !!deflt?.isTextblock
  }

  static findGapFrom($start: ResolvedPos, dir: number, mustMoveStart = false): ResolvedPos | null {
    let $pos = $start
    let mustMove = mustMoveStart
    search: for (;;) {
      if (!mustMove && GapCursor.valid($pos)) return $pos
      let pos = $pos.pos
      let next: Node | null = null
      for (let depth = $pos.depth; ; depth -= 1) {
        const parent = $pos.node(depth)
        if (dir > 0 ? $pos.indexAfter(depth) < parent.childCount : $pos.index(depth) > 0) {
          next = parent.child(dir > 0 ? $pos.indexAfter(depth) : $pos.index(depth) - 1)
          break
        }
        if (depth === 0) return null
        pos += dir
        const $cur = $pos.doc.resolve(pos)
        if (GapCursor.valid($cur)) return $cur
      }
      for (;;) {
        const inside: Node | null = dir > 0 ? next.firstChild : next.lastChild
        if (!inside) {
          if (next.isAtom && !next.isText && !NodeSelection.isSelectable(next)) {
            $pos = $pos.doc.resolve(pos + next.nodeSize * dir)
            mustMove = false
            continue search
          }
          break
        }
        next = inside
        pos += dir
        const $cur = $pos.doc.resolve(pos)
        if (GapCursor.valid($cur)) return $cur
      }
      return null
    }
  }
}

function closedBefore($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const index = $pos.index(depth)
    const parent = $pos.node(depth)
    if (index === 0) {
      if (parent.type.spec.isolating) return true
      continue
    }
    for (let before: Node | null = parent.child(index - 1); before; before = before.lastChild) {
      if (
        (before.childCount === 0 && !before.inlineContent) ||
        before.isAtom ||
        before.type.spec.isolating
      )
        return true
      if (before.inlineContent) return false
    }
  }
  return true
}

function closedAfter($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const index = $pos.indexAfter(depth)
    const parent = $pos.node(depth)
    if (index === parent.childCount) {
      if (parent.type.spec.isolating) return true
      continue
    }
    for (let after: Node | null = parent.child(index); after; after = after.firstChild) {
      if (
        (after.childCount === 0 && !after.inlineContent) ||
        after.isAtom ||
        after.type.spec.isolating
      )
        return true
      if (after.inlineContent) return false
    }
  }
  return true
}

/** Arrows onto a gap cursor, clicks between blocks, and the line it is drawn as. */
export function gapCursorPlugin(): EditorPlugin {
  const arrow = (axis: "vert" | "horiz", dir: number) => (view: import("./view").EditorView) => {
    const selection = view.state.selection
    let $start = dir > 0 ? selection.$to : selection.$from
    let mustMove = selection.empty
    if (selection instanceof TextSelection) {
      const direction = axis === "vert" ? (dir > 0 ? "down" : "up") : dir > 0 ? "right" : "left"
      if (!view.endOfTextblock(direction) || $start.depth === 0) return false
      mustMove = false
      $start = view.state.doc.resolve(dir > 0 ? $start.after() : $start.before())
    }
    const $found = GapCursor.findGapFrom($start, dir, mustMove)
    if (!$found) return false
    view.dispatch(view.state.tr.setSelection(new GapCursor($found)))
    return true
  }
  return {
    keys: {
      ArrowLeft: arrow("horiz", -1),
      ArrowRight: arrow("horiz", 1),
      ArrowUp: arrow("vert", -1),
      ArrowDown: arrow("vert", 1),
    },
    createSelectionBetween: (_view, $anchor, $head) =>
      $anchor.pos === $head.pos && GapCursor.valid($head) ? new GapCursor($head) : null,
    handleClick: (view, pos, event) => {
      if (!view.editable) return false
      const $pos = view.state.doc.resolve(pos)
      if (!GapCursor.valid($pos)) return false
      const found = view.posAtCoords({ left: event.clientX, top: event.clientY })
      if (
        found &&
        found.inside > -1 &&
        NodeSelection.isSelectable(view.state.doc.nodeAt(found.inside) as Node)
      )
        return false
      view.dispatch(view.state.tr.setSelection(new GapCursor($pos)))
      return true
    },
    handleDOMEvents: {
      beforeinput: (view, event) => {
        if (
          (event as InputEvent).inputType !== "insertCompositionText" ||
          !(view.state.selection instanceof GapCursor)
        )
          return false
        const { $from } = view.state.selection
        const insert = $from.parent
          .contentMatchAt($from.index())
          .findWrapping(view.state.schema.text)
        if (!insert) return false
        let fragment = Fragment.empty
        for (let index = insert.length - 1; index >= 0; index -= 1)
          fragment = Fragment.from(insert[index]?.createAndFill(null, fragment) ?? null)
        const tr = view.state.tr.replace($from.pos, $from.pos, new Slice(fragment, 0, 0))
        tr.setSelection(TextSelection.near(tr.doc.resolve($from.pos + 1)))
        view.dispatch(tr)
        return false
      },
    },
    decorations: (state) => {
      if (!(state.selection instanceof GapCursor)) return []
      return [
        {
          kind: "widget",
          pos: state.selection.head,
          side: 0,
          key: "gapcursor",
          toDOM: () => {
            const node = document.createElement("div")
            node.className = "sixb-gapcursor"
            return node
          },
        },
      ]
    },
  }
}
