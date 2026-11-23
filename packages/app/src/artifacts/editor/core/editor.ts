// An editor over a live `Y.XmlFragment`: its state, the view drawing it, and the plugins that add
// keys, input rules, decorations and behavior. Every transaction becomes Yjs changes under the
// editor's own origin, which its undo takes back; others' changes, the Agent's and the server's,
// come back as a transaction replacing the blocks they changed, marked `remote`, the selection
// kept where it was among the words.

import type { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"
import { type Command, run } from "./commands"
import { type KeyHandler, type Keymap, keydownHandler } from "./keymap"
import {
  type Fragment,
  type Node,
  ReplaceError,
  type ResolvedPos,
  type Schema,
  Slice,
} from "./model"
import { recoverSelectionEndpoint } from "./recover"
import {
  AllSelection,
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "./state"
import { replaceStep, type Step, StepError } from "./transform"
import {
  type Decoration,
  EditorView,
  type NodeViewFactory,
  type TextblockDecorations,
  type ViewProps,
} from "./view"
import { YBinding } from "./yjs"

export interface PluginView {
  update?(editor: Editor, previous: EditorState): void
  destroy?(): void
}

/** What a plugin adds to an editor; plugins earlier in the list come first. */
export interface EditorPlugin {
  readonly keys?: Keymap
  readonly handleKeyDown?: KeyHandler
  readonly handleTextInput?: (view: EditorView, from: number, to: number, text: string) => boolean
  readonly handlePaste?: (view: EditorView, event: ClipboardEvent, slice: Slice) => boolean
  readonly handleDrop?: (
    view: EditorView,
    event: DragEvent,
    slice: Slice,
    moved: boolean
  ) => boolean
  readonly handleClick?: (view: EditorView, pos: number, event: MouseEvent) => boolean
  readonly handleDOMEvents?: Readonly<Record<string, (view: EditorView, event: Event) => boolean>>
  readonly transformPasted?: (slice: Slice) => Slice
  readonly transformPastedHTML?: (html: string) => string
  readonly clipboardTextSerializer?: (slice: Slice) => string
  readonly createSelectionBetween?: (
    view: EditorView,
    $anchor: ResolvedPos,
    $head: ResolvedPos
  ) => Selection | null
  readonly decorations?: (state: EditorState) => readonly Decoration[]
  readonly textblockDecorations?: TextblockDecorations
  /** A transaction following the ones just applied, or null. */
  readonly appendTransaction?: (
    transactions: readonly Transaction[],
    before: EditorState,
    after: EditorState
  ) => Transaction | null
  /** Each transaction as it is applied, others' changes among them, before the view draws it. */
  readonly apply?: (tr: Transaction) => void
  readonly view?: (editor: Editor) => PluginView
}

export interface EditorOptions {
  readonly mount: HTMLElement
  readonly fragment: Y.XmlFragment
  readonly schema: Schema
  readonly plugins: readonly EditorPlugin[]
  readonly editable: boolean
  readonly nodeViews?: Readonly<Record<string, NodeViewFactory>>
  readonly attributes?: Readonly<Record<string, string>>
  readonly awareness?: Awareness
}

export type EditorEvent = "transaction" | "focus" | "blur" | "destroy"

export interface EditorEventPayload {
  readonly editor: Editor
  /** The transaction applied; others' changes come as one marked `remote`. */
  readonly transaction?: Transaction
  /** For focus and blur, the browser's event. */
  readonly event?: FocusEvent
}

const editors = new WeakMap<Element, Editor>()

/** The editor whose view `element` is, for code that holds only the element. */
export function editorOf(element: Element): Editor | undefined {
  return editors.get(element)
}

/** How long changes made one after another are one step for undo. */
const CAPTURE_TIMEOUT = 500

export class Editor {
  state: EditorState
  readonly view: EditorView
  readonly binding: YBinding
  readonly schema: Schema
  /** The origin of this editor's own Yjs changes, which its undo takes back. */
  readonly origin = { editor: "sixb" }
  /** The origin of its changes that are not undone: what opening it adds. */
  readonly quietOrigin = { editor: "sixb", history: false }
  readonly undoManager: Y.UndoManager
  private readonly plugins: readonly EditorPlugin[]
  private readonly pluginViews: PluginView[] = []
  private readonly listeners = new Map<EditorEvent, Set<(payload: EditorEventPayload) => void>>()
  /** The transactions the last local update applied; none for others' changes. */
  lastTransactions: readonly Transaction[] = []
  private relativeSelection: RelativeSelection | null = null
  private inView: boolean | null = null
  private undoSelection: RelativeSelection | null = null
  private destroyed = false
  private readonly unobserve: () => void

  constructor(options: EditorOptions) {
    this.schema = options.schema
    this.plugins = options.plugins
    this.binding = new YBinding(options.fragment, options.schema)
    const doc = this.binding.document()
    this.state = new EditorState(doc, Selection.atStart(doc))
    // Each plugin's handler, then its keys, in the plugins' order: the first that takes a key wins.
    const handlers = this.plugins
      .flatMap((plugin) => [
        plugin.handleKeyDown,
        plugin.keys ? keydownHandler([plugin.keys]) : undefined,
      ])
      .filter((each): each is KeyHandler => !!each)
    const handleKeyDown: KeyHandler = (view, event) =>
      handlers.some((handler) => handler(view, event))
    const first =
      <Args extends unknown[]>(
        pick: (plugin: EditorPlugin) => ((...args: Args) => boolean) | undefined
      ) =>
      (...args: Args) =>
        this.plugins.some((plugin) => pick(plugin)?.(...args) === true)
    const props: ViewProps & { dispatch: (tr: Transaction) => void; editable: boolean } = {
      dispatch: (tr) => this.dispatch(tr),
      editable: options.editable,
      nodeViews: options.nodeViews,
      attributes: options.attributes,
      handleKeyDown,
      handleTextInput: first((plugin) => plugin.handleTextInput),
      handlePaste: first((plugin) => plugin.handlePaste),
      handleDrop: first((plugin) => plugin.handleDrop),
      handleClick: first((plugin) => plugin.handleClick),
      handleDOMEvents: mergeDOMEvents(this.plugins),
      transformPasted: (slice) =>
        this.plugins.reduce(
          (current, plugin) => plugin.transformPasted?.(current) ?? current,
          slice
        ),
      transformPastedHTML: (html) =>
        this.plugins.reduce(
          (current, plugin) => plugin.transformPastedHTML?.(current) ?? current,
          html
        ),
      clipboardTextSerializer: (slice) => {
        for (const plugin of this.plugins) {
          const text = plugin.clipboardTextSerializer?.(slice)
          if (text !== undefined) return text
        }
        return slice.content.textBetween(0, slice.content.size, "\n\n")
      },
      createSelectionBetween: (view, $anchor, $head) => {
        for (const plugin of this.plugins) {
          const made = plugin.createSelectionBetween?.(view, $anchor, $head)
          if (made) return made
        }
        return null
      },
      decorations: (state) => this.plugins.flatMap((plugin) => plugin.decorations?.(state) ?? []),
      textblockDecorations: (node) =>
        this.plugins.flatMap((plugin) => plugin.textblockDecorations?.(node) ?? []),
      onFocusChange: (_view, focused, event) =>
        this.emit(focused ? "focus" : "blur", event ? { event } : {}),
    }
    this.view = new EditorView(options.mount, this.state, props)
    editors.set(this.view.dom, this)

    // Undo takes back this editor's own changes, never anyone else's, and puts the selection
    // back where it was. A paragraph or text someone else typed into stays.
    this.undoManager = new Y.UndoManager(options.fragment, {
      trackedOrigins: new Set([this.origin]),
      captureTimeout: CAPTURE_TIMEOUT,
      deleteFilter: (item) => keepOnUndo(item),
    })
    this.undoManager.on(
      "stack-item-added",
      ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
        const manager = this.undoManager
        stackItem.meta.set(
          this,
          manager.undoing || manager.redoing ? this.relativeSelection : this.undoSelection
        )
      }
    )

    const doc$ = this.binding.doc
    const beforeAll = () => {
      if (this.relativeSelection === null)
        this.relativeSelection = this.relativeOf(this.state.selection)
    }
    const afterAll = () => {
      this.relativeSelection = null
    }
    const observe = (events: Y.YEvent<Y.XmlFragment>[], transaction: Y.Transaction) => {
      if (transaction.origin === this.origin || transaction.origin === this.quietOrigin) return
      this.remoteChange(events, transaction)
    }
    doc$.on("beforeAllTransactions", beforeAll)
    doc$.on("afterAllTransactions", afterAll)
    options.fragment.observeDeep(observe)
    this.unobserve = () => {
      doc$.off("beforeAllTransactions", beforeAll)
      doc$.off("afterAllTransactions", afterAll)
      options.fragment.unobserveDeep(observe)
    }
    for (const plugin of this.plugins) {
      const made = plugin.view?.(this)
      if (made) this.pluginViews.push(made)
    }
  }

  get isEditable(): boolean {
    return this.view.editable
  }

  setEditable(editable: boolean): void {
    this.view.setProps({ editable })
    this.emit("transaction", {})
  }

  on(event: EditorEvent, listener: (payload: EditorEventPayload) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  private emit(
    event: EditorEvent,
    payload: { transaction?: Transaction; event?: FocusEvent }
  ): void {
    for (const listener of this.listeners.get(event) ?? []) listener({ ...payload, editor: this })
  }

  /** Runs a command against the current state and dispatches it. */
  run(command: Command): boolean {
    return run(this.view, command)
  }

  dispatch(tr: Transaction): void {
    if (this.destroyed) return
    const before = this.state
    let state = before.apply(tr)
    const transactions = [tr]
    // Plugins may follow what happened with changes of their own: a link typed, a table mended.
    for (let round = 0; round < 3; round += 1) {
      let appended = false
      for (const plugin of this.plugins) {
        const next = plugin.appendTransaction?.(transactions, before, state)
        if (next && (next.docChanged || next.selectionSet || next.storedMarksSet)) {
          state = state.apply(next)
          transactions.push(next)
          appended = true
        }
      }
      if (!appended) break
    }
    if (state.doc !== before.doc) {
      this.undoSelection = this.relativeOf(before.selection)
      const quiet = transactions.some((each) => each.getMeta("addToHistory") === false)
      this.binding.write(before.doc, state.doc, quiet ? this.quietOrigin : this.origin)
    }
    this.lastTransactions = transactions
    for (const each of transactions) for (const plugin of this.plugins) plugin.apply?.(each)
    this.updateState(state, before, tr)
  }

  private updateState(state: EditorState, before: EditorState, tr?: Transaction): void {
    this.state = state
    this.view.updateState(state)
    if (tr?.scrolled) this.scrollIntoView()
    for (const view of this.pluginViews) view.update?.(this, before)
    this.emit("transaction", tr ? { transaction: tr } : {})
  }

  private scrollIntoView(): void {
    if (!this.view.hasFocus()) return
    const rect = this.view.coordsAtPos(this.state.selection.head)
    const window = this.view.window
    const margin = 5
    for (let parent: HTMLElement | null = this.view.dom; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      const scrolls =
        /(auto|scroll)/.test(style.overflowY) || parent === this.view.document.scrollingElement
      if (!scrolls || parent.scrollHeight <= parent.clientHeight) continue
      const box =
        parent === this.view.document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : parent.getBoundingClientRect()
      if (rect.top < box.top + margin) parent.scrollTop -= box.top + margin - rect.top
      else if (rect.bottom > box.bottom - margin)
        parent.scrollTop += rect.bottom - (box.bottom - margin)
      break
    }
  }

  /**
   * Others' changes, and undo's: the document read again, as one step replacing the run of blocks
   * that changed, and the selection put back where the words around it went. A caret that was in
   * view stays in view.
   */
  private remoteChange(events: Y.YEvent<Y.XmlFragment>[], transaction: Y.Transaction): void {
    const before = this.state
    this.binding.forget(events)
    const tr = replaceChangedChildren(before.tr, this.binding.document().content)
    const undoing = transaction.origin instanceof Y.UndoManager
    const saved = undoing
      ? ((
          transaction.origin as Y.UndoManager & { currStackItem?: { meta: Map<unknown, unknown> } }
        ).currStackItem?.meta.get(this) as RelativeSelection | undefined)
      : undefined
    const relative = saved ?? this.relativeSelection
    const restored = relative && this.restore(tr.doc, relative, saved ? null : before.doc)
    if (restored) tr.setSelection(restored)
    tr.setMeta("addToHistory", false).setMeta("remote", true)
    if (this.relativeSelection !== null && this.caretInView()) tr.scrollIntoView()
    this.lastTransactions = [tr]
    for (const plugin of this.plugins) plugin.apply?.(tr)
    this.updateState(before.apply(tr), before, tr)
  }

  /** Whether this editor has the focus and its selection is on screen, measured once a task. */
  private caretInView(): boolean {
    if (!this.view.hasFocus()) return false
    if (this.inView === null) {
      this.inView = this.measureCaretInView()
      setTimeout(() => {
        this.inView = null
      })
    }
    return this.inView
  }

  private measureCaretInView(): boolean {
    const selection = this.view.document.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return false
    const range = this.view.document.createRange()
    range.setStart(selection.anchorNode, selection.anchorOffset)
    range.setEnd(selection.focusNode, selection.focusOffset)
    if (range.getClientRects().length === 0 && range.collapsed)
      range.selectNodeContents(range.startContainer)
    const box = range.getBoundingClientRect()
    const window = this.view.window
    const root = this.view.document.documentElement
    return (
      box.bottom >= 0 &&
      box.right >= 0 &&
      box.left <= (window.innerWidth || root.clientWidth || 0) &&
      box.top <= (window.innerHeight || root.clientHeight || 0)
    )
  }

  undo(): boolean {
    if (this.undoManager.undoStack.length === 0) return false
    this.undoManager.undo()
    return true
  }

  redo(): boolean {
    if (this.undoManager.redoStack.length === 0) return false
    this.undoManager.redo()
    return true
  }

  // ── Positions that last ─────────────────────────────────────────────

  relativeOf(selection: Selection): RelativeSelection {
    return {
      type:
        selection instanceof NodeSelection
          ? "node"
          : selection instanceof AllSelection
            ? "all"
            : "text",
      anchor: this.binding.relative(selection.anchor),
      head: this.binding.relative(selection.head),
      absAnchor: selection.anchor,
      absHead: selection.head,
    }
  }

  /** The selection `relative` keeps in `doc`; its ends found again in moved blocks unless undoing. */
  private restore(doc: Node, relative: RelativeSelection, oldDoc: Node | null): Selection | null {
    if (relative.type === "all") return new AllSelection(doc)
    let anchor = this.binding.absolute(relative.anchor)
    let head = this.binding.absolute(relative.head)
    if (relative.type === "node") {
      if (anchor === null) return null
      const $pos = doc.resolve(Math.min(anchor, doc.content.size))
      return $pos.nodeAfter ? NodeSelection.create(doc, $pos.pos) : TextSelection.near($pos)
    }
    if (oldDoc) {
      anchor = recoverSelectionEndpoint(doc, oldDoc, relative.absAnchor, anchor)
      head = recoverSelectionEndpoint(doc, oldDoc, relative.absHead, head)
    }
    anchor ??= head
    head ??= anchor
    if (anchor === null || head === null) return null
    const size = doc.content.size
    return TextSelection.between(
      doc.resolve(Math.min(anchor, size)),
      doc.resolve(Math.min(head, size))
    )
  }

  focus(): void {
    this.view.focus()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const view of this.pluginViews) view.destroy?.()
    this.unobserve()
    this.undoManager.destroy()
    this.view.destroy()
    this.emit("destroy", {})
  }
}

export interface RelativeSelection {
  readonly type: "text" | "node" | "all"
  readonly anchor: Y.RelativePosition
  readonly head: Y.RelativePosition
  /** Where its ends were, for finding them again in a block someone moved. */
  readonly absAnchor: number
  readonly absHead: number
}

/**
 * A transaction turning `tr`'s document into one holding `content`: one step replacing the run of
 * top-level blocks between those alike by identity at either end, as y-prosemirror's
 * `replaceChangedChildren` makes it, so what maps through it moves as it did there.
 */
function replaceChangedChildren(tr: Transaction, content: Fragment): Transaction {
  const old = tr.doc.content
  let start = 0
  let from = 0
  while (
    start < old.childCount &&
    start < content.childCount &&
    old.child(start) === content.child(start)
  ) {
    from += old.child(start).nodeSize
    start += 1
  }
  let oldEnd = old.childCount
  let newEnd = content.childCount
  let suffix = 0
  while (oldEnd > start && newEnd > start && old.child(oldEnd - 1) === content.child(newEnd - 1)) {
    suffix += old.child(oldEnd - 1).nodeSize
    oldEnd -= 1
    newEnd -= 1
  }
  if (start === oldEnd && start === newEnd) return tr
  const step = replaceStep(
    tr.doc,
    from,
    old.size - suffix,
    new Slice(content.cut(from, content.size - suffix), 0, 0)
  )
  const made = step && applied(step, tr.doc)
  if (step && made?.content.eq(content)) return tr.step(step, made)
  return tr.replace(0, old.size, new Slice(content, 0, 0))
}

/** The document `step` makes of `doc`, or null where it does not apply. */
function applied(step: Step, doc: Node): Node | null {
  try {
    return step.apply(doc)
  } catch (error) {
    if (error instanceof StepError || error instanceof ReplaceError || error instanceof RangeError)
      return null
    throw error
  }
}

function mergeDOMEvents(
  plugins: readonly EditorPlugin[]
): Record<string, (view: EditorView, event: Event) => boolean> {
  const merged: Record<string, (view: EditorView, event: Event) => boolean> = {}
  const names = new Set(plugins.flatMap((plugin) => Object.keys(plugin.handleDOMEvents ?? {})))
  for (const name of names) {
    merged[name] = (view, event) =>
      plugins.some((plugin) => plugin.handleDOMEvents?.[name]?.(view, event) === true)
  }
  return merged
}

/**
 * Whether undoing an insertion deletes what was inserted: not a paragraph or text that holds
 * anything, which someone may have typed into since.
 */
function keepOnUndo(item: unknown): boolean {
  if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentType)) return true
  const type = item.content.type as Y.AbstractType<unknown>
  const protectedType =
    type instanceof Y.Text || (type instanceof Y.XmlElement && type.nodeName === "paragraph")
  return !protectedType || (type as unknown as { _length: number })._length === 0
}
