import { cn } from "@sixb/ui/lib/utils"
import { type Editor, Extension, type Range } from "@tiptap/core"
import { PluginKey } from "@tiptap/pm/state"
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion"
import { type Ref, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import type { BlockChoice, BlockType } from "./blocks"
import { findBlockTypes } from "./find-blocks"
import type { EditorMessages } from "./messages"

// The `/` menu: typed anywhere but in code, it lists the blocks that match what follows it, and
// Enter or a click makes one in place of what was typed. Its state lives in a store the menu
// reads, so ProseMirror's keys and React's rendering meet in one place.

interface SlashState {
  readonly open: boolean
  readonly items: readonly BlockType[]
  readonly index: number
  readonly rect: DOMRect | null
  readonly range: Range | null
  readonly editor: Editor | null
}

const CLOSED: SlashState = {
  open: false,
  items: [],
  index: 0,
  rect: null,
  range: null,
  editor: null,
}

/** The `/` menu's state, for one editor. */
export class SlashMenuStore {
  private state: SlashState = CLOSED
  private readonly listeners = new Set<() => void>()

  get = (): SlashState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(next: Partial<SlashState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }

  close(): void {
    this.set(CLOSED)
  }

  /** Makes the block at `index`, in place of the typed `/` and query. */
  choose(index = this.state.index): void {
    const { editor, range, items } = this.state
    const type = items[index]
    this.close()
    if (editor && range && type) type.make(editor, range)
  }
}

const slashKey = new PluginKey("sixb-slash-menu")

/** The `/` trigger, which fills `store` as the person types. */
export function SlashCommand(store: SlashMenuStore, types: () => readonly BlockType[]) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<BlockType>({
          editor: this.editor,
          pluginKey: slashKey,
          char: "/",
          // Not inside code, where `/` is a character like any other.
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from)
            return !$from.parent.type.spec.code
          },
          items: ({ query }) => findBlockTypes(types(), query),
          render: () => ({
            onStart: (props: SuggestionProps<BlockType>) => open(store, props),
            onUpdate: (props: SuggestionProps<BlockType>) => open(store, props),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => keyDown(store, event),
            onExit: () => store.close(),
          }),
        }),
      ]
    },
  })
}

function open(store: SlashMenuStore, props: SuggestionProps<BlockType>): void {
  const keep = store.get().open && store.get().items.length === props.items.length
  store.set({
    open: true,
    items: props.items,
    index: keep ? Math.min(store.get().index, Math.max(0, props.items.length - 1)) : 0,
    // On the first key the typed `/` is not drawn yet: where ProseMirror places it.
    rect: props.clientRect?.() ?? caretRect(props.editor, props.range.from),
    range: props.range,
    editor: props.editor,
  })
}

function caretRect(editor: Editor, pos: number): DOMRect | null {
  try {
    const { left, right, top, bottom } = editor.view.coordsAtPos(pos)
    return new DOMRect(left, top, right - left, bottom - top)
  } catch {
    return null
  }
}

function keyDown(store: SlashMenuStore, event: KeyboardEvent): boolean {
  const { open, items, index } = store.get()
  if (!open) return false
  if (event.key === "Escape") {
    store.close()
    return true
  }
  if (items.length === 0) return false
  if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
    store.set({ index: (index + 1) % items.length })
    return true
  }
  if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
    store.set({ index: (index - 1 + items.length) % items.length })
    return true
  }
  if (event.key === "Enter" || event.key === "Tab") {
    store.choose()
    return true
  }
  return false
}

export const SLASH_MENU_WIDTH = 304
export const SLASH_MENU_MAX_HEIGHT = 360

/** The menu itself, below the `/`, or above it when the page ends first. */
export function SlashMenu({
  store,
  messages,
}: {
  readonly store: SlashMenuStore
  readonly messages: EditorMessages
}) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [above, setAbove] = useState(false)

  useLayoutEffect(() => {
    if (!state.rect) return
    setAbove(state.rect.bottom + SLASH_MENU_MAX_HEIGHT + 16 > window.innerHeight)
  }, [state.rect])

  // The chosen row stays in view as the arrows move through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${state.index}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [state.index])

  if (!state.open || !state.rect) return null
  const left = Math.min(state.rect.left, window.innerWidth - SLASH_MENU_WIDTH - 12)
  const position = above
    ? { left, bottom: window.innerHeight - state.rect.top + 8 }
    : { left, top: state.rect.bottom + 8 }

  return createPortal(
    <div
      role="listbox"
      aria-label={messages.blocksTitle}
      className="sixb-editor-popover fixed z-50 flex flex-col overflow-hidden"
      style={{ ...position, width: SLASH_MENU_WIDTH, maxHeight: SLASH_MENU_MAX_HEIGHT }}
      // A click must not take the focus from the text, or the typed `/` is lost.
      onMouseDown={(event) => event.preventDefault()}
    >
      <SlashMenuItems
        items={state.items}
        index={state.index}
        messages={messages}
        listRef={listRef}
        onPoint={(index) => store.set({ index })}
        onChoose={(index) => store.choose(index)}
      />
    </div>,
    document.body
  )
}

/** The `/` menu's list: the kinds of block that match, the one pointed at marked. */
export function SlashMenuItems({
  items,
  index: pointed,
  messages,
  listRef,
  onPoint,
  onChoose,
}: {
  readonly items: readonly BlockChoice[]
  readonly index: number
  readonly messages: EditorMessages
  readonly listRef?: Ref<HTMLDivElement>
  readonly onPoint: (index: number) => void
  readonly onChoose: (index: number) => void
}) {
  return items.length === 0 ? (
    <p className="px-3 py-2.5 text-sm text-muted-foreground">{messages.noBlocks}</p>
  ) : (
    <div ref={listRef} className="overflow-y-auto p-1.5">
      <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {messages.blocksTitle}
      </p>
      {items.map((type, index) => {
        const Icon = type.icon
        const active = index === pointed
        return (
          <button
            key={type.id}
            type="button"
            role="option"
            aria-selected={active}
            data-index={index}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
              active ? "bg-accent text-accent-foreground" : "text-foreground"
            )}
            onMouseEnter={() => onPoint(index)}
            onClick={() => onChoose(index)}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-xs">
              <Icon className="size-[18px]" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{type.label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {type.description}
              </span>
            </span>
            {type.shortcut ? (
              <kbd className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {type.shortcut.trim()}
              </kbd>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
