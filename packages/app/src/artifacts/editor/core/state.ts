// What the editor holds: its document, its selection, and the marks the next typed text takes.
// A transaction changes them; the editor applies it as one state after another. Selections follow
// ProseMirror's (MIT): a range of text, a node picked whole, or everything.

import { Fragment, Mark, type Node, type ResolvedPos, Slice } from "./model"
import { type Mappable, ReplaceAroundStep, ReplaceStep, Transform } from "./transform"

// ── Selections ──────────────────────────────────────────────────────────

/** One stretch of a selection: a cell's content, of several selected together. */
export interface SelectionRange {
  readonly $from: ResolvedPos
  readonly $to: ResolvedPos
}

export abstract class Selection {
  constructor(
    readonly $anchor: ResolvedPos,
    readonly $head: ResolvedPos
  ) {}

  /** What is selected, as one range or, for cells, one per cell. */
  get ranges(): readonly SelectionRange[] {
    return [{ $from: this.$from, $to: this.$to }]
  }

  get anchor(): number {
    return this.$anchor.pos
  }
  get head(): number {
    return this.$head.pos
  }
  get from(): number {
    return this.$from.pos
  }
  get to(): number {
    return this.$to.pos
  }
  get $from(): ResolvedPos {
    return this.$anchor.pos <= this.$head.pos ? this.$anchor : this.$head
  }
  get $to(): ResolvedPos {
    return this.$anchor.pos <= this.$head.pos ? this.$head : this.$anchor
  }
  get empty(): boolean {
    return this.$from.pos === this.$to.pos
  }

  abstract eq(other: Selection): boolean
  abstract map(doc: Node, mapping: Mappable): Selection

  /** What is selected, as a slice. */
  content(): Slice {
    return this.$from.doc.slice(this.from, this.to, true)
  }

  /** Replaces what is selected with `content`, leaving the selection after it. */
  replace(tr: Transaction, content = Slice.empty): void {
    let lastNode = content.content.lastChild
    let lastParent: Node | null = null
    for (let index = 0; index < content.openEnd; index += 1) {
      lastParent = lastNode
      lastNode = lastNode?.lastChild ?? null
    }
    const mapFrom = tr.steps.length
    const mapping = tr.mapping.slice(mapFrom)
    tr.replaceRange(mapping.map(this.from), mapping.map(this.to), content)
    selectionToInsertionEnd(
      tr,
      mapFrom,
      (lastNode ? lastNode.isInline : lastParent?.isTextblock) ? -1 : 1
    )
  }

  /** Replaces what is selected with `node`, leaving the selection after it. */
  replaceWith(tr: Transaction, node: Node): void {
    const mapFrom = tr.steps.length
    tr.replaceRangeWith(this.from, this.to, node)
    selectionToInsertionEnd(tr, mapFrom, node.isInline ? -1 : 1)
  }

  /** A valid selection near `$pos`, looking first in the direction of `bias`. */
  static near($pos: ResolvedPos, bias = 1): Selection {
    return (
      Selection.findFrom($pos, bias) ??
      Selection.findFrom($pos, -bias) ??
      new AllSelection($pos.node(0))
    )
  }

  /** The first valid selection from `$pos` in direction `dir`, text only when `textOnly`. */
  static findFrom($pos: ResolvedPos, dir: number, textOnly = false): Selection | null {
    const inner = $pos.parent.inlineContent
      ? new TextSelection($pos)
      : findSelectionIn($pos.doc, $pos.parent, $pos.pos, $pos.index(), dir, textOnly)
    if (inner) return inner
    for (let depth = $pos.depth - 1; depth >= 0; depth -= 1) {
      const found =
        dir < 0
          ? findSelectionIn(
              $pos.doc,
              $pos.node(depth),
              $pos.before(depth + 1),
              $pos.index(depth),
              dir,
              textOnly
            )
          : findSelectionIn(
              $pos.doc,
              $pos.node(depth),
              $pos.after(depth + 1),
              $pos.index(depth) + 1,
              dir,
              textOnly
            )
      if (found) return found
    }
    return null
  }

  static atStart(doc: Node): Selection {
    return findSelectionIn(doc, doc, 0, 0, 1) ?? new AllSelection(doc)
  }

  static atEnd(doc: Node): Selection {
    return findSelectionIn(doc, doc, doc.content.size, doc.childCount, -1) ?? new AllSelection(doc)
  }
}

/** A range of text, or a caret where it is empty. */
export class TextSelection extends Selection {
  constructor($anchor: ResolvedPos, $head: ResolvedPos = $anchor) {
    super($anchor, $head)
  }

  /** The caret, when the selection is one. */
  get $cursor(): ResolvedPos | null {
    return this.$anchor.pos === this.$head.pos ? this.$head : null
  }

  eq(other: Selection): boolean {
    return (
      other instanceof TextSelection && other.anchor === this.anchor && other.head === this.head
    )
  }

  map(doc: Node, mapping: Mappable): Selection {
    const $head = doc.resolve(mapping.map(this.head))
    if (!$head.parent.inlineContent) return Selection.near($head)
    const $anchor = doc.resolve(mapping.map(this.anchor))
    return new TextSelection($anchor.parent.inlineContent ? $anchor : $head, $head)
  }

  override replace(tr: Transaction, content = Slice.empty): void {
    super.replace(tr, content)
    if (content === Slice.empty) {
      const marks = this.$from.marksAcross(this.$to)
      if (marks) tr.ensureMarks(marks)
    }
  }

  static create(doc: Node, anchor: number, head = anchor): TextSelection {
    const $anchor = doc.resolve(anchor)
    return new TextSelection($anchor, head === anchor ? $anchor : doc.resolve(head))
  }

  /** A text selection between two positions, moved to text where one is not in text. */
  static between($anchor: ResolvedPos, $head: ResolvedPos, bias?: number): Selection {
    const dPos = $anchor.pos - $head.pos
    let direction = bias
    if (!direction || dPos) direction = dPos >= 0 ? 1 : -1
    let head = $head
    let anchor = $anchor
    if (!head.parent.inlineContent) {
      const found =
        Selection.findFrom(head, direction, true) ?? Selection.findFrom(head, -direction, true)
      if (!found) return Selection.near(head, direction)
      head = found.$head
    }
    if (!anchor.parent.inlineContent) {
      if (dPos === 0) {
        anchor = head
      } else {
        const found =
          Selection.findFrom(anchor, -direction, true) ??
          Selection.findFrom(anchor, direction, true)
        anchor = found ? found.$anchor : head
        if (anchor.pos < head.pos !== dPos < 0) anchor = head
      }
    }
    return new TextSelection(anchor, head)
  }
}

/** A node picked whole: a picture, a rule, kept Markdown. */
export class NodeSelection extends Selection {
  readonly node: Node

  constructor($pos: ResolvedPos) {
    const node = $pos.nodeAfter
    if (!node) throw new RangeError("[SixbEditor] No node to pick there.")
    super($pos, $pos.node(0).resolve($pos.pos + node.nodeSize))
    this.node = node
  }

  eq(other: Selection): boolean {
    return other instanceof NodeSelection && other.anchor === this.anchor
  }

  map(doc: Node, mapping: Mappable): Selection {
    const { deleted, pos } = mapping.mapResult(this.anchor)
    const $pos = doc.resolve(pos)
    if (deleted || !$pos.nodeAfter) return Selection.near($pos)
    return new NodeSelection($pos)
  }

  override content(): Slice {
    return new Slice(Fragment.from(this.node), 0, 0)
  }

  static create(doc: Node, from: number): NodeSelection {
    return new NodeSelection(doc.resolve(from))
  }

  static isSelectable(node: Node): boolean {
    return !node.isText && node.type.spec.selectable !== false
  }
}

/** Everything: what Select All picks where the document does not start and end in text. */
export class AllSelection extends Selection {
  constructor(doc: Node) {
    super(doc.resolve(0), doc.resolve(doc.content.size))
  }

  eq(other: Selection): boolean {
    return other instanceof AllSelection
  }

  map(doc: Node): Selection {
    return new AllSelection(doc)
  }

  override replace(tr: Transaction, content = Slice.empty): void {
    if (content === Slice.empty) {
      tr.delete(0, tr.doc.content.size)
      const selection = Selection.atStart(tr.doc)
      if (!selection.eq(tr.selection)) tr.setSelection(selection)
    } else {
      super.replace(tr, content)
    }
  }
}

function findSelectionIn(
  doc: Node,
  node: Node,
  pos: number,
  index: number,
  dir: number,
  textOnly = false
): Selection | null {
  if (node.inlineContent) return TextSelection.create(doc, pos)
  let at = pos
  for (
    let child = index - (dir > 0 ? 0 : 1);
    dir > 0 ? child < node.childCount : child >= 0;
    child += dir
  ) {
    const current = node.child(child)
    if (!current.isAtom) {
      const inner = findSelectionIn(
        doc,
        current,
        at + dir,
        dir < 0 ? current.childCount : 0,
        dir,
        textOnly
      )
      if (inner) return inner
    } else if (!textOnly && NodeSelection.isSelectable(current)) {
      return NodeSelection.create(doc, at - (dir < 0 ? current.nodeSize : 0))
    }
    at += current.nodeSize * dir
  }
  return null
}

function selectionToInsertionEnd(tr: Transaction, startLength: number, bias: number): void {
  const last = tr.steps.length - 1
  if (last < startLength) return
  const step = tr.steps[last]
  if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return
  let end: number | undefined
  tr.mapping.maps[last]?.forEach((_from, _to, _newFrom, newTo) => {
    end ??= newTo
  })
  if (end !== undefined) tr.setSelection(Selection.near(tr.doc.resolve(end), bias))
}

// ── State and transactions ──────────────────────────────────────────────

export class EditorState {
  constructor(
    readonly doc: Node,
    readonly selection: Selection,
    readonly storedMarks: readonly Mark[] | null = null
  ) {}

  get tr(): Transaction {
    return new Transaction(this)
  }

  apply(tr: Transaction): EditorState {
    return new EditorState(tr.doc, tr.selection, tr.storedMarks)
  }

  get schema() {
    return this.doc.type.schema
  }
}

/** A change to the editor's state: steps to its document, and its selection and marks. */
export class Transaction extends Transform {
  private currentSelection: Selection
  private selectionFor = 0
  private selectionChanged = false
  private marksChanged = false
  storedMarks: readonly Mark[] | null
  private readonly meta = new Map<string, unknown>()
  scrolled = false

  constructor(readonly state: EditorState) {
    super(state.doc)
    this.currentSelection = state.selection
    this.storedMarks = state.storedMarks
  }

  get selection(): Selection {
    if (this.selectionFor < this.steps.length) {
      this.currentSelection = this.currentSelection.map(
        this.doc,
        this.mapping.slice(this.selectionFor)
      )
      this.selectionFor = this.steps.length
    }
    return this.currentSelection
  }

  get selectionSet(): boolean {
    return this.selectionChanged
  }

  get storedMarksSet(): boolean {
    return this.marksChanged
  }

  setSelection(selection: Selection): this {
    if (selection.$from.doc !== this.doc)
      throw new RangeError(
        "[SixbEditor] Selection passed to setSelection is not in the transaction's document."
      )
    this.currentSelection = selection
    this.selectionFor = this.steps.length
    this.selectionChanged = true
    this.marksChanged = false
    this.storedMarks = null
    return this
  }

  setStoredMarks(marks: readonly Mark[] | null): this {
    this.storedMarks = marks
    this.marksChanged = true
    return this
  }

  /** Makes the next typed text take `marks`, unless it would anyway. */
  ensureMarks(marks: readonly Mark[]): this {
    if (!Mark.sameSet(this.storedMarks ?? this.selection.$from.marks(), marks))
      this.setStoredMarks(marks)
    return this
  }

  addStoredMark(mark: Mark): this {
    return this.ensureMarks(mark.addToSet(this.storedMarks ?? this.selection.$head.marks()))
  }

  removeStoredMark(mark: Mark | import("./model").MarkType): this {
    const set = this.storedMarks ?? this.selection.$head.marks()
    return this.ensureMarks(mark.removeFromSet(set))
  }

  override step(step: import("./transform").Step, doc?: Node): this {
    super.step(step, doc)
    this.marksChanged = false
    this.storedMarks = null
    return this
  }

  replaceSelection(slice: Slice): this {
    this.selection.replace(this, slice)
    return this
  }

  replaceSelectionWith(node: Node, inheritMarks = true): this {
    const selection = this.selection
    let made = node
    if (inheritMarks) {
      made = node.mark(
        this.storedMarks ??
          (selection.empty
            ? selection.$from.marks()
            : (selection.$from.marksAcross(selection.$to) ?? Mark.none))
      )
    }
    selection.replaceWith(this, made)
    return this
  }

  deleteSelection(): this {
    this.selection.replace(this)
    return this
  }

  /** Types `text` over the selection, or over `from`–`to`, with the marks typing takes there. */
  insertText(text: string, from?: number, to?: number): this {
    const schema = this.doc.type.schema
    if (from === undefined) {
      if (!text) return this.deleteSelection()
      return this.replaceSelectionWith(schema.textNode(text), true)
    }
    const end = to ?? from
    if (!text) return this.deleteRange(from, end)
    let marks = this.storedMarks
    if (!marks) {
      const $from = this.doc.resolve(from)
      marks = end === from ? $from.marks() : $from.marksAcross(this.doc.resolve(end))
    }
    this.replaceRangeWith(from, end, schema.textNode(text, marks ?? Mark.none))
    if (!this.selection.empty && this.selection.to === from + text.length)
      this.setSelection(Selection.near(this.selection.$to))
    return this
  }

  setMeta(key: string, value: unknown): this {
    this.meta.set(key, value)
    return this
  }

  getMeta<Value = unknown>(key: string): Value | undefined {
    return this.meta.get(key) as Value | undefined
  }

  scrollIntoView(): this {
    this.scrolled = true
    return this
  }
}
