// What pasted or dropped words become: syntax such as `**bold**` turned into the mark it stands
// for, and addresses into links, wherever the paste or drop changed the document. Words that came
// from an editor, with its structure, are left as they were. As Tiptap's paste rules (MIT) do it:
// one plugin per rule, in order, each run over what the paste changed.

import type { EditorPlugin } from "./editor"
import type { Attrs, Mark, MarkType, Node } from "./model"
import type { Transaction } from "./state"

/** A match of a rule's pattern: the whole match first, its groups after. */
export type PasteMatch = string[] & {
  index?: number
  input?: string
  data?: Record<string, unknown>
}

/** What a finder reports of a match it found in a text. */
export interface PasteFound {
  readonly text: string
  readonly index: number
  readonly data?: Record<string, unknown>
  /** The part of `text` to keep, as the match's last group. */
  readonly replaceWith?: string
}

export interface PasteRule {
  readonly find: RegExp | ((text: string) => readonly PasteFound[] | null)
  /** Changes `tr` for one match over `range`; null when the match is to be left alone. */
  readonly handler: (context: {
    tr: Transaction
    range: { from: number; to: number }
    match: PasteMatch
  }) => null | undefined
}

/** A rule marking the last group of each match, the syntax around it taken away. */
export function markPasteRule(
  find: PasteRule["find"],
  type: MarkType,
  getAttributes?: (match: PasteMatch) => Attrs | false | null | undefined
): PasteRule {
  return {
    find,
    handler: ({ tr, range, match }) => {
      const attributes = getAttributes?.(match)
      if (attributes === false || attributes === null) return null
      const group = match[match.length - 1]
      const whole = match[0] as string
      if (!group) return undefined
      const startSpaces = whole.search(/\S/)
      const textStart = range.from + whole.indexOf(group)
      const textEnd = textStart + group.length
      // Not inside a mark that excludes this one, such as code.
      const excluding = marksBetween(range.from, range.to, tr.doc).filter(
        (item) =>
          item.to > textStart &&
          item.mark.type.excluded.some((each) => each === type && each !== item.mark.type)
      )
      if (excluding.length) return null
      if (textEnd < range.to) tr.delete(textEnd, range.to)
      if (textStart > range.from) tr.delete(range.from + startSpaces, textStart)
      const markEnd = range.from + startSpaces + group.length
      tr.addMark(range.from + startSpaces, markEnd, type.create(attributes || {}))
      const atEnd =
        match.index !== undefined &&
        match.input !== undefined &&
        match.index + whole.length >= match.input.length
      if (!atEnd) tr.removeStoredMark(type)
      return undefined
    },
  }
}

/** The plugins applying `rules` to what is pasted or dropped, one per rule. */
export function pasteRules(rules: readonly PasteRule[]): EditorPlugin[] {
  // Shared by the rules: whether what came in came from an editor.
  let dragSource: HTMLElement | null = null
  let pastedFromEditor = false
  let droppedFromEditor = false
  return rules.map(
    (rule): EditorPlugin => ({
      view: (editor) => {
        const view = editor.view
        const dragstart = (event: DragEvent) => {
          const parent = view.dom.parentElement
          dragSource = parent?.contains(event.target as globalThis.Node | null) ? parent : null
        }
        view.window.addEventListener("dragstart", dragstart)
        return { destroy: () => view.window.removeEventListener("dragstart", dragstart) }
      },
      handleDOMEvents: {
        drop: (view) => {
          droppedFromEditor = dragSource === view.dom.parentElement
          return false
        },
        paste: (_view, event) => {
          const html = (event as ClipboardEvent).clipboardData?.getData("text/html")
          pastedFromEditor = !!html?.includes("data-pm-slice")
          return false
        },
      },
      appendTransaction: (transactions, before, after) => {
        const first = transactions[0] as Transaction
        const isPaste = first.getMeta("uiEvent") === "paste" && !pastedFromEditor
        const isDrop = first.getMeta("uiEvent") === "drop" && !droppedFromEditor
        if (!isPaste && !isDrop) return null
        const from = before.doc.content.findDiffStart(after.doc.content)
        const to = before.doc.content.findDiffEnd(after.doc.content)
        if (typeof from !== "number" || !to || from === to.b) return null
        const tr = after.tr
        if (!run(tr, Math.max(from - 1, 0), to.b - 1, rule) || !tr.steps.length) return null
        return tr
      },
    })
  )
}

/** Runs `rule` over the words between `from` and `to`; false when a match refused it. */
function run(tr: Transaction, from: number, to: number, rule: PasteRule): boolean {
  const results: (null | undefined)[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code || !(node.isText || node.isTextblock || node.isInline)) return undefined
    const resolvedFrom = Math.max(from, pos)
    const resolvedTo = Math.min(to, pos + node.content.size)
    if (resolvedFrom >= resolvedTo) return undefined
    const text = node.isText
      ? (node.text ?? "")
      : node.textBetween(resolvedFrom - pos, resolvedTo - pos, undefined, "￼")
    for (const match of matchesIn(text, rule.find)) {
      if (match.index === undefined) continue
      const start = resolvedFrom + match.index + 1
      const end = start + (match[0] as string).length
      results.push(
        rule.handler({ tr, range: { from: tr.mapping.map(start), to: tr.mapping.map(end) }, match })
      )
    }
    return undefined
  })
  return results.every((result) => result !== null)
}

function matchesIn(text: string, find: PasteRule["find"]): PasteMatch[] {
  if (find instanceof RegExp) return [...text.matchAll(find)] as PasteMatch[]
  return (find(text) ?? []).map((found) => {
    const match = [found.text] as PasteMatch
    match.index = found.index
    match.input = text
    if (found.data) match.data = found.data
    if (found.replaceWith) match.push(found.replaceWith)
    return match
  })
}

/** The marks over `from`–`to`, with the stretch of each node that carries them. */
function marksBetween(
  from: number,
  to: number,
  doc: Node
): { mark: Mark; from: number; to: number }[] {
  const found: { mark: Mark; from: number; to: number }[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    for (const mark of node.marks) found.push({ from: pos, to: pos + node.nodeSize, mark })
    return true
  })
  return found
}
