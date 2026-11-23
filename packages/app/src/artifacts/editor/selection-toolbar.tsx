import { cn } from "@sixb/ui/lib/utils"
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  ExternalLink,
  Italic,
  Link2,
  Strikethrough,
  Unlink,
} from "lucide-react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { BlockChoice, BlockType } from "./blocks"
import {
  extendMarkRange,
  getMarkAttributes,
  isMarkActive,
  isNodeActive,
  setMark,
  unsetMark,
} from "./core/commands"
import type { Editor } from "./core/editor"
import type { MarkType, NodeType } from "./core/model"
import { type EditorState, NodeSelection, TextSelection } from "./core/state"
import { type FloatingRect, floatingPosition } from "./floating"
import type { EditorMessages } from "./messages"
import { documentSchema } from "./schema"

// The toolbar over selected words: what block they are in, the marks they carry, and a link. It
// shows for a range of text, never for a block picked whole or for code, where marks do not
// apply; ⌘K opens its link field from the keyboard.

const marks = documentSchema.marks as Record<string, MarkType>
const nodes = documentSchema.nodes as Record<string, NodeType>

/** How long a new selection waits before the toolbar follows it, so a drag does not chase it. */
const UPDATE_DELAY = 80
/** How long the page rests, resized or scrolled, before the toolbar is placed again. */
const RESIZE_DELAY = 60

export function SelectionToolbar({
  editor,
  types,
  messages,
  linkRequest,
}: {
  readonly editor: Editor
  readonly types: readonly BlockType[]
  readonly messages: EditorMessages
  /** Bumped by ⌘K: opens the link field over the selection. */
  readonly linkRequest: number
}) {
  const [mode, setMode] = useState<ToolbarMode>("marks")
  const modeRef = useRef(mode)
  modeRef.current = mode
  const element = useRef<HTMLDivElement | null>(null)
  /** Shows the toolbar now if it should show and is still waiting to. */
  const reveal = useRef<(() => void) | null>(null)
  const state = useToolbarState(editor, types)

  const shouldShow = useCallback(
    (current: EditorState) => {
      const { from, to } = current.selection
      if (!editor.isEditable || from === to) return false
      const tr = current.tr
      if (
        isNodeActive(tr, nodes.codeBlock as NodeType) ||
        isNodeActive(tr, nodes.image as NodeType)
      )
        return false
      // A block picked whole (a rule, a figure, a table's cells) has no words to mark.
      return current.selection instanceof TextSelection || modeRef.current === "link"
    },
    [editor]
  )

  const place = useCallback(() => {
    const floating = element.current
    if (!floating) return
    const { selection } = editor.state
    let rect: FloatingRect
    const node =
      selection instanceof NodeSelection
        ? (editor.view.nodeDOM(selection.from) as HTMLElement | null)
        : null
    if (node) {
      rect = node.getBoundingClientRect()
    } else {
      const size = editor.state.doc.content.size
      const start = editor.view.coordsAtPos(Math.min(Math.max(selection.from, 0), size))
      const end = editor.view.coordsAtPos(Math.min(Math.max(selection.to, 0), size), -1)
      const top = Math.min(start.top, end.top)
      const left = Math.min(start.left, end.left)
      rect = {
        left,
        top,
        width: Math.max(start.right, end.right) - left,
        height: Math.max(start.bottom, end.bottom) - top,
      }
    }
    const { x, y } = floatingPosition(rect, floating, {
      placement: "top",
      offset: 10,
      flip: true,
      shift: 12,
    })
    floating.style.left = `${x}px`
    floating.style.top = `${y}px`
  }, [editor])

  // The toolbar follows the selection: a new range waits a moment, so a drag does not chase it,
  // and a caret hides it at once. It is placed as it shows and stays there while it is used, its
  // link field or its kinds of block growing from where it stands.
  useEffect(() => {
    const floating = element.current
    if (!floating) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let shown = false
    let preventHide = false
    const show = () => {
      if (shown) return
      floating.style.display = ""
      floating.style.visibility = "visible"
      shown = true
    }
    const hide = () => {
      if (!shown) return
      floating.style.display = "none"
      floating.style.visibility = "hidden"
      shown = false
    }
    const follow = (changed: boolean) => {
      if (editor.view.composing || !changed) return
      if (!shouldShow(editor.state)) return hide()
      show()
      place()
    }
    const update = (previous?: EditorState) => {
      const current = editor.state
      const changed = !previous?.selection.eq(current.selection) || !previous.doc.eq(current.doc)
      if (current.selection.from === current.selection.to) return follow(changed)
      if (!changed) return
      clearTimeout(timer)
      timer = setTimeout(() => follow(true), UPDATE_DELAY)
    }

    let last: EditorState = editor.state
    const offTransaction = editor.on("transaction", ({ transaction }) => {
      // Each new selection this reader makes opens on its marks; another editor's typing, which
      // moves it, leaves the link field open.
      if (transaction?.selectionSet && !transaction.getMeta("remote")) setMode("marks")
      const previous = last
      last = editor.state
      update(previous)
    })
    const offFocus = editor.on("focus", () => setTimeout(() => update()))
    const offBlur = editor.on("blur", ({ event }) => {
      if (preventHide) {
        preventHide = false
        return
      }
      // Focus moving into the toolbar's own field, or back to the text, keeps it.
      const related = (event?.relatedTarget ?? null) as globalThis.Node | null
      if (
        related &&
        (floating.contains(related) || editor.view.dom.parentElement?.contains(related))
      )
        return
      hide()
    })
    const down = () => {
      preventHide = true
    }
    const composed = () => setTimeout(() => update())
    const moved = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => shown && place(), RESIZE_DELAY)
    }
    floating.addEventListener("mousedown", down, { capture: true })
    editor.view.dom.addEventListener("dragstart", hide)
    editor.view.dom.addEventListener("compositionend", composed)
    window.addEventListener("resize", moved)
    window.addEventListener("scroll", moved)
    reveal.current = () => {
      if (shown || !shouldShow(editor.state)) return
      clearTimeout(timer)
      show()
      place()
    }
    if (shouldShow(editor.state)) {
      show()
      place()
    }
    return () => {
      reveal.current = null
      clearTimeout(timer)
      clearTimeout(resizeTimer)
      offTransaction()
      offFocus()
      offBlur()
      floating.removeEventListener("mousedown", down, { capture: true })
      editor.view.dom.removeEventListener("dragstart", hide)
      editor.view.dom.removeEventListener("compositionend", composed)
      window.removeEventListener("resize", moved)
      window.removeEventListener("scroll", moved)
      hide()
    }
  }, [editor, shouldShow, place])

  useEffect(() => {
    if (linkRequest > 0) setMode("link")
  }, [linkRequest])
  // ⌘K opens the link field at once rather than after the selection's delay, so the field can
  // take the focus and what is typed next goes into it.
  useLayoutEffect(() => {
    if (mode === "link") reveal.current?.()
  }, [mode])

  return (
    <div
      ref={element}
      style={{ position: "absolute", width: "max-content", visibility: "hidden", display: "none" }}
    >
      <div
        className="sixb-editor-popover flex items-center gap-0.5 p-1"
        onMouseDown={(event) => {
          // The selection stays as it is while its toolbar is used, but a field may take focus.
          if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
        }}
      >
        <SelectionToolbarBody
          mode={mode}
          onMode={setMode}
          marks={state}
          types={types}
          messages={messages}
          onMark={(mark) => {
            editor.run(toggleMarkCommand(marks[mark] as MarkType))
            editor.focus()
          }}
          onTurnInto={(id) => types.find((type) => type.id === id)?.make(editor)}
          onLink={(href) => {
            editor.run((tr) => {
              extendMarkRange(marks.link as MarkType)(tr)
              if (href) setMark(marks.link as MarkType, { href })(tr)
              else unsetMark(marks.link as MarkType, { extendEmptyMarkRange: true })(tr)
              tr.setMeta("preventAutolink", true)
              return true
            })
            editor.focus()
          }}
          onCancelLink={() => editor.focus()}
        />
      </div>
    </div>
  )
}

function toggleMarkCommand(type: MarkType) {
  return (tr: import("./core/state").Transaction) =>
    isMarkActive(tr, type) ? unsetMark(type)(tr) : setMark(type)(tr)
}

/** What the toolbar shows for the selection, read again after each transaction. */
function useToolbarState(editor: Editor, types: readonly BlockType[]): ToolbarState {
  const snapshot = useRef<ToolbarState | null>(null)
  const subscribe = useCallback(
    (changed: () => void) =>
      editor.on("transaction", () => {
        const next = toolbarState(editor, types)
        const current = snapshot.current
        if (
          current &&
          (Object.keys(next) as (keyof ToolbarState)[]).every((key) => current[key] === next[key])
        )
          return
        snapshot.current = next
        changed()
      }),
    [editor, types]
  )
  return useSyncExternalStore(subscribe, () => {
    snapshot.current ??= toolbarState(editor, types)
    return snapshot.current
  })
}

type ToolbarState = ReturnType<typeof toolbarState>

/** What the toolbar shows for the selection now. */
function toolbarState(editor: Editor, types: readonly BlockType[]) {
  const tr = editor.state.tr
  const link = isMarkActive(tr, marks.link as MarkType)
    ? String(getMarkAttributes(tr, marks.link as MarkType).href ?? "")
    : null
  return {
    bold: isMarkActive(tr, marks.bold as MarkType),
    italic: isMarkActive(tr, marks.italic as MarkType),
    strike: isMarkActive(tr, marks.strike as MarkType),
    code: isMarkActive(tr, marks.code as MarkType),
    link,
    block: (types.find((type) => type.turnsInto && type.isActive(editor)) ?? types[0])?.id ?? null,
  }
}

export type ToolbarMode = "marks" | "link" | "turnInto"

/** The marks over selected words the toolbar toggles. */
export type ToolbarMark = "bold" | "italic" | "strike" | "code"

/**
 * The toolbar's contents, whichever editor it is over: the block the words are in, their marks,
 * and their link, or the field that edits it, or the kinds of block to turn theirs into.
 */
export function SelectionToolbarBody({
  mode,
  onMode,
  marks,
  types,
  messages,
  onMark,
  onTurnInto,
  onLink,
  onCancelLink,
  turnable = true,
}: {
  readonly mode: ToolbarMode
  readonly onMode: (mode: ToolbarMode) => void
  readonly marks: Readonly<Record<ToolbarMark, boolean>> & {
    readonly link: string | null
    readonly block: string | null
  }
  readonly types: readonly BlockChoice[]
  readonly messages: EditorMessages
  readonly onMark: (mark: ToolbarMark) => void
  readonly onTurnInto: (id: string) => void
  /** Sets the words' link, or removes it with null. */
  readonly onLink: (href: string | null) => void
  readonly onCancelLink: () => void
  /** Whether the words' block may be turned into another kind; a table's cell may not. */
  readonly turnable?: boolean
}) {
  const block = types.find((type) => type.id === marks.block) ?? types[0]
  if (mode === "link") {
    return (
      <LinkField
        href={marks.link ?? ""}
        messages={messages.link}
        onApply={(href) => {
          onLink(href)
          onMode("marks")
        }}
        onCancel={() => {
          onCancelLink()
          onMode("marks")
        }}
      />
    )
  }
  if (mode === "turnInto") {
    return (
      <div className="flex max-h-72 w-56 flex-col overflow-y-auto">
        {types
          .filter((type) => type.turnsInto)
          .map((type) => {
            const Icon = type.icon
            return (
              <button
                key={type.id}
                type="button"
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onTurnInto(type.id)
                  onMode("marks")
                }}
              >
                <Icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
                <span className="flex-1">{type.label}</span>
                {marks.block === type.id ? (
                  <Check className="size-3.5 text-muted-foreground" />
                ) : null}
              </button>
            )
          })}
      </div>
    )
  }
  return (
    <>
      {turnable ? (
        <>
          <button
            type="button"
            className="flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-accent"
            onClick={() => onMode("turnInto")}
            aria-label={messages.toolbar.turnInto}
          >
            {marks.block ? block?.label : messages.toolbar.turnInto}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
          <span className="mx-0.5 h-5 w-px bg-border" />
        </>
      ) : null}
      <MarkButton
        label={messages.toolbar.bold}
        keys="⌘B"
        active={marks.bold}
        onClick={() => onMark("bold")}
      >
        <Bold className="size-4" strokeWidth={2.25} />
      </MarkButton>
      <MarkButton
        label={messages.toolbar.italic}
        keys="⌘I"
        active={marks.italic}
        onClick={() => onMark("italic")}
      >
        <Italic className="size-4" strokeWidth={2.25} />
      </MarkButton>
      <MarkButton
        label={messages.toolbar.strike}
        keys="⌘⇧S"
        active={marks.strike}
        onClick={() => onMark("strike")}
      >
        <Strikethrough className="size-4" strokeWidth={2.25} />
      </MarkButton>
      <MarkButton
        label={messages.toolbar.code}
        keys="⌘E"
        active={marks.code}
        onClick={() => onMark("code")}
      >
        <Code className="size-4" strokeWidth={2.25} />
      </MarkButton>
      <span className="mx-0.5 h-5 w-px bg-border" />
      <MarkButton
        label={messages.toolbar.link}
        keys="⌘K"
        active={marks.link !== null}
        onClick={() => onMode("link")}
      >
        <Link2 className="size-4" strokeWidth={2.25} />
      </MarkButton>
    </>
  )
}

function MarkButton({
  label,
  keys,
  active,
  onClick,
  children,
}: {
  readonly label: string
  readonly keys: string
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={`${label}  ${keys}`}
      className={cn(
        "flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent",
        active ? "text-primary" : "text-foreground"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** The link of the selected words: typed or pasted, applied with Enter, removed in one click. */
function LinkField({
  href,
  messages,
  onApply,
  onCancel,
}: {
  readonly href: string
  readonly messages: EditorMessages["link"]
  readonly onApply: (href: string | null) => void
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState(href)
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <form
      className="flex w-80 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        onApply(value.trim() || null)
      }}
    >
      <Link2 className="ml-1.5 size-4 shrink-0 text-muted-foreground" />
      <input
        ref={input}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder={messages.placeholder}
        className="h-8 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      {href ? (
        <>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={messages.open}
            title={messages.open}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-4" />
          </a>
          <button
            type="button"
            aria-label={messages.remove}
            title={messages.remove}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onApply(null)}
          >
            <Unlink className="size-4" />
          </button>
        </>
      ) : null}
      <button
        type="submit"
        className="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"
      >
        {messages.apply}
      </button>
    </form>
  )
}
