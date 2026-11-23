// Plugins both editors use: undo's keys, the placeholder of an empty block, collaborators'
// carets, input rules, the `/` trigger, and the keys every editor has, Enter, Backspace and
// Delete, each a chain of commands tried in turn, as TipTap's core keymap (MIT) chains them.

import type { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"
import {
  clearNodes,
  createParagraphNear,
  deleteCurrentNode,
  deleteSelection,
  exitCode,
  first,
  joinBackward,
  joinForward,
  liftEmptyBlock,
  newlineInCode,
  run,
  selectAll,
  selectNodeBackward,
  selectNodeForward,
  selectTextblockEnd,
  selectTextblockStart,
  splitBlock,
} from "./commands"
import type { Editor, EditorPlugin } from "./editor"
import { isMac } from "./keymap"
import type { Node } from "./model"
import { type EditorState, Selection, TextSelection, type Transaction } from "./state"
import type { Step } from "./transform"
import type { Decoration, EditorView } from "./view"

// ── Undo ────────────────────────────────────────────────────────────────

export function historyPlugin(editor: () => Editor): EditorPlugin {
  return {
    keys: {
      "Mod-z": () => editor().undo(),
      "Mod-y": () => editor().redo(),
      "Shift-Mod-z": () => editor().redo(),
    },
  }
}

// ── The keys every editor has ───────────────────────────────────────────

/** Enter, Backspace, Delete and Select All, each a chain of commands tried in turn. */
export function baseKeymap(rules: InputRules | null): EditorPlugin {
  const backspace = (view: EditorView) =>
    run(
      view,
      first(
        (tr) => (rules ? rules.undo(tr) : false),
        (tr) => {
          // An empty first block that is not a paragraph becomes one.
          const { empty, $anchor } = tr.selection
          const { pos, parent } = $anchor
          const $parentPos =
            $anchor.parent.isTextblock && pos > 0 ? tr.doc.resolve(pos - 1) : $anchor
          const isolating = $parentPos.parent.type.spec.isolating
          const parentPos = $anchor.pos - $anchor.parentOffset
          const atStart =
            isolating && $parentPos.parent.childCount === 1
              ? parentPos === $anchor.pos
              : Selection.atStart(tr.doc).from === pos
          if (
            !empty ||
            !parent.type.isTextblock ||
            parent.textContent.length ||
            !atStart ||
            $anchor.parent.type.name === "paragraph"
          )
            return false
          return clearNodes(tr)
        },
        deleteSelection,
        joinBackward,
        selectNodeBackward
      )
    )
  const del = (view: EditorView) =>
    run(view, first(deleteSelection, deleteCurrentNode, joinForward, selectNodeForward))
  const keys: Record<string, (view: EditorView) => boolean> = {
    Enter: (view) =>
      run(view, first(newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock)),
    "Mod-Enter": (view) => run(view, exitCode),
    Backspace: backspace,
    "Mod-Backspace": backspace,
    "Shift-Backspace": backspace,
    Delete: del,
    "Mod-Delete": del,
    "Mod-a": (view) => run(view, selectAll),
  }
  if (isMac) {
    keys["Ctrl-h"] = backspace
    keys["Alt-Backspace"] = backspace
    keys["Ctrl-d"] = del
    keys["Ctrl-Alt-Backspace"] = del
    keys["Alt-Delete"] = del
    keys["Alt-d"] = del
    keys["Ctrl-a"] = (view) => run(view, selectTextblockStart)
    keys["Ctrl-e"] = (view) => run(view, selectTextblockEnd)
  }
  return {
    keys,
    // Everything selected and deleted leaves an empty paragraph, not an empty heading.
    appendTransaction: (transactions, before, after) => {
      if (transactions.some((tr) => tr.getMeta("composition"))) return null
      if (!transactions.some((tr) => tr.docChanged) || before.doc.eq(after.doc)) return null
      const { empty, from, to } = before.selection
      if (
        empty ||
        from !== Selection.atStart(before.doc).from ||
        to !== Selection.atEnd(before.doc).to
      )
        return null
      if (!isEmpty(after.doc)) return null
      const tr = after.tr
      clearNodes(tr)
      if (!tr.steps.length && !after.storedMarks) return null
      return tr.setStoredMarks(null)
    },
  }
}

/** Whether a node holds nothing: no text and no leaf. */
export function isEmpty(node: Node): boolean {
  if (node.isText) return !node.text
  if (node.isAtom || node.isLeaf) return false
  if (node.content.childCount === 0) return true
  let empty = true
  node.content.forEach((child) => {
    if (empty && !isEmpty(child)) empty = false
  })
  return empty
}

// ── Placeholders ────────────────────────────────────────────────────────

/** The text an empty block shows while the caret is in it, and the classes it takes. */
export function placeholderPlugin(
  text: (node: Node, pos: number, state: EditorState) => string,
  editable: () => boolean
): EditorPlugin {
  return {
    decorations: (state) => {
      if (!editable()) return []
      const { anchor } = state.selection
      const decorations: Decoration[] = []
      const editorEmpty = isEmpty(state.doc)
      state.doc.descendants((node, pos) => {
        const hasAnchor = anchor >= pos && anchor <= pos + node.nodeSize
        if (hasAnchor && node.isTextblock && isEmpty(node)) {
          decorations.push({
            kind: "node",
            from: pos,
            to: pos + node.nodeSize,
            attrs: {
              class: editorEmpty ? "is-empty is-editor-empty" : "is-empty",
              "data-placeholder": text(node, pos, state),
            },
          })
        }
        // Only a block holding the caret can show a placeholder.
        return hasAnchor
      })
      return decorations
    },
  }
}

// ── Collaborators' carets ───────────────────────────────────────────────

export interface CaretUser {
  readonly name?: string
  readonly color?: string
}

/**
 * Everyone else's caret and selection, from what each reader's awareness says, and this reader's,
 * published while the editor has the focus, as y-prosemirror's cursors are.
 */
export function caretsPlugin(
  awareness: Awareness,
  options: {
    readonly render: (user: CaretUser) => HTMLElement
    readonly selection: (user: CaretUser) => Record<string, string>
  }
): EditorPlugin {
  let editorRef: Editor | null = null
  let published: { anchor: Y.RelativePosition; head: Y.RelativePosition } | null = null
  return {
    decorations: (state) => {
      const editor = editorRef
      if (!editor) return []
      const decorations: Decoration[] = []
      const size = state.doc.content.size
      awareness.getStates().forEach((value, client) => {
        if (client === awareness.clientID) return
        const aware = value as {
          cursor?: { anchor: unknown; head: unknown } | null
          user?: CaretUser
        }
        if (!aware?.cursor) return
        const user = { ...aware.user }
        user.color ??= "#ffa500"
        user.name ??= `User: ${client}`
        let anchor = editor.binding.absolute(Y.createRelativePositionFromJSON(aware.cursor.anchor))
        let head = editor.binding.absolute(Y.createRelativePositionFromJSON(aware.cursor.head))
        if (anchor === null || head === null) return
        anchor = Math.min(anchor, Math.max(size - 1, 0))
        head = Math.min(head, Math.max(size - 1, 0))
        decorations.push({
          kind: "widget",
          pos: head,
          side: 10,
          key: `caret-${client}-${user.name}-${user.color}`,
          toDOM: () => options.render(user),
        })
        const from = Math.min(anchor, head)
        const to = Math.max(anchor, head)
        if (from < to)
          decorations.push({ kind: "inline", from, to, attrs: options.selection(user) })
      })
      return decorations
    },
    view: (editor) => {
      editorRef = editor
      const redraw = () => editor.view.updateState(editor.state)
      const publish = () => {
        const current = (awareness.getLocalState() ?? null) as { cursor?: unknown } | null
        if (current === null) return
        if (!editor.view.hasFocus()) {
          if (published && current.cursor === published)
            awareness.setLocalStateField("cursor", null)
          published = null
          return
        }
        const { anchor, head } = editor.state.selection
        const next = {
          anchor: editor.binding.relative(anchor),
          head: editor.binding.relative(head),
        }
        if (
          current.cursor === published &&
          published &&
          Y.compareRelativePositions(published.anchor, next.anchor) &&
          Y.compareRelativePositions(published.head, next.head)
        )
          return
        published = next
        awareness.setLocalStateField("cursor", next)
      }
      awareness.on("change", redraw)
      // Any focus moving in or out, a field of a block's own among them, which the text loses it to.
      const dom = editor.view.dom
      dom.addEventListener("focusin", publish)
      dom.addEventListener("focusout", publish)
      return {
        update: publish,
        destroy: () => {
          awareness.off("change", redraw)
          dom.removeEventListener("focusin", publish)
          dom.removeEventListener("focusout", publish)
          const current = awareness.getLocalState() as { cursor?: unknown } | null
          if (published && current?.cursor === published)
            awareness.setLocalStateField("cursor", null)
        },
      }
    },
  }
}

// ── Input rules ─────────────────────────────────────────────────────────

export interface InputRuleContext {
  readonly state: EditorState
  readonly tr: Transaction
  readonly range: { readonly from: number; readonly to: number }
  readonly match: RegExpExecArray
}

export interface InputRule {
  readonly find: RegExp | ((text: string) => RegExpExecArray | null)
  /** Changes `tr` for a match; returns false when the rule does not apply after all. */
  readonly handler: (context: InputRuleContext) => boolean
  readonly undoable?: boolean
}

/** Text typed that matches a rule becomes what the rule makes: `## ` a heading, `**a**` bold. */
export class InputRules {
  private undoable: {
    steps: Step[]
    docs: Node[]
    from: number
    to: number
    text: string
    after: Node
  } | null = null

  constructor(private readonly rules: readonly InputRule[]) {}

  plugin(): EditorPlugin {
    return {
      handleTextInput: (view, from, to, text) => this.run(view, from, to, text),
      handleKeyDown: (view, event) => {
        if (event.key !== "Enter") return false
        const selection = view.state.selection
        const $cursor = selection instanceof TextSelection ? selection.$cursor : null
        return $cursor ? this.run(view, $cursor.pos, $cursor.pos, "\n") : false
      },
      view: () => ({
        update: (editor, previous) => {
          // A rule can be undone only straight after it ran.
          if (this.undoable && editor.state.doc !== this.undoable.after) this.undoable = null
          else if (
            this.undoable &&
            !editor.state.selection.eq(previous.selection) &&
            editor.state.doc === previous.doc
          )
            this.undoable = null
        },
      }),
    }
  }

  /** Backspace right after a rule ran puts back what was typed. */
  undo(tr: Transaction): boolean {
    const undoable = this.undoable
    if (!undoable || tr.doc !== undoable.after) return false
    for (let index = undoable.steps.length - 1; index >= 0; index -= 1) {
      tr.step(invert(undoable.steps[index] as Step, undoable.docs[index] as Node))
    }
    if (undoable.text) {
      const marks = tr.doc.resolve(undoable.from).marks()
      tr.replaceWith(undoable.from, undoable.to, tr.doc.type.schema.textNode(undoable.text, marks))
    } else {
      tr.delete(undoable.from, undoable.to)
    }
    this.undoable = null
    return true
  }

  private run(view: EditorView, from: number, to: number, text: string): boolean {
    const state = view.state
    const $from = state.doc.resolve(from)
    if (
      $from.parent.type.spec.code ||
      ($from.nodeBefore ?? $from.nodeAfter)?.marks.some((mark) => mark.type.spec.code)
    )
      return false
    const textBefore = textBeforeOf($from) + text
    for (const rule of this.rules) {
      const match =
        typeof rule.find === "function" ? rule.find(textBefore) : rule.find.exec(textBefore)
      if (!match || !matchesDocument($from, match, text)) continue
      // The text is typed first, then the rule acts on it: tried before either is dispatched.
      const input = state.tr.insertText(text, from, to)
      const range = { from: from - (match[0].length - text.length), to: from + text.length }
      const inputState = state.apply(input)
      const probe = inputState.tr
      if (!rule.handler({ state: inputState, tr: probe, range, match }) || !probe.steps.length)
        continue
      view.dispatch(input)
      if (!view.state.doc.eq(input.doc)) return true
      const tr = view.state.tr
      rule.handler({ state: view.state, tr, range, match })
      tr.setMeta("inputRule", true)
      const steps = [...tr.steps]
      const docs = [...tr.docs]
      view.dispatch(tr)
      if (rule.undoable !== false)
        this.undoable = { steps, docs, from, to: from + text.length, text, after: view.state.doc }
      return true
    }
    return false
  }
}

function invert(step: Step, doc: Node): Step {
  const inverse = (step as Step & { invert?: (doc: Node) => Step }).invert
  if (!inverse) throw new Error("[SixbEditor] A step that cannot be inverted.")
  return inverse.call(step, doc)
}

/** The text of a textblock before a position, a leaf as `%leaf%`, as input rules read it. */
function textBeforeOf($from: import("./model").ResolvedPos, maxMatch = 500): string {
  let text = ""
  const end = $from.parentOffset
  $from.parent.nodesBetween(Math.max(0, end - maxMatch), end, (node, pos) => {
    const chunk = node.textContent || "%leaf%"
    text += node.isAtom && !node.isText ? chunk : chunk.slice(0, Math.max(0, end - pos))
    return true
  })
  return text
}

function matchesDocument(
  $from: import("./model").ResolvedPos,
  match: RegExpExecArray,
  text: string
): boolean {
  const length = match[0].length - text.length
  if (length <= 0) return true
  const start = $from.parentOffset - length
  return (
    start >= 0 && $from.parent.textBetween(start, $from.parentOffset) === match[0].slice(0, length)
  )
}

// ── The `/` trigger ─────────────────────────────────────────────────────

export interface SuggestionState {
  readonly active: boolean
  readonly range: { readonly from: number; readonly to: number }
  readonly query: string | null
  readonly text: string | null
  readonly decorationId: string | null
  readonly dismissed: { readonly from: number; readonly to: number } | null
}

export interface SuggestionCallbacks {
  /** Whether a match may open the menu here. */
  readonly allow: (state: EditorState, range: { from: number; to: number }) => boolean
  readonly onStart: (state: SuggestionState, rect: () => DOMRect | null) => void
  readonly onUpdate: (state: SuggestionState, rect: () => DOMRect | null) => void
  readonly onExit: () => void
  /** Keys while the menu is open; true when one was handled. */
  readonly onKeyDown: (event: KeyboardEvent) => boolean
}

const CLOSED: SuggestionState = {
  active: false,
  range: { from: 0, to: 0 },
  query: null,
  text: null,
  decorationId: null,
  dismissed: null,
}

/** A trigger character typed after a space or at a line's start opens a menu, which follows the query typed after it. */
export class Suggestion {
  state: SuggestionState = CLOSED
  private exitRequested = false

  constructor(
    private readonly char: string,
    private readonly callbacks: SuggestionCallbacks
  ) {}

  /** Closes the menu, keeping it closed while what was typed stays. */
  exit(view: EditorView): void {
    this.exitRequested = true
    view.dispatch(view.state.tr.setMeta("suggestionExit", true))
  }

  plugin(editable: () => boolean): EditorPlugin {
    return {
      handleKeyDown: (view, event) => {
        if (!this.state.active) return false
        if (event.key === "Escape" || event.key === "Esc") {
          this.callbacks.onKeyDown(event)
          this.exit(view)
          return true
        }
        return this.callbacks.onKeyDown(event)
      },
      decorations: () => {
        if (!this.state.active) return []
        const { from, to } = this.state.range
        return [
          {
            kind: "inline",
            from,
            to,
            attrs: {
              nodeName: "span",
              class: this.state.query?.length ? "suggestion" : "suggestion is-empty",
              "data-decoration-id": this.state.decorationId ?? undefined,
              "data-decoration-content": "",
            },
          },
        ]
      },
      view: (editor) => ({
        update: (current, previous) => {
          const before = this.state
          this.state = this.next(before, current, previous, editable())
          const after = this.state
          if (
            before.active === after.active &&
            (!after.active ||
              (before.query === after.query &&
                before.text === after.text &&
                before.range.from === after.range.from &&
                before.range.to === after.range.to))
          )
            return
          // The decoration around the query is drawn with the next update.
          current.view.updateState(current.state)
          const rect = () => {
            const node = after.decorationId
              ? editor.view.dom.querySelector(`[data-decoration-id="${after.decorationId}"]`)
              : null
            if (node) return node.getBoundingClientRect()
            const at = editor.view.coordsAtPos(editor.state.selection.$anchor.pos)
            return new DOMRect(at.left, at.top, at.right - at.left, at.bottom - at.top)
          }
          if (!before.active && after.active) this.callbacks.onStart(after, rect)
          else if (before.active && !after.active) this.callbacks.onExit()
          else this.callbacks.onUpdate(after, rect)
        },
        destroy: () => {
          if (this.state.active) this.callbacks.onExit()
        },
      }),
    }
  }

  private next(
    previous: SuggestionState,
    editor: Editor,
    before: EditorState,
    editable: boolean
  ): SuggestionState {
    const state = editor.state
    if (this.exitRequested) {
      this.exitRequested = false
      return { ...CLOSED, dismissed: previous.active ? { ...previous.range } : previous.dismissed }
    }
    let dismissed = previous.dismissed
    const docChanged = state.doc !== before.doc
    const transactions = editor.lastTransactions
    if (docChanged && dismissed) {
      let { from: dismissedFrom, to: dismissedTo } = dismissed
      for (const tr of transactions) {
        dismissedFrom = tr.mapping.map(dismissedFrom)
        dismissedTo = tr.mapping.map(dismissedTo)
      }
      dismissed = { from: dismissedFrom, to: dismissedTo }
    }
    const { empty, $from } = state.selection
    if (!editable || !empty) return { ...CLOSED, dismissed }
    const match = findMatch(this.char, $from)
    if (match && this.callbacks.allow(state, match.range)) {
      const insertedSpace = transactions.some(hasInsertedWhitespace)
      if (dismissed && !(match.range.from === dismissed.from && !insertedSpace)) dismissed = null
      if (!dismissed) {
        return {
          active: true,
          range: match.range,
          query: match.query,
          text: match.text,
          decorationId: previous.decorationId ?? `id_${Math.floor(Math.random() * 0xffffffff)}`,
          dismissed: null,
        }
      }
      return { ...CLOSED, dismissed }
    }
    return { ...CLOSED, dismissed: match ? dismissed : null }
  }
}

/** Whether a transaction typed or pasted any whitespace, which ends a dismissed menu's query. */
function hasInsertedWhitespace(tr: Transaction): boolean {
  return tr.steps.some((step) => {
    const slice = (step as Step & { slice?: import("./model").Slice }).slice
    return !!slice?.content && /\s/.test(slice.content.textBetween(0, slice.content.size, "\n"))
  })
}

/** The trigger and query before the caret: `/hea`, after a space or at the start of a line. */
export function findMatch(
  char: string,
  $position: import("./model").ResolvedPos
): { range: { from: number; to: number }; query: string; text: string } | null {
  const text = $position.nodeBefore?.isText ? $position.nodeBefore.text : null
  if (!text) return null
  const escaped = char.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
  const pattern = new RegExp(`(?:^)?${escaped}[^\\s${escaped}]*`, "gm")
  const textFrom = $position.pos - text.length
  const match = Array.from(text.matchAll(pattern)).pop()
  if (!match || match.index === undefined) return null
  const prefix = text.slice(Math.max(0, match.index - 1), match.index)
  if (!/^[ \0]?$/.test(prefix)) return null
  const from = textFrom + match.index
  const to = from + match[0].length
  if (from < $position.pos && to >= $position.pos)
    return { range: { from, to }, query: match[0].slice(char.length), text: match[0] }
  return null
}
