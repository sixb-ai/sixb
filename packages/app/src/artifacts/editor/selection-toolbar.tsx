import { cn } from "@sixb/ui/lib/utils"
import type { Editor } from "@tiptap/core"
import { TextSelection, type Transaction } from "@tiptap/pm/state"
import { useEditorState } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { ySyncPluginKey } from "@tiptap/y-tiptap"
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
import { type ReactNode, useEffect, useRef, useState } from "react"
import type { BlockChoice, BlockType } from "./blocks"
import type { EditorMessages } from "./messages"

// The toolbar over selected words: what block they are in, the marks they carry, and a link. It
// shows for a range of text, never for a block picked whole or for code, where marks do not
// apply; ⌘K opens its link field from the keyboard.

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
  const marks = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      strike: editor.isActive("strike"),
      code: editor.isActive("code"),
      link: editor.isActive("link") ? String(editor.getAttributes("link").href ?? "") : null,
      block: types.find((type) => type.turnsInto && type.isActive(editor)) ?? types[0],
    }),
  })

  // Each new selection this reader makes opens on its marks; another editor's typing, which
  // moves it, leaves the link field open.
  useEffect(() => {
    const reset = ({ transaction }: { readonly transaction: Transaction }) => {
      if (transaction.selectionSet && !transaction.getMeta(ySyncPluginKey)) setMode("marks")
    }
    editor.on("transaction", reset)
    return () => {
      editor.off("transaction", reset)
    }
  }, [editor])
  useEffect(() => {
    if (linkRequest > 0) setMode("link")
  }, [linkRequest])

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="sixb-selection-toolbar"
      updateDelay={80}
      options={{ placement: "top", offset: 10, flip: true, shift: { padding: 12 } }}
      shouldShow={({ editor, state, from, to }) => {
        if (!editor.isEditable || from === to) return false
        if (editor.isActive("codeBlock") || editor.isActive("image")) return false
        // A block picked whole (a rule, a figure, a table's cells) has no words to mark.
        return state.selection instanceof TextSelection || mode === "link"
      }}
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
          marks={{
            bold: !!marks?.bold,
            italic: !!marks?.italic,
            strike: !!marks?.strike,
            code: !!marks?.code,
            link: marks?.link ?? null,
            block: marks?.block?.id ?? null,
          }}
          types={types}
          messages={messages}
          onMark={(mark) => {
            const chain = editor.chain().focus()
            if (mark === "bold") chain.toggleBold().run()
            else if (mark === "italic") chain.toggleItalic().run()
            else if (mark === "strike") chain.toggleStrike().run()
            else chain.toggleCode().run()
          }}
          onTurnInto={(id) => types.find((type) => type.id === id)?.make(editor)}
          onLink={(href) => {
            const chain = editor.chain().focus().extendMarkRange("link")
            if (href) chain.setLink({ href }).run()
            else chain.unsetLink().run()
          }}
          onCancelLink={() => editor.commands.focus()}
        />
      </div>
    </BubbleMenu>
  )
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
