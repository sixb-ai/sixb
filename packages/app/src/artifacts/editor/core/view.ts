// The editor on the page: draws the document into a contenteditable element, keeps the browser's
// selection and the editor's in step, and turns keys, typing, clicks, pastes and drops into
// transactions.
//
// Drawing keeps a tree of descriptions, one for each node, mark and text drawn, which says which
// DOM stands for which part of the document, so a DOM position maps to a document position and
// back. A change redraws what it reached: a node the next document holds as it was keeps its DOM,
// and a paragraph whose words changed only has its text updated in place.
//
// Typing goes through the document, never the DOM: `beforeinput` is cancelled and its text, or the
// range the browser would delete, becomes a transaction. Only an input method's composition is
// left to the browser, which owns the DOM while it lasts; its text is read back from the DOM.

import { parseSlice, serializeSlice } from "./clipboard"
import {
  caretFromPoint,
  type DOMSpec,
  domIndex,
  flattenH,
  flattenV,
  inRect,
  isElement,
  isEquivalentPosition,
  isText,
  nodeSize,
  type Rect,
  renderSpec,
  singleRect,
  textRange,
} from "./dom"
import { isMac } from "./keymap"
import { type Mark, type Node, type ResolvedPos, Slice } from "./model"
import {
  AllSelection,
  type EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "./state"
import { dropPoint } from "./transform"

// ── Decorations ─────────────────────────────────────────────────────────

export interface DecorationAttrs {
  readonly class?: string
  readonly style?: string
  /** For an inline decoration: the element its text is wrapped in. Defaults to a span. */
  readonly nodeName?: string
  readonly [attribute: string]: string | undefined
}

/** Attributes for the text between two positions, wrapped in an element that carries them. */
export interface InlineDecoration {
  readonly kind: "inline"
  readonly from: number
  readonly to: number
  readonly attrs: DecorationAttrs
}

/** Attributes for the DOM of the node from `from` to `to`. */
export interface NodeDecoration {
  readonly kind: "node"
  readonly from: number
  readonly to: number
  readonly attrs: DecorationAttrs
}

/** An element drawn at a position, before the content there for a negative `side`. */
export interface WidgetDecoration {
  readonly kind: "widget"
  readonly pos: number
  readonly side: number
  /** Widgets with the same key and position are drawn once and kept. */
  readonly key: string
  readonly toDOM: () => HTMLElement
  /** Whether the selection may sit inside it. */
  readonly ignoreSelection?: boolean
}

export type Decoration = InlineDecoration | NodeDecoration | WidgetDecoration

/** Inline decorations of one textblock's text, relative to its content's start. */
export type TextblockDecorations = (node: Node) => readonly InlineDecoration[]

// ── Node views ──────────────────────────────────────────────────────────

/** How a node is drawn when its spec's `toDOM` will not do: a picture with its caption. */
export interface NodeView {
  readonly dom: HTMLElement
  readonly contentDOM?: HTMLElement | null
  /** Takes the next version of its node, or says it cannot. */
  update?(node: Node): boolean
  selectNode?(): void
  deselectNode?(): void
  /** Whether the editor leaves an event inside it alone. */
  stopEvent?(event: Event): boolean
  destroy?(): void
}

export type NodeViewFactory = (
  node: Node,
  view: EditorView,
  getPos: () => number | undefined
) => NodeView

// ── What the editor around the view decides ─────────────────────────────

export interface ViewProps {
  readonly nodeViews?: Readonly<Record<string, NodeViewFactory>>
  /** The keys the editor binds, before the view's own; true when one was handled. */
  readonly handleKeyDown?: (view: EditorView, event: KeyboardEvent) => boolean
  /** Typed text, before it is inserted; true when it was handled, by an input rule. */
  readonly handleTextInput?: (view: EditorView, from: number, to: number, text: string) => boolean
  readonly handlePaste?: (view: EditorView, event: ClipboardEvent, slice: Slice) => boolean
  readonly handleDrop?: (
    view: EditorView,
    event: DragEvent,
    slice: Slice,
    moved: boolean
  ) => boolean
  readonly handleClick?: (view: EditorView, pos: number, event: MouseEvent) => boolean
  readonly handleTripleClick?: (view: EditorView, pos: number, event: MouseEvent) => boolean
  readonly handleDOMEvents?: Readonly<Record<string, (view: EditorView, event: Event) => boolean>>
  readonly transformPasted?: (slice: Slice) => Slice
  readonly transformPastedHTML?: (html: string) => string
  readonly clipboardTextSerializer?: (slice: Slice) => string
  readonly decorations?: (state: EditorState) => readonly Decoration[]
  readonly textblockDecorations?: TextblockDecorations
  readonly attributes?: Readonly<Record<string, string>>
}

/** A drag of the document's own content: what is dragged, and whether it moves. */
interface Dragging {
  readonly slice: Slice
  readonly move: boolean
  readonly node?: NodeSelection
}

// ── Descriptions of what is drawn ───────────────────────────────────────

const descOf = new WeakMap<globalThis.Node, Desc>()

abstract class Desc {
  parent: Desc | null = null
  children: Desc[] = []

  constructor(
    public dom: globalThis.Node,
    public contentDOM: HTMLElement | null
  ) {
    descOf.set(dom, this)
  }

  abstract get size(): number
  get border(): number {
    return 0
  }
  get node(): Node | null {
    return null
  }
  /** It draws something that takes no position: a widget, a line break the browser needs. */
  get isZero(): boolean {
    return false
  }

  posBeforeChild(child: Desc): number {
    let pos = this.posAtStart
    for (const each of this.children) {
      if (each === child) return pos
      pos += each.size
    }
    return pos
  }
  get posBefore(): number {
    return this.parent ? this.parent.posBeforeChild(this) : 0
  }
  get posAtStart(): number {
    return this.parent ? this.parent.posBeforeChild(this) + this.border : 0
  }
  get posAfter(): number {
    return this.posBefore + this.size
  }
  get posAtEnd(): number {
    return this.posAtStart + this.size - 2 * this.border
  }

  /** The DOM position for `pos`, relative to its content, leaning to the side `side` names. */
  domFromPos(pos: number, side: number): { node: globalThis.Node; offset: number; atom?: number } {
    const content = this.contentDOM
    if (!content) return { node: this.dom, offset: 0, atom: pos + 1 }
    let index = 0
    let offset = 0
    for (let at = 0; index < this.children.length; index += 1) {
      const child = this.children[index] as Desc
      const end = at + child.size
      if (end > pos || child instanceof HackDesc) {
        offset = pos - at
        break
      }
      at = end
    }
    if (offset) {
      const child = this.children[index] as Desc
      return child.domFromPos(offset - child.border, side)
    }
    // Widgets that come after their position stay after the caret.
    while (index > 0) {
      const previous = this.children[index - 1] as Desc
      if (previous.size || !(previous instanceof WidgetDesc) || previous.side < 0) break
      index -= 1
    }
    if (side <= 0) {
      let previous: Desc | null = null
      let enter = true
      for (; ; index -= 1, enter = false) {
        previous = index ? (this.children[index - 1] as Desc) : null
        if (!previous || previous.dom.parentNode === content) break
      }
      if (previous && side && enter && !previous.border && !previous.isZero && !isDomAtom(previous))
        return previous.domFromPos(previous.size, side)
      return { node: content, offset: previous ? domIndex(previous.dom) + 1 : 0 }
    }
    let next: Desc | null = null
    let enter = true
    for (; ; index += 1, enter = false) {
      next = index < this.children.length ? (this.children[index] as Desc) : null
      if (!next || next.dom.parentNode === content) break
    }
    if (next && enter && !next.border && !next.isZero && !isDomAtom(next))
      return next.domFromPos(0, side)
    return { node: content, offset: next ? domIndex(next.dom) : content.childNodes.length }
  }

  /** The document position of a DOM position inside this description. */
  localPosFromDOM(dom: globalThis.Node, offset: number, bias: number): number {
    const content = this.contentDOM
    if (content?.contains(isElement(dom) ? dom : dom.parentNode)) {
      if (bias < 0) {
        let before: globalThis.Node | null
        if (dom === content) {
          before = dom.childNodes[offset - 1] ?? null
        } else {
          let current = dom
          while (current.parentNode !== content) current = current.parentNode as globalThis.Node
          before = current.previousSibling
        }
        let desc: Desc | undefined
        for (; before; before = before.previousSibling) {
          desc = descOf.get(before)
          if (desc?.parent === this) break
        }
        return before && desc ? this.posBeforeChild(desc) + desc.size : this.posAtStart
      }
      let after: globalThis.Node | null
      if (dom === content) {
        after = dom.childNodes[offset] ?? null
      } else {
        let current = dom
        while (current.parentNode !== content) current = current.parentNode as globalThis.Node
        after = current.nextSibling
      }
      let desc: Desc | undefined
      for (; after; after = after.nextSibling) {
        desc = descOf.get(after)
        if (desc?.parent === this) break
      }
      return after && desc ? this.posBeforeChild(desc) : this.posAtEnd
    }
    let atEnd: boolean | null = null
    if (dom === this.dom && content) {
      atEnd = offset > domIndex(content)
    } else if (content && content !== this.dom && this.dom.contains(content)) {
      atEnd = (dom.compareDocumentPosition(content) & 2) > 0
    } else if (this.dom.firstChild) {
      if (offset === 0) {
        for (let search: globalThis.Node = dom; ; search = search.parentNode as globalThis.Node) {
          if (search === this.dom) {
            atEnd = false
            break
          }
          if (search.previousSibling) break
        }
      }
      if (atEnd === null && offset === dom.childNodes.length) {
        for (let search: globalThis.Node = dom; ; search = search.parentNode as globalThis.Node) {
          if (search === this.dom) {
            atEnd = true
            break
          }
          if (search.nextSibling) break
        }
      }
    }
    return (atEnd === null ? bias > 0 : atEnd) ? this.posAtEnd : this.posAtStart
  }

  /** What is drawn starting at `pos`, relative to this one's content: a node, or a text. */
  descAt(pos: number): Desc | undefined {
    for (let index = 0, offset = 0; index < this.children.length; index += 1) {
      let child = this.children[index] as Desc
      const end = offset + child.size
      if (offset === pos && end !== offset) {
        while (!child.border && child.children.length)
          child = child.children.find((inner) => inner.size > 0) ?? (child.children[0] as Desc)
        return child
      }
      if (pos < end) return child.descAt(pos - offset - child.border)
      offset = end
    }
    return undefined
  }

  /** The node drawn starting at `pos`, relative to this one's content. */
  nodeDescAt(pos: number): NodeDesc | undefined {
    const desc = this.descAt(pos)
    return desc instanceof NodeDesc ? desc : undefined
  }

  destroy(): void {
    for (const child of this.children) child.destroy()
    this.children = []
    descOf.delete(this.dom)
  }
}

class NodeDesc extends Desc {
  /** The node decorations applied to its DOM, and what they set there. */
  applied: readonly NodeDecoration[] = []
  /** The decorations inside it last drawn, as a key, to tell whether it must be drawn again. */
  decoKey = ""

  constructor(
    public current: Node,
    dom: globalThis.Node,
    contentDOM: HTMLElement | null,
    public view: NodeView | null
  ) {
    super(dom, contentDOM)
  }

  override get node(): Node {
    return this.current
  }
  get size(): number {
    return this.current.nodeSize
  }
  override get border(): number {
    return this.current.isLeaf ? 0 : 1
  }

  override destroy(): void {
    this.view?.destroy?.()
    super.destroy()
  }
}

class TextDesc extends Desc {
  constructor(
    public current: Node,
    dom: globalThis.Node,
    public textDOM: Text,
    readonly key: string
  ) {
    super(dom, null)
    descOf.set(textDOM, this)
  }

  override get node(): Node {
    return this.current
  }
  get size(): number {
    return this.current.nodeSize
  }

  override domFromPos(pos: number): { node: globalThis.Node; offset: number } {
    return { node: this.textDOM, offset: pos }
  }

  override localPosFromDOM(dom: globalThis.Node, offset: number, bias: number): number {
    if (dom === this.textDOM) return this.posAtStart + Math.min(offset, this.current.nodeSize)
    return super.localPosFromDOM(dom, offset, bias)
  }

  override destroy(): void {
    descOf.delete(this.textDOM)
    super.destroy()
  }
}

class MarkDesc extends Desc {
  constructor(
    readonly mark: Mark,
    dom: HTMLElement,
    contentDOM: HTMLElement
  ) {
    super(dom, contentDOM)
  }
  get size(): number {
    return this.children.reduce((sum, child) => sum + child.size, 0)
  }
}

class WidgetDesc extends Desc {
  constructor(
    readonly widget: WidgetDecoration,
    dom: HTMLElement
  ) {
    super(dom, null)
  }
  get size(): number {
    return 0
  }
  get side(): number {
    return this.widget.side
  }
  override get isZero(): boolean {
    return true
  }
  override domFromPos(_pos: number, side: number): { node: globalThis.Node; offset: number } {
    const parent = this.dom.parentNode as globalThis.Node
    return { node: parent, offset: domIndex(this.dom) + (side > 0 ? 1 : 0) }
  }
}

/** A line break or image the browser needs to draw a textblock's last line and caret right. */
class HackDesc extends Desc {
  get size(): number {
    return 0
  }
  override get isZero(): boolean {
    return true
  }
  override domFromPos(): { node: globalThis.Node; offset: number } {
    const parent = this.dom.parentNode as globalThis.Node
    return { node: parent, offset: domIndex(this.dom) }
  }
}

// ── Drawing ─────────────────────────────────────────────────────────────

/** Class names the view puts on the DOM, which the editor's styles draw. */
export const VIEW_CLASSES = {
  picked: "is-picked",
  hideSelection: "sixb-hide-selection",
  focused: "is-focused",
  trailingBreak: "sixb-trailing-break",
  separator: "sixb-separator",
  widget: "sixb-widget",
} as const

function decorationKey(decorations: readonly Decoration[], offset: number): string {
  if (decorations.length === 0) return ""
  return decorations
    .map((deco) =>
      deco.kind === "widget"
        ? `w${deco.pos - offset}:${deco.side}:${deco.key}`
        : `${deco.kind[0]}${deco.from - offset}-${deco.to - offset}:${JSON.stringify(deco.attrs)}`
    )
    .join("|")
}

/**
 * The decorations that reach into a node from `from` to `to`, as positions are now; widgets only
 * strictly between `widgetFrom` and `widgetTo` when those are given.
 */
function within(
  decorations: readonly Decoration[],
  from: number,
  to: number,
  widgetFrom = from,
  widgetTo = to
): Decoration[] {
  const found: Decoration[] = []
  for (const deco of decorations) {
    if (deco.kind === "widget") {
      if (deco.pos > widgetFrom && deco.pos < widgetTo) found.push(deco)
    } else if (deco.kind === "node") {
      if (deco.from >= from && deco.to <= to && !(deco.from === from && deco.to === to))
        found.push(deco)
    } else if (deco.from < to && deco.to > from) {
      found.push(deco)
    }
  }
  return found
}

function applyNodeDecorations(desc: NodeDesc, decorations: readonly NodeDecoration[]): void {
  const dom = desc.dom as HTMLElement
  for (const old of desc.applied) {
    for (const [name, value] of Object.entries(old.attrs)) {
      if (name === "class")
        for (const each of (value ?? "").split(" ").filter(Boolean)) dom.classList.remove(each)
      else if (name === "style") dom.style.cssText = dom.style.cssText.replace(value ?? "", "")
      else if (name !== "nodeName") dom.removeAttribute(name)
    }
  }
  for (const deco of decorations) {
    for (const [name, value] of Object.entries(deco.attrs)) {
      if (value === undefined || name === "nodeName") continue
      if (name === "class")
        for (const each of value.split(" ").filter(Boolean)) dom.classList.add(each)
      else if (name === "style") dom.style.cssText += value
      else dom.setAttribute(name, value)
    }
  }
  desc.applied = decorations
}

/** One thing a textblock draws: text, an inline node, or a widget, with its marks. */
interface Piece {
  readonly kind: "text" | "node" | "widget"
  readonly node?: Node
  readonly text?: string
  readonly marks: readonly Mark[]
  readonly decorations: readonly InlineDecoration[]
  readonly widget?: WidgetDecoration
  readonly key: string
}

// ── The view ────────────────────────────────────────────────────────────

export class EditorView {
  state: EditorState
  readonly dom: HTMLElement
  private docDesc: NodeDesc
  private decorations: readonly Decoration[] = []
  private editableNow: boolean
  private readonly listeners: [string, EventListener][] = []
  /** Whether an input method is composing text in the editor. */
  composing = false
  private compositionBlock: NodeDesc | null = null
  private pickedDesc: NodeDesc | null = null
  private mouseDown: {
    x: number
    y: number
    target: EventTarget | null
    picked: number | null
  } | null = null
  /** Set while the view writes the DOM selection, so its own change is not read back. */
  private settingSelection = false
  /** The DOM selection the view last wrote, which a `selectionchange` for it does not read back. */
  private written: {
    anchor: globalThis.Node | null
    anchorOffset: number
    focus: globalThis.Node | null
    focusOffset: number
  } | null = null
  dragging: Dragging | null = null
  private destroyed = false

  constructor(
    mount: HTMLElement,
    state: EditorState,
    private props: ViewProps & {
      readonly dispatch: (tr: Transaction) => void
      readonly editable: boolean
    }
  ) {
    this.state = state
    this.dom = mount
    this.editableNow = props.editable
    this.applyAttributes()
    this.decorations = props.decorations?.(state) ?? []
    this.docDesc = new NodeDesc(state.doc, mount, mount, null)
    this.renderContent(this.docDesc, state.doc, this.decorations, 0)
    this.listen()
    this.selectionToDOM()
  }

  get editable(): boolean {
    return this.editableNow
  }

  get document(): Document {
    return this.dom.ownerDocument
  }

  get window(): Window & typeof globalThis {
    return this.document.defaultView as Window & typeof globalThis
  }

  dispatch(tr: Transaction): void {
    if (!this.destroyed) this.props.dispatch(tr)
  }

  setProps(props: Partial<ViewProps> & { readonly editable?: boolean }): void {
    this.props = { ...this.props, ...props }
    if (props.editable !== undefined && props.editable !== this.editableNow) {
      this.editableNow = props.editable
      this.applyAttributes()
    }
    this.updateState(this.state)
  }

  private applyAttributes(): void {
    const dom = this.dom
    for (const [name, value] of Object.entries(this.props.attributes ?? {})) {
      if (name === "class")
        for (const each of value.split(" ").filter(Boolean)) dom.classList.add(each)
      else dom.setAttribute(name, value)
    }
    dom.contentEditable = this.editableNow ? "true" : "false"
    dom.setAttribute("translate", "no")
    // Only an editor that takes typing takes the focus.
    if (this.editableNow) dom.setAttribute("tabindex", "0")
    else dom.removeAttribute("tabindex")
  }

  /** Shows a new state: redraws what changed, and selects what it selects. */
  updateState(state: EditorState): void {
    const previous = this.state
    this.state = state
    const decorations = this.props.decorations?.(state) ?? []
    const redraw =
      state.doc !== previous.doc ||
      decorationKey(decorations, 0) !== decorationKey(this.decorations, 0)
    this.decorations = decorations
    if (redraw) {
      this.settingSelection = true
      try {
        this.updateNode(this.docDesc, state.doc, decorations, 0)
      } finally {
        this.settingSelection = false
      }
    }
    this.selectionToDOM()
  }

  // ── Drawing ─────────────────────────────────────────────────────────

  private createNode(
    node: Node,
    decorations: readonly Decoration[],
    pos: number,
    parent: Desc
  ): NodeDesc {
    const factory = this.props.nodeViews?.[node.type.name]
    let desc: NodeDesc
    if (factory) {
      let made: NodeDesc | null = null
      const view = factory(node, this, () => (made?.parent ? made.posBefore : undefined))
      made = new NodeDesc(node, view.dom, view.contentDOM ?? null, view)
      desc = made
    } else {
      const spec = node.type.spec.toDOM?.(node) ?? (["div", 0] as DOMSpec)
      const rendered = renderSpec(this.document, spec)
      desc = new NodeDesc(node, rendered.dom, rendered.contentDOM, null)
    }
    // A node without editable content, drawn or a view's own, is not typed into, and is dragged
    // whole when its type says.
    const dom = desc.dom
    if (!desc.contentDOM && !node.isText && dom.nodeName !== "BR" && isElement(dom)) {
      if (!dom.hasAttribute("contenteditable")) (dom as HTMLElement).contentEditable = "false"
      if (node.type.spec.draggable) (dom as HTMLElement).draggable = true
    }
    desc.parent = parent
    const own = decorations.filter(
      (deco): deco is NodeDecoration =>
        deco.kind === "node" && deco.from === pos && deco.to === pos + node.nodeSize
    )
    applyNodeDecorations(desc, own)
    if (desc.contentDOM) this.renderContent(desc, node, decorations, pos + 1)
    desc.decoKey = decorationKey(decorations, pos)
    return desc
  }

  /** Brings a node's description to `node`; false when it must be drawn again instead. */
  private updateNode(
    desc: NodeDesc,
    node: Node,
    decorations: readonly Decoration[],
    pos: number
  ): boolean {
    const key = decorationKey(decorations, pos)
    if (desc.current === node && desc.decoKey === key) return true
    if (desc.view) {
      if (desc.current.type !== node.type || (desc.view.update && !desc.view.update(node)))
        return false
      if (!desc.view.update && !node.sameMarkup(desc.current)) return false
    } else if (desc.parent && !node.sameMarkup(desc.current)) {
      return false
    }
    desc.current = node
    if (desc.parent) {
      const own = decorations.filter(
        (deco): deco is NodeDecoration =>
          deco.kind === "node" && deco.from === pos && deco.to === pos + node.nodeSize
      )
      applyNodeDecorations(desc, own)
    }
    if (desc.contentDOM) this.renderContent(desc, node, decorations, desc.parent ? pos + 1 : 0)
    desc.decoKey = key
    return true
  }

  private renderContent(
    desc: NodeDesc,
    node: Node,
    decorations: readonly Decoration[],
    start: number
  ): void {
    if (node.inlineContent) this.renderInline(desc, node, decorations, start)
    else this.renderBlocks(desc, node, decorations, start)
  }

  /** A container's blocks: each kept, updated or drawn anew, and put in order. */
  private renderBlocks(
    desc: NodeDesc,
    node: Node,
    decorations: readonly Decoration[],
    start: number
  ): void {
    const content = desc.contentDOM as HTMLElement
    const old = desc.children
    const reserved = new Set<Desc>()
    const byNode = new Map<Node, NodeDesc[]>()
    for (const child of old) {
      if (!(child instanceof NodeDesc)) continue
      const list = byNode.get(child.current)
      if (list) list.push(child)
      else byNode.set(child.current, [child])
    }
    // What is kept as it is, found first, so nothing else takes it.
    const plan: (Desc | null)[] = []
    const childDecos: Decoration[][] = []
    node.forEach((child, offset, index) => {
      const pos = start + offset
      const inner = decorations.length
        ? within(decorations, pos - 1, pos + child.nodeSize + 1, pos, pos + child.nodeSize)
        : decorations
      childDecos[index] = inner as Decoration[]
      const key = decorationKey(inner, pos)
      const same = byNode.get(child)?.find((each) => !reserved.has(each) && each.decoKey === key)
      if (same) reserved.add(same)
      plan[index] = same ?? null
    })
    const unreserved = old.filter(
      (each) => each instanceof NodeDesc && !reserved.has(each)
    ) as NodeDesc[]
    let cursor = 0
    const children: Desc[] = []
    // The widgets between blocks, by where they stand, in the order of their sides.
    const widgetsAt = new Map<number, WidgetDecoration[]>()
    for (const deco of decorations) {
      if (deco.kind !== "widget") continue
      const list = widgetsAt.get(deco.pos)
      if (list) list.push(deco)
      else widgetsAt.set(deco.pos, [deco])
    }
    for (const list of widgetsAt.values()) list.sort((a, b) => a.side - b.side)
    const placeWidgets = (pos: number) => {
      for (const widget of widgetsAt.get(pos) ?? [])
        children.push(this.widgetDesc(widget, old, desc))
    }
    node.forEach((child, offset, index) => {
      const pos = start + offset
      placeWidgets(pos)
      let made = plan[index] ?? null
      if (!made) {
        const inner = childDecos[index] ?? []
        while (cursor < unreserved.length) {
          const candidate = unreserved[cursor] as NodeDesc
          cursor += 1
          if (
            candidate.current.type === child.type &&
            this.updateNode(candidate, child, inner, pos)
          ) {
            reserved.add(candidate)
            made = candidate
            break
          }
          cursor -= 1
          break
        }
        if (!made) made = this.createNode(child, inner, pos, desc)
      } else if (
        made instanceof NodeDesc &&
        made.decoKey !== decorationKey(childDecos[index] ?? [], pos)
      ) {
        this.updateNode(made, child, childDecos[index] ?? [], pos)
      }
      made.parent = desc
      children.push(made)
    })
    placeWidgets(start + node.content.size)
    const kept = new Set(children)
    for (const each of old) {
      if (!kept.has(each)) {
        if (each.dom.parentNode === content) content.removeChild(each.dom)
        each.destroy()
      }
    }
    desc.children = children
    this.syncDOM(
      content,
      children.map((each) => each.dom)
    )
  }

  private widgetDesc(widget: WidgetDecoration, old: readonly Desc[], parent: Desc): WidgetDesc {
    // The same widget, wherever edits before it moved it to.
    const kept = old.find(
      (each): each is WidgetDesc => each instanceof WidgetDesc && each.widget.key === widget.key
    )
    if (kept) {
      kept.parent = parent
      return kept
    }
    const dom = widget.toDOM()
    dom.classList.add(VIEW_CLASSES.widget)
    if (!dom.hasAttribute("contenteditable")) dom.contentEditable = "false"
    const made = new WidgetDesc(widget, dom)
    made.parent = parent
    return made
  }

  /** Puts `wanted` in `parent` in order, moving as few nodes as it can. */
  private syncDOM(parent: HTMLElement, wanted: readonly globalThis.Node[]): void {
    let current = parent.firstChild
    for (const node of wanted) {
      if (current === node) {
        current = current.nextSibling
      } else {
        parent.insertBefore(node, current)
      }
    }
    while (current) {
      const next = current.nextSibling
      parent.removeChild(current)
      current = next
    }
  }

  /** What a textblock draws, in order. */
  private piecesOf(node: Node, decorations: readonly Decoration[], start: number): Piece[] {
    const inline: InlineDecoration[] = [
      ...(this.props.textblockDecorations?.(node) ?? []).map((deco) => ({
        ...deco,
        from: deco.from + start,
        to: deco.to + start,
      })),
      ...decorations.filter((deco): deco is InlineDecoration => deco.kind === "inline"),
    ]
    const widgets = decorations.filter((deco): deco is WidgetDecoration => deco.kind === "widget")
    const pieces: Piece[] = []
    const addWidgets = (pos: number, nextMarks: readonly Mark[], currentMarks: readonly Mark[]) => {
      for (const widget of widgets
        .filter((each) => each.pos === pos)
        .sort((a, b) => a.side - b.side)) {
        pieces.push({
          kind: "widget",
          widget,
          marks: widget.side >= 0 ? nextMarks : currentMarks,
          decorations: [],
          key: `w:${widget.key}`,
        })
      }
    }
    let marks: readonly Mark[] = []
    node.forEach((child, offset) => {
      const from = start + offset
      addWidgets(from, child.marks, marks)
      if (child.isText) {
        const text = child.text ?? ""
        const cuts = new Set<number>([0, text.length])
        for (const deco of inline) {
          if (deco.from > from && deco.from < from + text.length) cuts.add(deco.from - from)
          if (deco.to > from && deco.to < from + text.length) cuts.add(deco.to - from)
        }
        // A widget inside the text, a collaborator's caret, cuts it where it stands.
        for (const widget of widgets)
          if (widget.pos > from && widget.pos < from + text.length) cuts.add(widget.pos - from)
        const points = [...cuts].sort((a, b) => a - b)
        for (let index = 0; index < points.length - 1; index += 1) {
          const a = points[index] as number
          const b = points[index + 1] as number
          if (a > 0) addWidgets(from + a, child.marks, child.marks)
          const covering = inline.filter(
            (deco) => deco.from <= from + a && deco.to >= from + b && deco.to > deco.from
          )
          pieces.push({
            kind: "text",
            node: child,
            text: text.slice(a, b),
            marks: child.marks,
            decorations: covering,
            key: `t:${markKey(child.marks)}:${covering.map((deco) => JSON.stringify(deco.attrs)).join(",")}`,
          })
        }
      } else {
        const covering = inline.filter(
          (deco) => deco.from <= from && deco.to >= from + child.nodeSize
        )
        pieces.push({
          kind: "node",
          node: child,
          marks: child.marks,
          decorations: covering,
          key: `n:${child.type.name}:${markKey(child.marks)}`,
        })
      }
      marks = child.marks
    })
    addWidgets(start + node.content.size, [], marks)
    return pieces
  }

  /** A textblock's inline content: its text updated in place when only text changed, else drawn again. */
  private renderInline(
    desc: NodeDesc,
    node: Node,
    decorations: readonly Decoration[],
    start: number
  ): void {
    const content = desc.contentDOM as HTMLElement
    const pieces = this.piecesOf(node, decorations, start)
    const previous = (desc as NodeDesc & { pieces?: Piece[] }).pieces
    if (previous && this.updateText(desc, previous, pieces)) {
      ;(desc as NodeDesc & { pieces?: Piece[] }).pieces = pieces
      return
    }
    if (this.composing && desc === this.compositionBlock) return
    for (const child of desc.children) child.destroy()
    desc.children = []
    content.replaceChildren()
    const stack: { mark: Mark; desc: MarkDesc }[] = []
    const container = () => (stack.length ? stack[stack.length - 1]?.desc : desc) as Desc
    let lastLeaf: Desc | null = null
    let lastParent: Desc = desc
    for (const piece of pieces) {
      let keep = 0
      while (
        keep < stack.length &&
        keep < piece.marks.length &&
        (stack[keep] as { mark: Mark }).mark.eq(piece.marks[keep] as Mark)
      )
        keep += 1
      stack.length = keep
      for (let index = keep; index < piece.marks.length; index += 1) {
        const mark = piece.marks[index] as Mark
        const rendered = renderSpec(this.document, mark.type.spec.toDOM?.(mark) ?? ["span", 0])
        const markDesc = new MarkDesc(
          mark,
          rendered.dom as HTMLElement,
          (rendered.contentDOM ?? rendered.dom) as HTMLElement
        )
        const parent = container()
        markDesc.parent = parent
        parent.children.push(markDesc)
        ;(parent.contentDOM as HTMLElement).append(rendered.dom)
        stack.push({ mark, desc: markDesc })
      }
      const parent = container()
      let leaf: Desc
      if (piece.kind === "text") {
        const text = this.document.createTextNode(piece.text ?? "")
        const dom = wrapDecorations(this.document, text, piece.decorations)
        leaf = new TextDesc(
          (piece.node as Node).type.schema.textNode(piece.text ?? "", piece.marks),
          dom,
          text,
          piece.key
        )
      } else if (piece.kind === "node") {
        const made = this.createNode(piece.node as Node, [], 0, parent)
        if (piece.decorations.length && isElement(made.dom)) {
          for (const deco of piece.decorations) applyInlineAttrs(made.dom, deco.attrs)
        }
        leaf = made
      } else {
        leaf = this.widgetDesc(piece.widget as WidgetDecoration, [], parent)
      }
      leaf.parent = parent
      parent.children.push(leaf)
      ;(parent.contentDOM as HTMLElement).append(leaf.dom)
      lastLeaf = leaf
      lastParent = parent
    }
    // The browser draws no line for a textblock that is empty or ends in a line break, and puts
    // the caret badly after an uneditable node at its end.
    const last = pieces.filter((piece) => piece.kind !== "widget").at(-1)
    if (!last || last.kind !== "text" || /\n$/.test(last.text ?? "")) {
      if (last && lastLeaf && isElement(lastLeaf.dom) && lastLeaf.dom.contentEditable === "false") {
        const image = this.document.createElement("img")
        image.className = VIEW_CLASSES.separator
        image.alt = ""
        const hack = new HackDesc(image, null)
        hack.parent = lastParent
        lastParent.children.push(hack)
        ;(lastParent.contentDOM as HTMLElement).append(image)
      }
      const br = this.document.createElement("br")
      br.className = VIEW_CLASSES.trailingBreak
      const hack = new HackDesc(br, null)
      hack.parent = desc
      desc.children.push(hack)
      content.append(br)
    }
    ;(desc as NodeDesc & { pieces?: Piece[] }).pieces = pieces
  }

  /** Updates a textblock's text in place when it draws the same pieces with other words. */
  private updateText(
    desc: NodeDesc,
    previous: readonly Piece[],
    pieces: readonly Piece[]
  ): boolean {
    if (previous.length !== pieces.length) return false
    for (let index = 0; index < pieces.length; index += 1) {
      const before = previous[index] as Piece
      const after = pieces[index] as Piece
      if (before.key !== after.key) return false
      if (after.kind === "node" && !(before.node as Node).eq(after.node as Node)) return false
      if (after.kind === "widget" && before.widget?.key !== after.widget?.key) return false
      if (after.kind === "text" && (!after.text || !before.text)) return false
      if (after.kind === "text" && /\n$/.test(after.text ?? "") !== /\n$/.test(before.text ?? ""))
        return false
    }
    const leaves: TextDesc[] = []
    const collect = (each: Desc) => {
      if (each instanceof TextDesc) leaves.push(each)
      else if (each instanceof MarkDesc) each.children.forEach(collect)
    }
    desc.children.forEach(collect)
    const texts = pieces.filter((piece) => piece.kind === "text")
    if (leaves.length !== texts.length) return false
    texts.forEach((piece, index) => {
      const leaf = leaves[index] as TextDesc
      if (leaf.textDOM.data !== piece.text) leaf.textDOM.data = piece.text ?? ""
      leaf.current = (piece.node as Node).type.schema.textNode(piece.text ?? "", piece.marks)
    })
    // Inline nodes kept as they were now stand for the next document's.
    let node = 0
    const nodes = pieces.filter((piece) => piece.kind === "node")
    const update = (each: Desc) => {
      if (each instanceof NodeDesc) {
        each.current = nodes[node]?.node as Node
        node += 1
      } else if (each instanceof MarkDesc) each.children.forEach(update)
    }
    desc.children.forEach(update)
    return true
  }

  // ── Positions ───────────────────────────────────────────────────────

  private nearestDesc(dom: globalThis.Node, onlyNodes = false): Desc | null {
    for (let current: globalThis.Node | null = dom; current; current = current.parentNode) {
      const desc = descOf.get(current)
      if (!desc) continue
      if (!this.docDesc.dom.contains(desc.dom) && desc !== this.docDesc) return null
      if (onlyNodes && !(desc instanceof NodeDesc)) continue
      // Inside a node view's own DOM, outside its content: the view's node.
      let inner: Desc | null = desc
      for (let parent = desc.parent; parent; parent = parent.parent) {
        if (
          parent.contentDOM &&
          !parent.contentDOM.contains(current) &&
          parent.dom.contains(current)
        )
          inner = parent
      }
      return inner
    }
    return null
  }

  /** The document position of a DOM position; -1 when it is not in the editor. */
  posFromDOM(dom: globalThis.Node, offset: number, bias = 0): number {
    const desc = this.nearestDesc(dom)
    if (!desc) return -1
    return desc.localPosFromDOM(dom, offset, bias)
  }

  /** The DOM position of a document position. */
  domFromPos(pos: number, side = 0): { node: globalThis.Node; offset: number; atom?: number } {
    return this.docDesc.domFromPos(pos, side)
  }

  /** The DOM of what starts at `pos`: a node's element, or a text node. */
  nodeDOM(pos: number): globalThis.Node | null {
    const desc = this.docDesc.descAt(pos)
    if (!desc) return null
    return desc instanceof TextDesc ? desc.textDOM : desc.dom
  }

  /** Where a position is drawn, as a rectangle as thin as a caret. */
  coordsAtPos(pos: number, side = 1): Rect {
    const { node, offset, atom } = this.domFromPos(pos, side < 0 ? -1 : 1)
    if (isText(node)) {
      const value = node.nodeValue ?? ""
      if (side < 0 ? !offset : offset === value.length)
        return singleRect(textRange(node, offset, offset), side)
      let from = offset
      let to = offset
      let takeSide = side < 0 ? 1 : -1
      if (side < 0 && !offset) {
        to += 1
        takeSide = -1
      } else if (side >= 0 && offset === value.length) {
        from -= 1
        takeSide = 1
      } else if (side < 0) {
        from -= 1
      } else {
        to += 1
      }
      return flattenV(singleRect(textRange(node, from, to), takeSide), takeSide < 0)
    }
    const $dom = this.state.doc.resolve(pos - (atom ?? 0))
    if (!$dom.parent.inlineContent) {
      if (atom === undefined && offset && (side < 0 || offset === nodeSize(node))) {
        const before = node.childNodes[offset - 1]
        if (isElement(before)) return flattenH(before.getBoundingClientRect(), false)
      }
      if (atom === undefined && offset < nodeSize(node)) {
        const after = node.childNodes[offset]
        if (isElement(after)) return flattenH(after.getBoundingClientRect(), true)
      }
      return flattenH((node as HTMLElement).getBoundingClientRect(), side >= 0)
    }
    if (atom === undefined && offset && (side < 0 || offset === nodeSize(node))) {
      const before = node.childNodes[offset - 1]
      const target = isText(before)
        ? textRange(before, nodeSize(before))
        : isElement(before) && (before.nodeName !== "BR" || !before.nextSibling)
          ? before
          : null
      if (target) return flattenV(singleRect(target, 1), false)
    }
    if (atom === undefined && offset < nodeSize(node)) {
      let after: globalThis.Node | null = node.childNodes[offset] ?? null
      while (after && descOf.get(after) instanceof WidgetDesc) after = after.nextSibling
      const target = !after
        ? null
        : isText(after)
          ? textRange(after, 0, 0)
          : isElement(after)
            ? after
            : null
      if (target) return flattenV(singleRect(target, -1), true)
    }
    return flattenV(
      singleRect(isText(node) ? textRange(node) : (node as HTMLElement), -side),
      side >= 0
    )
  }

  /** The position at a point, and the innermost node the point is inside. */
  posAtCoords(coords: { left: number; top: number }): { pos: number; inside: number } | null {
    const document = this.document
    const caret = caretFromPoint(document, coords.left, coords.top)
    let element = document.elementFromPoint(coords.left, coords.top) as HTMLElement | null
    if (!element || !this.dom.contains(element)) {
      const box = this.dom.getBoundingClientRect()
      if (!inRect(coords, box)) return null
      element = elementAtPoint(this.dom, coords, box)
    }
    const parent = element.parentNode
    if (
      parent &&
      /^li$/i.test(parent.nodeName) &&
      coords.left < element.getBoundingClientRect().left
    ) {
      element = parent as HTMLElement
    }
    let pos: number | null = null
    if (caret) {
      let { node, offset } = caret
      if (offset && isElement(node)) {
        const previous = node.childNodes[offset - 1]
        if (
          isElement(previous) &&
          previous.contentEditable === "false" &&
          previous.getBoundingClientRect().top >= coords.top
        )
          offset -= 1
      }
      if (
        node === this.dom &&
        offset === node.childNodes.length - 1 &&
        isElement(node.lastChild) &&
        coords.top > node.lastChild.getBoundingClientRect().bottom
      ) {
        pos = this.state.doc.content.size
      } else if (
        offset === 0 ||
        !isElement(node) ||
        node.childNodes[offset - 1]?.nodeName !== "BR"
      ) {
        pos = this.posFromCaret(node, offset, coords)
      }
    }
    if (pos === null || pos < 0) pos = this.posFromElement(element, coords)
    const desc = this.nearestDesc(element, true)
    return { pos, inside: desc && desc !== this.docDesc ? desc.posAtStart - desc.border : -1 }
  }

  private posFromCaret(
    node: globalThis.Node,
    offset: number,
    coords: { left: number; top: number }
  ): number {
    let outside = -1
    for (let current: globalThis.Node = node, sawBlock = false; ; ) {
      if (current === this.dom) break
      const desc = this.nearestDesc(current, true)
      if (!desc || desc === this.docDesc) break
      const descNode = desc.node as Node
      const measured =
        isElement(desc.dom) && ((descNode.isBlock && desc.parent) || !desc.contentDOM)
      const rect = measured ? (desc.dom as Element).getBoundingClientRect() : undefined
      if (rect && (rect.width || rect.height)) {
        if (descNode.isBlock && desc.parent && !/^T(R|BODY|HEAD|FOOT)$/.test(desc.dom.nodeName)) {
          if ((!sawBlock && rect.left > coords.left) || rect.top > coords.top)
            outside = desc.posBefore
          else if ((!sawBlock && rect.right < coords.left) || rect.bottom < coords.top)
            outside = desc.posAfter
          sawBlock = true
        }
        if (!desc.contentDOM && outside < 0 && !descNode.isText) {
          const before = descNode.isBlock
            ? coords.top < (rect.top + rect.bottom) / 2
            : coords.left < (rect.left + rect.right) / 2
          return before ? desc.posBefore : desc.posAfter
        }
      }
      current = desc.dom.parentNode as globalThis.Node
    }
    return outside > -1 ? outside : this.posFromDOM(node, offset, -1)
  }

  private posFromElement(element: HTMLElement, coords: { left: number; top: number }): number {
    const { node, offset } = offsetInNode(element, coords)
    let bias = -1
    if (isElement(node) && !node.firstChild) {
      const rect = node.getBoundingClientRect()
      bias = rect.left !== rect.right && coords.left > (rect.left + rect.right) / 2 ? 1 : -1
    }
    return this.posFromDOM(node, offset, bias)
  }

  /** Whether the caret is at the edge of its textblock in a direction, as drawn. */
  endOfTextblock(dir: "up" | "down" | "left" | "right" | "forward" | "backward"): boolean {
    const { $head } = this.state.selection
    if (!$head.parent.inlineContent) return true
    if (dir === "up" || dir === "down") {
      const block = this.nodeDOM($head.before()) as HTMLElement | null
      if (!block || !isElement(block)) return true
      const caret = this.coordsAtPos($head.pos, dir === "up" ? -1 : 1)
      const boxes = this.lineBoxes(block)
      if (!boxes.length) return true
      const first = boxes[0] as DOMRect
      const last = boxes[boxes.length - 1] as DOMRect
      if (dir === "up")
        return (
          caret.top - 1 <= first.top + 0.5 ||
          Math.abs(caret.top - first.top) < (first.bottom - first.top) / 2
        )
      return (
        caret.bottom + 1 >= last.bottom - 0.5 ||
        Math.abs(caret.bottom - last.bottom) < (last.bottom - last.top) / 2
      )
    }
    const backward = dir === "left" || dir === "backward"
    return backward ? $head.parentOffset === 0 : $head.parentOffset === $head.parent.content.size
  }

  private lineBoxes(block: HTMLElement): DOMRect[] {
    const range = this.document.createRange()
    range.selectNodeContents(block)
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0)
    return rects.length ? rects : [block.getBoundingClientRect()]
  }

  // ── Selection ───────────────────────────────────────────────────────

  /** Whether the editor itself has the focus: not a field or a button inside it. */
  hasFocus(): boolean {
    return this.document.activeElement === this.dom
  }

  focus(): void {
    if (this.editableNow) this.dom.focus({ preventScroll: true })
    this.selectionToDOM(true)
  }

  /** Puts the browser's selection where the editor's is. */
  selectionToDOM(force = false): void {
    const selection = this.state.selection
    this.syncPicked(selection)
    if (!(this.editableNow ? this.hasFocus() : this.ownsSelection()) && !force) return
    if (this.composing) return
    const domSelection = this.document.getSelection()
    if (!domSelection) return
    const anchor = this.domFromPos(selection.anchor, selection.anchor ? -1 : 1)
    const head =
      selection.head === selection.anchor
        ? anchor
        : this.domFromPos(selection.head, selection.head ? -1 : 1)
    const hasDesc = (node: globalThis.Node) => descOf.get(node) instanceof NodeDesc
    const same =
      isEquivalentPosition(
        anchor.node,
        anchor.offset,
        domSelection.anchorNode,
        domSelection.anchorOffset,
        hasDesc
      ) &&
      isEquivalentPosition(
        head.node,
        head.offset,
        domSelection.focusNode,
        domSelection.focusOffset,
        hasDesc
      )
    if (!same || force) {
      this.settingSelection = true
      try {
        domSelection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset)
      } catch {
        // A position the browser will not select: leave its own.
      } finally {
        this.settingSelection = false
      }
    }
    // What the browser shows now is the editor's selection, written or already there, so the
    // `selectionchange` that follows reads nothing back.
    this.written = {
      anchor: domSelection.anchorNode,
      anchorOffset: domSelection.anchorOffset,
      focus: domSelection.focusNode,
      focusOffset: domSelection.focusOffset,
    }
    this.dom.classList.toggle(
      VIEW_CLASSES.hideSelection,
      !(selection instanceof TextSelection) && !(selection instanceof AllSelection)
    )
  }

  private syncPicked(selection: Selection): void {
    const desc =
      selection instanceof NodeSelection ? (this.docDesc.nodeDescAt(selection.from) ?? null) : null
    if (desc === this.pickedDesc) return
    if (this.pickedDesc) {
      if (this.pickedDesc.view?.deselectNode) this.pickedDesc.view.deselectNode()
      else if (isElement(this.pickedDesc.dom))
        this.pickedDesc.dom.classList.remove(VIEW_CLASSES.picked)
    }
    if (desc) {
      if (desc.view?.selectNode) desc.view.selectNode()
      else if (isElement(desc.dom)) desc.dom.classList.add(VIEW_CLASSES.picked)
    }
    this.pickedDesc = desc
  }

  private ownsSelection(): boolean {
    const domSelection = this.document.getSelection()
    if (!domSelection?.anchorNode) return this.hasFocus()
    return this.dom.contains(
      domSelection.anchorNode.nodeType === 3
        ? domSelection.anchorNode.parentNode
        : domSelection.anchorNode
    )
  }

  /** The editor's selection as the browser's is now. */
  selectionFromDOM(origin: "pointer" | "key" | null = null): Selection | null {
    const domSelection = this.document.getSelection()
    if (!domSelection?.focusNode || !domSelection.anchorNode) return null
    const doc = this.state.doc
    let nearest = this.nearestDesc(domSelection.focusNode)
    const inWidget = nearest instanceof WidgetDesc
    const head = this.posFromDOM(domSelection.focusNode, domSelection.focusOffset, 1)
    if (head < 0) return null
    const $head = doc.resolve(head)
    let anchor: number
    let selection: Selection | null = null
    if (domSelection.isCollapsed) {
      anchor = head
      while (nearest && !nearest.node) nearest = nearest.parent
      const node = nearest?.node
      if (
        nearest &&
        node &&
        node.isAtom &&
        NodeSelection.isSelectable(node) &&
        nearest.parent &&
        !(node.isInline && isOnEdge(domSelection.focusNode, domSelection.focusOffset, nearest.dom))
      ) {
        const pos = nearest.posBefore
        selection = new NodeSelection(head === pos ? $head : doc.resolve(pos))
      }
    } else {
      anchor = this.posFromDOM(domSelection.anchorNode, domSelection.anchorOffset, 1)
      if (anchor < 0) return null
    }
    const $anchor = doc.resolve(anchor)
    if (!selection) {
      const bias =
        origin === "pointer" || (this.state.selection.head < $head.pos && !inWidget) ? 1 : -1
      selection = this.selectionBetween($anchor, $head, bias)
    }
    return selection
  }

  /** A selection between two positions: text, unless the editor makes another kind there. */
  selectionBetween($anchor: ResolvedPos, $head: ResolvedPos, bias?: number): Selection {
    return (
      this.props.createSelectionBetween?.(this, $anchor, $head) ??
      TextSelection.between($anchor, $head, bias)
    )
  }

  private readSelection(origin: "pointer" | "key" | null = null): void {
    if (this.settingSelection || this.composing) return
    const domSelection = this.document.getSelection()
    const written = this.written
    if (
      written &&
      domSelection &&
      domSelection.anchorNode === written.anchor &&
      domSelection.anchorOffset === written.anchorOffset &&
      domSelection.focusNode === written.focus &&
      domSelection.focusOffset === written.focusOffset
    ) {
      return
    }
    const selection = this.selectionFromDOM(origin)
    if (!selection || selection.eq(this.state.selection)) return
    const tr = this.state.tr.setSelection(selection)
    if (origin === "pointer") tr.setMeta("pointer", true)
    this.dispatch(tr)
  }

  // ── Events ──────────────────────────────────────────────────────────

  private on(target: EventTarget, type: string, handler: (event: Event) => void): void {
    const listener = (event: Event) => {
      if (this.destroyed) return
      if (this.props.handleDOMEvents?.[type]?.(this, event)) {
        event.preventDefault()
        return
      }
      handler(event)
    }
    target.addEventListener(type, listener)
    this.listeners.push([type, listener])
    if (target !== this.dom) this.listeners.push([`doc:${type}`, listener])
  }

  private stopped(event: Event): boolean {
    const target = event.target as globalThis.Node | null
    if (!target || target === this.dom) return false
    for (
      let current: globalThis.Node | null = target;
      current && current !== this.dom;
      current = current.parentNode
    ) {
      const desc = descOf.get(current)
      if (desc instanceof NodeDesc && desc.view?.stopEvent?.(event)) return true
    }
    return false
  }

  private listen(): void {
    this.on(this.dom, "keydown", (event) => this.onKeyDown(event as KeyboardEvent))
    this.on(this.dom, "beforeinput", (event) => this.onBeforeInput(event as InputEvent))
    this.on(this.dom, "input", (event) => this.onInput(event as InputEvent))
    this.on(this.dom, "compositionstart", () => this.onCompositionStart())
    this.on(this.dom, "compositionend", (event) => this.onCompositionEnd(event as CompositionEvent))
    this.on(this.dom, "mousedown", (event) => this.onMouseDown(event as MouseEvent))
    this.on(this.dom, "copy", (event) => this.onCopy(event as ClipboardEvent, false))
    this.on(this.dom, "cut", (event) => this.onCopy(event as ClipboardEvent, true))
    this.on(this.dom, "paste", (event) => this.onPaste(event as ClipboardEvent))
    this.on(this.dom, "dragstart", (event) => this.onDragStart(event as DragEvent))
    this.on(this.dom, "dragover", (event) => this.onDragOver(event as DragEvent))
    this.on(this.dom, "drop", (event) => this.onDrop(event as DragEvent))
    this.on(this.dom, "dragend", () => {
      this.dragging = null
    })
    this.on(this.dom, "focus", () => {
      this.dom.classList.add(VIEW_CLASSES.focused)
      this.props.onFocusChange?.(this, true)
    })
    this.on(this.dom, "blur", (event) => {
      const related = (event as FocusEvent).relatedTarget as globalThis.Node | null
      if (related && this.dom.contains(related)) return
      this.dom.classList.remove(VIEW_CLASSES.focused)
      this.props.onFocusChange?.(this, false, event as FocusEvent)
    })
    const onSelectionChange = () => {
      if (this.mouseDown) return
      if (this.hasFocus()) this.readSelection()
    }
    this.document.addEventListener("selectionchange", onSelectionChange)
    this.listeners.push(["doc:selectionchange", onSelectionChange as EventListener])
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.editableNow || this.stopped(event)) return
    if (event.isComposing || event.keyCode === 229) return
    // A pending DOM selection the browser made (a click, a shift-arrow) is the editor's first.
    this.readSelection()
    if (this.props.handleKeyDown?.(this, event) || this.captureKey(event)) {
      event.preventDefault()
    }
  }

  /** What the view does with keys no binding took: arrows around picked nodes, the edges of blocks. */
  private captureKey(event: KeyboardEvent): boolean {
    const mods =
      (event.ctrlKey ? "c" : "") +
      (event.metaKey ? "m" : "") +
      (event.altKey ? "a" : "") +
      (event.shiftKey ? "s" : "")
    switch (event.key) {
      case "Backspace":
        return this.stopNativeDelete(-1)
      case "Delete":
        return !event.shiftKey && this.stopNativeDelete(1)
      case "Enter":
      case "Escape":
        return true
      case "ArrowLeft":
        return this.selectHorizontally(-1, mods)
      case "ArrowRight":
        return this.selectHorizontally(1, mods)
      case "ArrowUp":
        return this.selectVertically(-1, mods)
      case "ArrowDown":
        return this.selectVertically(1, mods)
    }
    // ⌘B, ⌘I, ⌘Y and ⌘Z do nothing the browser would do to the DOM.
    return mods === (isMac ? "m" : "c") && ["b", "i", "y", "z"].includes(event.key.toLowerCase())
  }

  private stopNativeDelete(dir: number): boolean {
    const selection = this.state.selection
    if (!(selection instanceof TextSelection)) return true
    const { $head, $anchor, empty } = selection
    if (!$head.sameParent($anchor)) return true
    if (!empty) return false
    if (this.endOfTextblock(dir > 0 ? "forward" : "backward")) return true
    const next = !$head.textOffset && (dir < 0 ? $head.nodeBefore : $head.nodeAfter)
    if (next && !next.isText) {
      const tr = this.state.tr
      if (dir < 0) tr.delete($head.pos - next.nodeSize, $head.pos)
      else tr.delete($head.pos, $head.pos + next.nodeSize)
      this.dispatch(tr)
      return true
    }
    return false
  }

  private apply(selection: Selection): boolean {
    this.dispatch(this.state.tr.setSelection(selection).scrollIntoView())
    return true
  }

  private moveSelectionBlock(dir: number): Selection | null {
    const { $anchor, $head } = this.state.selection
    const $side = dir > 0 ? $anchor.max($head) : $anchor.min($head)
    const $start = !$side.parent.inlineContent
      ? $side
      : $side.depth
        ? this.state.doc.resolve(dir > 0 ? $side.after() : $side.before())
        : null
    return $start && Selection.findFrom($start, dir)
  }

  private selectHorizontally(dir: number, mods: string): boolean {
    const selection = this.state.selection
    if (selection instanceof TextSelection) {
      if (mods.includes("s")) {
        const { $head } = selection
        const node = $head.textOffset ? null : dir < 0 ? $head.nodeBefore : $head.nodeAfter
        if (!node || node.isText || !node.isLeaf) return false
        const $newHead = this.state.doc.resolve($head.pos + node.nodeSize * (dir < 0 ? -1 : 1))
        return this.apply(new TextSelection(selection.$anchor, $newHead))
      }
      if (!selection.empty) return false
      if (this.endOfTextblock(dir > 0 ? "forward" : "backward")) {
        const next = this.moveSelectionBlock(dir)
        if (next instanceof NodeSelection) return this.apply(next)
        return false
      }
      if (mods.includes("m")) return false
      const { $head } = selection
      const node = $head.textOffset ? null : dir < 0 ? $head.nodeBefore : $head.nodeAfter
      if (!node || node.isText) return false
      const nodePos = dir < 0 ? $head.pos - node.nodeSize : $head.pos
      const desc = this.docDesc.nodeDescAt(nodePos)
      if (!(node.isAtom || (desc && !desc.contentDOM))) return false
      if (NodeSelection.isSelectable(node))
        return this.apply(
          new NodeSelection(dir < 0 ? this.state.doc.resolve($head.pos - node.nodeSize) : $head)
        )
      return this.apply(
        new TextSelection(this.state.doc.resolve(dir < 0 ? nodePos : nodePos + node.nodeSize))
      )
    }
    if (selection instanceof NodeSelection && selection.node.isInline) {
      return this.apply(new TextSelection(dir > 0 ? selection.$to : selection.$from))
    }
    const next = this.moveSelectionBlock(dir)
    return next ? this.apply(next) : false
  }

  private selectVertically(dir: number, mods: string): boolean {
    const selection = this.state.selection
    if ((selection instanceof TextSelection && !selection.empty) || mods.includes("s")) return false
    if (mods.includes("m")) return false
    const { $from, $to } = selection
    if (!$from.parent.inlineContent || this.endOfTextblock(dir < 0 ? "up" : "down")) {
      const next = this.moveSelectionBlock(dir)
      if (next instanceof NodeSelection) return this.apply(next)
    }
    if (!$from.parent.inlineContent) {
      const side = dir < 0 ? $from : $to
      const beyond =
        selection instanceof AllSelection
          ? Selection.near(side, dir)
          : Selection.findFrom(side, dir)
      return beyond ? this.apply(beyond) : false
    }
    return false
  }

  private onBeforeInput(event: InputEvent): void {
    if (!this.editableNow || this.stopped(event)) return
    const type = event.inputType
    if (type === "insertCompositionText" || type === "deleteCompositionText" || this.composing)
      return
    event.preventDefault()
    this.readSelection()
    const selection = this.state.selection
    const range = this.targetRange(event)
    switch (type) {
      case "insertText":
      case "insertReplacementText": {
        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? ""
        // Over a block picked whole, or a range across blocks, the text replaces the selection
        // as the editor holds it, not the range the browser would have typed over.
        if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) {
          if (!this.props.handleTextInput?.(this, selection.from, selection.to, text))
            this.dispatch(this.state.tr.insertText(text).scrollIntoView())
          return
        }
        // A caret types where the editor has it; only a replacement (a spelling fix) names its range.
        const replaces = type === "insertReplacementText" && range
        this.insertText(
          text,
          replaces ? range.from : selection.from,
          replaces ? range.to : selection.to
        )
        return
      }
      case "insertParagraph":
      case "insertLineBreak":
        this.simulateKey(type === "insertParagraph" ? "Enter" : "Enter", type === "insertLineBreak")
        return
      case "historyUndo":
      case "historyRedo":
        this.simulateKey("z", type === "historyRedo", true)
        return
      case "formatBold":
      case "formatItalic":
      case "formatUnderline":
        this.simulateKey(
          type === "formatBold" ? "b" : type === "formatItalic" ? "i" : "u",
          false,
          true
        )
        return
    }
    if (type.startsWith("delete")) {
      if (
        !selection.empty &&
        !(
          selection instanceof TextSelection &&
          range &&
          range.from === selection.from &&
          range.to === selection.to
        )
      ) {
        this.dispatch(this.state.tr.deleteSelection().scrollIntoView())
        return
      }
      if (range && range.from < range.to) {
        const $from = this.state.doc.resolve(range.from)
        const $to = this.state.doc.resolve(range.to)
        if ($from.sameParent($to)) {
          this.dispatch(this.state.tr.delete(range.from, range.to).scrollIntoView())
          return
        }
        this.dispatch(this.state.tr.deleteRange(range.from, range.to).scrollIntoView())
      }
    }
  }

  /** Types `text` over `from`–`to`, through the editor's input rules first. */
  insertText(text: string, from: number, to: number): void {
    if (this.props.handleTextInput?.(this, from, to, text)) return
    this.dispatch(this.state.tr.insertText(text, from, to).scrollIntoView())
  }

  private simulateKey(key: string, shift: boolean, mod = false): void {
    const event = new this.window.KeyboardEvent("keydown", {
      key,
      shiftKey: shift,
      metaKey: mod,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    })
    if (!(this.props.handleKeyDown?.(this, event) || this.captureKey(event)) && key === "Enter") {
      this.dispatch(this.state.tr.insertText("\n").scrollIntoView())
    }
  }

  /** The document range an input event acts on, as the browser computed it. */
  private targetRange(event: InputEvent): { from: number; to: number } | null {
    const ranges = event.getTargetRanges?.() ?? []
    const range = ranges[0]
    if (!range) return null
    const from = this.posFromDOM(range.startContainer, range.startOffset, -1)
    const to = this.posFromDOM(range.endContainer, range.endOffset, 1)
    if (from < 0 || to < 0) return null
    return { from: Math.min(from, to), to: Math.max(from, to) }
  }

  private onInput(event: InputEvent): void {
    if (!this.composing || event.inputType !== "insertCompositionText") return
    this.readComposition()
  }

  private onCompositionStart(): void {
    if (!this.editableNow) return
    // Typing over a selection replaces it before the composition starts.
    if (!this.state.selection.empty) this.dispatch(this.state.tr.deleteSelection())
    this.composing = true
    const { $from } = this.state.selection
    this.compositionBlock = $from.parent.inlineContent
      ? (this.docDesc.nodeDescAt($from.before()) ?? null)
      : null
  }

  private onCompositionEnd(event: CompositionEvent): void {
    if (!this.composing) return
    this.readComposition()
    this.composing = false
    const block = this.compositionBlock
    this.compositionBlock = null
    if (block) {
      // What the browser drew is read; draw it again as the editor draws it.
      ;(block as NodeDesc & { pieces?: Piece[] }).pieces = undefined
      const pos = block.parent ? block.posBefore : 0
      this.renderInline(
        block,
        block.current,
        within(this.decorations, pos, pos + block.current.nodeSize),
        pos + 1
      )
    }
    this.selectionToDOM(true)
    void event
  }

  /** Reads the text of the textblock being composed in back from the DOM. */
  private readComposition(): void {
    const block = this.compositionBlock
    if (!block?.contentDOM || !block.parent) return
    const pos = block.posBefore
    const node = block.current
    const text = readText(block.contentDOM)
    const current = node.textBetween(0, node.content.size, undefined, "\ufffc")
    if (text === current) return
    let start = 0
    while (start < text.length && start < current.length && text[start] === current[start])
      start += 1
    let end = 0
    while (
      end < text.length - start &&
      end < current.length - start &&
      text[text.length - 1 - end] === current[current.length - 1 - end]
    )
      end += 1
    const from = pos + 1 + start
    const to = pos + 1 + current.length - end
    const inserted = text.slice(start, text.length - end)
    const tr = this.state.tr
    if (inserted) tr.insertText(inserted, from, to)
    else tr.delete(from, to)
    // The caret is where the browser has it.
    const domSelection = this.document.getSelection()
    if (domSelection?.focusNode) {
      const head = this.posFromDOM(domSelection.focusNode, domSelection.focusOffset, 1)
      if (head >= 0 && head <= tr.doc.content.size)
        tr.setSelection(TextSelection.create(tr.doc, head))
    }
    tr.setMeta("composition", true)
    this.dispatch(tr)
  }

  private onMouseDown(event: MouseEvent): void {
    if (this.stopped(event) || event.button !== 0) return
    this.readSelection()
    const coords = { left: event.clientX, top: event.clientY }
    const found = this.posAtCoords(coords)
    if (!found) return
    const target = event.target as globalThis.Node
    if (event.detail === 3 && this.editableNow) {
      if (
        this.props.handleTripleClick?.(this, found.pos, event) ||
        this.tripleClick(found.inside)
      ) {
        event.preventDefault()
        return
      }
    }
    // A press on an uneditable node picks it, once the button comes up where it went down.
    const picked = this.pickTarget(target, found)
    this.mouseDown = { x: event.clientX, y: event.clientY, target, picked }
    if (picked !== null && !event.shiftKey) {
      const node = this.state.doc.nodeAt(picked)
      if (node && !(node.isInline && !node.type.spec.draggable)) {
        // Native selection would go around it; the editor picks it instead.
        if (!node.type.spec.draggable) event.preventDefault()
      }
    }
    const up = (upEvent: Event) => {
      this.document.removeEventListener("mouseup", up, true)
      const down = this.mouseDown
      this.mouseDown = null
      if (!down) return
      const mouse = upEvent as MouseEvent
      const moved = Math.abs(mouse.clientX - down.x) + Math.abs(mouse.clientY - down.y) > 4
      if (!moved && down.picked !== null && this.editableNow) {
        const node = this.state.doc.nodeAt(down.picked)
        if (node && NodeSelection.isSelectable(node)) {
          this.dispatch(
            this.state.tr
              .setSelection(NodeSelection.create(this.state.doc, down.picked))
              .setMeta("pointer", true)
          )
          if (!this.hasFocus()) this.dom.focus({ preventScroll: true })
          return
        }
      }
      if (!moved) {
        const pos = this.posAtCoords({ left: mouse.clientX, top: mouse.clientY })
        if (pos && this.props.handleClick?.(this, pos.pos, mouse)) return
      }
      setTimeout(() => this.readSelection("pointer"), 0)
      this.readSelection("pointer")
    }
    this.document.addEventListener("mouseup", up, true)
  }

  /** The node a press picks: an uneditable leaf under the pointer. */
  private pickTarget(
    target: globalThis.Node,
    found: { pos: number; inside: number }
  ): number | null {
    if (found.inside < 0) return null
    const node = this.state.doc.nodeAt(found.inside)
    if (!node || !node.isAtom || !NodeSelection.isSelectable(node)) return null
    const desc = this.docDesc.nodeDescAt(found.inside)
    if (desc?.dom.contains(target)) return found.inside
    return null
  }

  private tripleClick(inside: number): boolean {
    if (inside < 0) return false
    const doc = this.state.doc
    const $pos = doc.resolve(inside)
    const node = $pos.nodeAfter
    if (!node) return false
    if (node.inlineContent) {
      this.dispatch(
        this.state.tr
          .setSelection(TextSelection.create(doc, inside + 1, inside + 1 + node.content.size))
          .setMeta("pointer", true)
      )
      return true
    }
    if (NodeSelection.isSelectable(node)) {
      this.dispatch(
        this.state.tr.setSelection(NodeSelection.create(doc, inside)).setMeta("pointer", true)
      )
      return true
    }
    return false
  }

  // ── The clipboard ───────────────────────────────────────────────────

  private onCopy(event: ClipboardEvent, cut: boolean): void {
    const selection = this.state.selection
    if (selection.empty || !event.clipboardData || this.stopped(event)) return
    const slice = selection.content()
    const { html, text } = serializeSlice(this, slice, this.props.clipboardTextSerializer)
    event.preventDefault()
    event.clipboardData.clearData()
    event.clipboardData.setData("text/html", html)
    event.clipboardData.setData("text/plain", text)
    if (cut && this.editableNow)
      this.dispatch(this.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"))
  }

  private onPaste(event: ClipboardEvent): void {
    if (!this.editableNow || this.stopped(event)) return
    const data = event.clipboardData
    if (!data) return
    const html = data.getData("text/html")
    const text = data.getData("text/plain")
    const slice = parseSlice(
      this,
      html ? (this.props.transformPastedHTML?.(html) ?? html) : null,
      text,
      false,
      this.state.selection.$from
    )
    if (this.props.handlePaste?.(this, event, slice ?? Slice.empty)) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    if (!slice) return
    this.pasteSlice(this.props.transformPasted?.(slice) ?? slice)
  }

  /** Pastes a slice over the selection: a single node as it is, anything else fitted in. */
  pasteSlice(slice: Slice): void {
    const singleNode = sliceSingleNode(slice)
    const tr = singleNode
      ? this.state.tr.replaceSelectionWith(singleNode, false)
      : this.state.tr.replaceSelection(slice)
    this.dispatch(tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"))
  }

  private onDragStart(event: DragEvent): void {
    if (this.stopped(event) || !event.dataTransfer) return
    const selection = this.state.selection
    const found = this.posAtCoords({ left: event.clientX, top: event.clientY })
    let node: NodeSelection | undefined
    if (found && found.inside >= 0) {
      const target = this.state.doc.nodeAt(found.inside)
      if (target?.type.spec.draggable && NodeSelection.isSelectable(target)) {
        node = NodeSelection.create(this.state.doc, found.inside)
      }
    }
    const dragged = node ?? (selection.empty ? null : selection)
    if (!dragged) return
    if (node) this.dispatch(this.state.tr.setSelection(node))
    const slice = dragged.content()
    const { html, text } = serializeSlice(this, slice, this.props.clipboardTextSerializer)
    event.dataTransfer.clearData()
    event.dataTransfer.setData("text/html", html)
    event.dataTransfer.setData("text/plain", text)
    event.dataTransfer.effectAllowed = "copyMove"
    this.dragging = { slice, move: !(event.altKey || event.ctrlKey), node }
  }

  private onDragOver(event: DragEvent): void {
    if (!this.editableNow) return
    event.preventDefault()
  }

  private onDrop(event: DragEvent): void {
    if (!this.editableNow || this.stopped(event)) return
    const dragging = this.dragging
    this.dragging = null
    const coords = this.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!coords || !event.dataTransfer) return
    const $mouse = this.state.doc.resolve(coords.pos)
    const slice =
      dragging?.slice ??
      parseSlice(
        this,
        event.dataTransfer.getData("text/html") || null,
        event.dataTransfer.getData("text/plain"),
        false,
        $mouse
      )
    const moved = !!dragging?.move
    if (this.props.handleDrop?.(this, event, slice ?? Slice.empty, moved)) {
      event.preventDefault()
      return
    }
    if (!slice) return
    event.preventDefault()
    let insertPos = dropPoint(this.state.doc, $mouse.pos, slice) ?? $mouse.pos
    const tr = this.state.tr
    if (moved && dragging) {
      if (dragging.node) dragging.node.replace(tr)
      else tr.deleteSelection()
    }
    const pos = tr.mapping.map(insertPos)
    const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
    const before = tr.doc
    if (isNode) tr.replaceRangeWith(pos, pos, slice.content.firstChild as Node)
    else tr.replaceRange(pos, pos, slice)
    if (tr.doc === before) return
    const $pos = tr.doc.resolve(pos)
    if (
      isNode &&
      NodeSelection.isSelectable(slice.content.firstChild as Node) &&
      $pos.nodeAfter?.sameMarkup(slice.content.firstChild as Node)
    ) {
      tr.setSelection(new NodeSelection($pos))
    } else {
      let end = tr.mapping.map(insertPos)
      tr.mapping.maps[tr.mapping.maps.length - 1]?.forEach((_from, _to, _newFrom, newTo) => {
        end = newTo
      })
      tr.setSelection(this.selectionBetween($pos, tr.doc.resolve(end)))
    }
    insertPos = pos
    this.focus()
    this.dispatch(tr.setMeta("uiEvent", "drop"))
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const [type, listener] of this.listeners) {
      if (type.startsWith("doc:")) this.document.removeEventListener(type.slice(4), listener)
      else this.dom.removeEventListener(type, listener)
    }
    this.docDesc.destroy()
    this.dom.replaceChildren()
  }
}

export interface ViewProps {
  /** A selection other than text between two positions: a table's cells. */
  readonly createSelectionBetween?: (
    view: EditorView,
    $anchor: ResolvedPos,
    $head: ResolvedPos
  ) => Selection | null
  readonly onFocusChange?: (view: EditorView, focused: boolean, event?: FocusEvent) => void
}

/** A leaf drawn whole, a line break or kept markup, which a DOM position does not go into. */
function isDomAtom(desc: Desc): boolean {
  return desc instanceof NodeDesc && !desc.contentDOM
}

function sliceSingleNode(slice: Slice): Node | null {
  return slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
    ? slice.content.firstChild
    : null
}

function markKey(marks: readonly Mark[]): string {
  return marks
    .map(
      (mark) =>
        `${mark.type.name}${Object.keys(mark.attrs).length ? JSON.stringify(mark.attrs) : ""}`
    )
    .join(",")
}

function wrapDecorations(
  document: Document,
  text: Text,
  decorations: readonly InlineDecoration[]
): globalThis.Node {
  let dom: globalThis.Node = text
  for (const deco of decorations) {
    const wrapper = document.createElement(deco.attrs.nodeName ?? "span")
    applyInlineAttrs(wrapper, deco.attrs)
    wrapper.append(dom)
    dom = wrapper
  }
  return dom
}

function applyInlineAttrs(element: HTMLElement, attrs: DecorationAttrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || name === "nodeName") continue
    if (name === "class")
      for (const each of value.split(" ").filter(Boolean)) element.classList.add(each)
    else if (name === "style") element.style.cssText += value
    else element.setAttribute(name, value)
  }
}

/** The text of a textblock's DOM as the browser left it, an uneditable node as one character. */
function readText(content: HTMLElement): string {
  let text = ""
  const walk = (node: globalThis.Node) => {
    if (isText(node)) {
      text += node.data
      return
    }
    if (!isElement(node)) return
    const desc = descOf.get(node)
    if (desc instanceof HackDesc || desc instanceof WidgetDesc) return
    if (desc instanceof NodeDesc && desc.current.isLeaf) {
      text += "\ufffc"
      return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  for (const child of Array.from(content.childNodes)) walk(child)
  return text
}

function isOnEdge(node: globalThis.Node, offset: number, parent: globalThis.Node): boolean {
  for (let atStart = offset === 0, atEnd = offset === nodeSize(node); atStart || atEnd; ) {
    if (node === parent) return true
    const index = domIndex(node)
    const up = node.parentNode
    if (!up) return false
    atStart = atStart && index === 0
    atEnd = atEnd && index === nodeSize(up)
    node = up
  }
  return false
}

function elementAtPoint(
  element: HTMLElement,
  coords: { left: number; top: number },
  box: Rect
): HTMLElement {
  const length = element.childNodes.length
  if (length && box.top < box.bottom) {
    const start = Math.max(
      0,
      Math.min(
        length - 1,
        Math.floor((length * (coords.top - box.top)) / (box.bottom - box.top)) - 2
      )
    )
    for (let index = start; ; ) {
      const child = element.childNodes[index]
      if (isElement(child)) {
        for (const rect of Array.from(child.getClientRects())) {
          if (inRect(coords, rect)) return elementAtPoint(child, coords, rect)
        }
      }
      index = (index + 1) % length
      if (index === start) break
    }
  }
  return element
}

function offsetInNode(
  node: HTMLElement,
  coords: { left: number; top: number }
): { node: globalThis.Node; offset: number } {
  let closest: Text | HTMLElement | undefined
  let dxClosest = 2e8
  let coordsClosest: { left: number; top: number } | undefined
  let offset = 0
  let rowBottom = coords.top
  let rowTop = coords.top
  let firstBelow: Text | HTMLElement | undefined
  let coordsBelow: { left: number; top: number } | undefined
  let childIndex = 0
  for (let child = node.firstChild; child; child = child.nextSibling, childIndex += 1) {
    let rects: DOMRectList
    if (isElement(child)) rects = child.getClientRects()
    else if (isText(child)) rects = textRange(child).getClientRects()
    else continue
    for (const rect of Array.from(rects)) {
      if (rect.top <= rowBottom && rect.bottom >= rowTop) {
        rowBottom = Math.max(rect.bottom, rowBottom)
        rowTop = Math.min(rect.top, rowTop)
        const dx =
          rect.left > coords.left
            ? rect.left - coords.left
            : rect.right < coords.left
              ? coords.left - rect.right
              : 0
        if (dx < dxClosest) {
          closest = child as Text | HTMLElement
          dxClosest = dx
          coordsClosest =
            dx && isText(closest)
              ? { left: rect.right < coords.left ? rect.right : rect.left, top: coords.top }
              : coords
          if (isElement(child) && dx)
            offset = childIndex + (coords.left >= (rect.left + rect.right) / 2 ? 1 : 0)
          continue
        }
      } else if (
        rect.top > coords.top &&
        !firstBelow &&
        rect.left <= coords.left &&
        rect.right >= coords.left
      ) {
        firstBelow = child as Text | HTMLElement
        coordsBelow = {
          left: Math.max(rect.left, Math.min(rect.right, coords.left)),
          top: rect.top,
        }
      }
      if (
        !closest &&
        ((coords.left >= rect.right && coords.top >= rect.top) ||
          (coords.left >= rect.left && coords.top >= rect.bottom))
      ) {
        offset = childIndex + 1
      }
    }
  }
  if (!closest && firstBelow) {
    closest = firstBelow
    coordsClosest = coordsBelow
    dxClosest = 0
  }
  if (closest && isText(closest))
    return offsetInText(closest, coordsClosest as { left: number; top: number })
  if (!closest || dxClosest) return { node, offset }
  return offsetInNode(closest as HTMLElement, coordsClosest as { left: number; top: number })
}

function offsetInText(
  node: Text,
  coords: { left: number; top: number }
): { node: globalThis.Node; offset: number } {
  const length = (node.nodeValue ?? "").length
  const range = node.ownerDocument.createRange()
  for (let index = 0; index < length; index += 1) {
    range.setEnd(node, index + 1)
    range.setStart(node, index)
    const rect = singleRect(range, 1)
    if (rect.top === rect.bottom) continue
    if (inRect(coords, rect))
      return { node, offset: index + (coords.left >= (rect.left + rect.right) / 2 ? 1 : 0) }
  }
  return { node, offset: 0 }
}
