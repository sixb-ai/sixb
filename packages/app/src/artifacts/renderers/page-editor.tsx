import type { FrameEmbed, FrameEvent } from "@sixb/core/artifacts"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, toast } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { GripVertical, Plus, SeparatorHorizontal } from "lucide-react"
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { encodeAwarenessUpdate } from "y-protocols/awareness"
import * as Y from "yjs"
import { BlockMenuItems } from "../editor/block-handle"
import { type BlockChoice, blockTypes } from "../editor/blocks"
import type { EditorMessages } from "../editor/messages"
import { SelectionToolbarBody, type ToolbarMode } from "../editor/selection-toolbar"
import { SLASH_MENU_MAX_HEIGHT, SLASH_MENU_WIDTH, SlashMenuItems } from "../editor/slash-menu"
import { useImageUpload } from "../editor/upload"
import { ArtifactFrame, type ArtifactFrameHandle } from "../frame"
import type {
  AppToEditor,
  EditorCommand,
  EditorRect,
  EditorToApp,
  HoverState,
  PageBlockId,
  SelectionState,
  SlashState,
} from "../frame-editor/protocol"
import { FrameEmbeds } from "../frame-embeds"
import { liveDocumentOf } from "../live/document"
import type { LiveArtifact } from "../live/session"
import { useArtifactMessages } from "../messages"
import type { ArtifactVersion } from "../queries"
import { ViewerLoading, ViewerNotice } from "./notice"
import { usePageEvents } from "./page"

// A designed document edited as a page of notes, in its own design: the editor runs in the
// document's frame, on the page itself (../frame-editor), and the app draws everything around it
// over the frame, in the app's design: the toolbar over selected words, the `/` menu, the handle
// beside each block, and the line where a dragged block will land. The frame and the app keep one
// live document in step by its Yjs updates, through a port of their own.

/** The kinds of block a designed document's editor makes, in the order the `/` menu lists them. */
const PAGE_BLOCKS: readonly PageBlockId[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulletList",
  "orderedList",
  "quote",
  "table",
  "image",
  "divider",
  "pageBreak",
]

/** How long the handle stays once the pointer leaves its block, to be reached. */
const HANDLE_GRACE_MS = 260
/** How far the pointer moves on the grip before a press is a drag. */
const DRAG_THRESHOLD = 4

/** The blocks of a page, as the menus show them. */
export function pageBlockChoices(messages: EditorMessages): BlockChoice[] {
  const known = new Map<string, BlockChoice>(
    blockTypes(messages.blocks, { pickImage: () => {} }).map((type) => [type.id, type])
  )
  const pageBreak: BlockChoice = {
    id: "pageBreak",
    icon: SeparatorHorizontal,
    ...messages.blocks.pageBreak,
    keywords: ["page", "break", "new page"],
    turnsInto: false,
  }
  return PAGE_BLOCKS.map((id) => (id === "pageBreak" ? pageBreak : known.get(id))).filter(
    (choice): choice is BlockChoice => choice !== undefined
  )
}

export function PageEditor({
  version: opened,
  live,
  editable,
}: {
  /**
   * The version the frame loads, for its stylesheets and pictures; the words are the live
   * document's. The frame keeps the one it opened with: a newer one would load it again.
   */
  readonly version: ArtifactVersion
  readonly live: LiveArtifact
  readonly editable: boolean
}) {
  const [version] = useState(opened)
  const messages = useArtifactMessages()
  const frame = useRef<ArtifactFrameHandle | null>(null)
  const overlay = useRef<HTMLDivElement | null>(null)
  const port = useRef<MessagePort | null>(null)
  const stop = useRef<(() => void) | null>(null)
  /** Counts the frame's loads, and the unmount: a start a later one overtook stops there. */
  const starts = useRef(0)
  const picker = useRef<HTMLInputElement | null>(null)
  const pickAt = useRef<number | null>(null)
  const editableRef = useRef(editable)
  editableRef.current = editable

  const choices = useMemo(() => pageBlockChoices(messages.editor), [messages.editor])
  const [embeds, setEmbeds] = useState<readonly FrameEmbed[]>([])
  const pageEvents = usePageEvents(version, { onEmbeds: setEmbeds })
  const [focused, setFocused] = useState(false)
  const [selection, setSelection] = useState<SelectionState | null>(null)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [line, setLine] = useState<EditorRect | null>(null)
  const [mode, setMode] = useState<ToolbarMode>("marks")

  const send = useCallback((message: AppToEditor) => port.current?.postMessage(message), [])
  const run = useCallback((command: EditorCommand) => send({ type: "run", command }), [send])

  const upload = useImageUpload(live, version)
  const addImages = useCallback(
    async (files: readonly File[], at: number | null) => {
      let first = true
      for (const file of files) {
        try {
          const { src, alt } = await upload(file)
          const place = first && at !== null ? { at } : {}
          run({ name: "image", src, alt, preview: file, ...place })
          first = false
        } catch (error) {
          toast.error(
            error instanceof Error && error.message ? error.message : messages.editor.imageFailed
          )
        }
      }
    },
    [upload, run, messages.editor.imageFailed]
  )

  // The handle stays a moment after the pointer leaves its block, and while its menu is open.
  const [menu, setMenu] = useState<HoverState | null>(null)
  const overHandle = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showHover = useCallback((next: HoverState | null) => {
    clearTimeout(hideTimer.current)
    if (next) {
      setHover(next)
      return
    }
    hideTimer.current = setTimeout(() => {
      if (!overHandle.current) setHover(null)
    }, HANDLE_GRACE_MS)
  }, [])
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const receive = useCallback(
    (message: EditorToApp) => {
      switch (message.type) {
        case "ready": {
          send({
            type: "start",
            state: Y.encodeStateAsUpdate(live.doc),
            path: version.entry,
            editable: editableRef.current,
            blocks: choices.map(({ id, label, keywords }) => ({
              id: id as PageBlockId,
              label,
              keywords,
            })),
            words: {
              placeholder: messages.editor.placeholder,
              listItem: messages.editor.listItem,
              headings: [1, 2, 3, 4, 5, 6].map((level) => messages.editor.heading(level)),
              pageBreak: messages.editor.pageBreak,
            },
          })
          const others = [...live.awareness.getStates().keys()].filter(
            (client) => client !== live.doc.clientID
          )
          if (others.length > 0) {
            send({ type: "awareness", update: encodeAwarenessUpdate(live.awareness, others) })
          }
          return
        }
        case "update":
          // As the reader's own changes, which the header's Undo and Redo take back and make again.
          Y.applyUpdate(live.doc, message.update, liveDocumentOf(live).origin)
          return
        case "cursor":
          live.awareness.setLocalStateField("cursor", message.cursor)
          return
        case "focus":
          setFocused(message.focused)
          return
        case "selection":
          setSelection(message.selection)
          if (!message.selection) setMode((current) => (current === "link" ? current : "marks"))
          return
        case "slash":
          setSlash(message.slash)
          return
        case "hover":
          showHover(message.hover)
          return
        case "drop":
          setLine(message.line)
          return
        case "linkRequest":
          setMode("link")
          return
        case "upload":
          void addImages(message.files, message.at)
          return
        case "pickImage":
          pickAt.current = message.at
          picker.current?.click()
          return
        case "gone":
          return
      }
    },
    [live, version.entry, choices, messages.editor, send, showHover, addImages]
  )

  /** Runs the editor in the frame that just loaded, with a port of its own. */
  const start = useCallback(async () => {
    stop.current?.()
    stop.current = null
    const started = ++starts.current
    const { FRAME_EDITOR_SCRIPT } = await import("../frame-editor/bundle")
    if (started !== starts.current) return
    const channel = new MessageChannel()
    port.current = channel.port1
    channel.port1.onmessage = (event: MessageEvent<EditorToApp>) => receive(event.data)

    // What changes in the live document, from others, the Agent or the server, reaches the frame.
    const own = liveDocumentOf(live).origin
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== own) channel.port1.postMessage({ type: "update", update })
    }
    const onAwareness = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ) => {
      if (origin === "local") return
      const clients = [...changes.added, ...changes.updated, ...changes.removed].filter(
        (client) => client !== live.doc.clientID
      )
      if (clients.length === 0) return
      channel.port1.postMessage({
        type: "awareness",
        update: encodeAwarenessUpdate(live.awareness, clients),
      })
    }
    live.doc.on("update", onUpdate)
    live.awareness.on("update", onAwareness)
    stop.current = () => {
      live.doc.off("update", onUpdate)
      live.awareness.off("update", onAwareness)
      channel.port1.close()
      if (port.current === channel.port1) port.current = null
    }
    await frame.current
      ?.send("editor", { code: FRAME_EDITOR_SCRIPT }, [channel.port2])
      .catch((error: unknown) => console.error("[SixbApp] The page editor did not start.", error))
  }, [live, receive])

  useEffect(
    () => () => {
      starts.current += 1
      stop.current?.()
      stop.current = null
      live.awareness.setLocalStateField("cursor", null)
    },
    [live]
  )
  useEffect(() => {
    send({ type: "editable", editable })
  }, [editable, send])

  const onEvent = useCallback(
    (event: FrameEvent) => {
      if (event.event === "ready") void start()
      pageEvents(event)
    },
    [start, pageEvents]
  )
  const scroll = useCallback((delta: { readonly x: number; readonly y: number }) => {
    frame.current?.send("scroll", delta).catch(() => {})
  }, [])

  const toolbar = editable && selection && !slash && !line && (focused || mode !== "marks")
  const handle = editable && !slash ? (menu ?? hover) : null

  return (
    <>
      <ArtifactFrame
        handle={frame}
        version={version}
        title={messages.document.frame(version.title)}
        editable
        onEvent={onEvent}
        className="flex-1"
        fallback={<ViewerLoading label={messages.viewer.loading} />}
        failure={<ViewerNotice title={messages.document.loadFailed} />}
        overlay={
          <div ref={overlay} className="absolute inset-0">
            <FrameEmbeds version={version} embeds={embeds} onScroll={scroll} />
            {line ? <DropLine line={line} /> : null}
            {handle ? (
              <BlockHandle
                rect={handle.rect}
                pos={handle.pos}
                textual={handle.textual}
                open={menu !== null}
                messages={messages.editor}
                choices={choices}
                overlay={overlay}
                onOpen={(open) => {
                  // The menu acts on the block it opened for, wherever the pointer goes.
                  setMenu(open ? handle : null)
                  if (open) run({ name: "pick", pos: handle.pos })
                  else run({ name: "focus" })
                }}
                onHover={(over) => {
                  overHandle.current = over
                  if (!over) showHover(null)
                }}
                run={run}
              />
            ) : null}
            {toolbar && selection ? (
              <Floating rect={selection.rect} overlay={overlay}>
                <div
                  className="sixb-editor-popover flex items-center gap-0.5 p-1"
                  onMouseDown={(event) => {
                    // The words stay selected while the toolbar is used; its field takes focus.
                    if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
                  }}
                >
                  <SelectionToolbarBody
                    mode={mode}
                    onMode={setMode}
                    marks={{
                      bold: selection.marks.bold,
                      italic: selection.marks.italic,
                      strike: selection.marks.strike,
                      code: selection.marks.code,
                      link: selection.link,
                      block: selection.block,
                    }}
                    types={choices}
                    messages={messages.editor}
                    onMark={(mark) => run({ name: "mark", mark })}
                    onTurnInto={(id) => run({ name: "turnInto", block: id as PageBlockId })}
                    onLink={(href) => run({ name: "link", href })}
                    onCancelLink={() => run({ name: "focus" })}
                    turnable={selection.turnable}
                  />
                </div>
              </Floating>
            ) : null}
            {editable && slash ? (
              <SlashMenu
                slash={slash}
                choices={choices}
                messages={messages.editor}
                overlay={overlay}
                run={run}
              />
            ) : null}
          </div>
        }
      />
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ""
          void addImages(files, pickAt.current)
        }}
      />
    </>
  )
}

/** The overlay's size, which the frame's viewport is, for what must stay inside it. */
function overlaySize(overlay: RefObject<HTMLDivElement | null>) {
  const box = overlay.current?.getBoundingClientRect()
  return { width: box?.width ?? window.innerWidth, height: box?.height ?? window.innerHeight }
}

/** The toolbar over selected words: centered above them, or below where the page starts. */
function Floating({
  rect,
  overlay,
  children,
}: {
  readonly rect: EditorRect
  readonly overlay: RefObject<HTMLDivElement | null>
  readonly children: ReactNode
}) {
  const { width } = overlaySize(overlay)
  const below = rect.top < 56
  const center = Math.min(Math.max((rect.left + rect.right) / 2, 180), width - 180)
  return (
    <div
      className="pointer-events-auto absolute z-20"
      style={{
        left: center,
        top: below ? rect.bottom + 10 : rect.top - 10,
        transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
      }}
    >
      {children}
    </div>
  )
}

function SlashMenu({
  slash,
  choices,
  messages,
  overlay,
  run,
}: {
  readonly slash: SlashState
  readonly choices: readonly BlockChoice[]
  readonly messages: EditorMessages
  readonly overlay: RefObject<HTMLDivElement | null>
  readonly run: (command: EditorCommand) => void
}) {
  const list = useRef<HTMLDivElement | null>(null)
  const items = slash.items
    .map((id) => choices.find((choice) => choice.id === id))
    .filter((choice): choice is BlockChoice => choice !== undefined)
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${slash.index}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [slash.index])

  const { width, height } = overlaySize(overlay)
  const above =
    slash.rect.bottom + SLASH_MENU_MAX_HEIGHT + 16 > height && slash.rect.top > height / 2
  const left = Math.max(8, Math.min(slash.rect.left, width - SLASH_MENU_WIDTH - 8))
  return (
    <div
      role="listbox"
      aria-label={messages.blocksTitle}
      className="sixb-editor-popover pointer-events-auto absolute z-20 flex flex-col overflow-hidden"
      style={{
        left,
        width: SLASH_MENU_WIDTH,
        maxHeight: Math.min(SLASH_MENU_MAX_HEIGHT, height - 16),
        ...(above ? { bottom: height - slash.rect.top + 8 } : { top: slash.rect.bottom + 8 }),
      }}
      // A click must not take the focus from the page, or the typed `/` is lost.
      onMouseDown={(event) => event.preventDefault()}
    >
      <SlashMenuItems
        items={items}
        index={slash.index}
        messages={messages}
        listRef={list}
        onPoint={(index) => run({ name: "point", index })}
        onChoose={(index) => run({ name: "choose", index })}
      />
    </div>
  )
}

/**
 * The handle beside the block the pointer is over: `+` adds a block below and opens the `/` menu
 * there; the grip drags the block, and a click on it opens what can be done to it.
 */
function BlockHandle({
  rect,
  pos,
  textual,
  open,
  messages,
  choices,
  overlay,
  onOpen,
  onHover,
  run,
}: {
  readonly rect: EditorRect
  readonly pos: number
  readonly textual: boolean
  readonly open: boolean
  readonly messages: EditorMessages
  readonly choices: readonly BlockChoice[]
  readonly overlay: RefObject<HTMLDivElement | null>
  readonly onOpen: (open: boolean) => void
  readonly onHover: (over: boolean) => void
  readonly run: (command: EditorCommand) => void
}) {
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const point = (event: ReactPointerEvent) => {
    const box = overlay.current?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }
  const left = Math.max(4, rect.left - 54)

  return (
    <div
      className="sixb-editor-handle pointer-events-auto absolute z-10 flex items-center gap-0.5"
      style={{ left, top: rect.top - 1 }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      <button
        type="button"
        aria-label={messages.handle.add}
        title={messages.handle.add}
        className="sixb-editor-handle-button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run({ name: "addBelow", pos })}
      >
        <Plus className="size-[18px]" strokeWidth={1.75} />
      </button>
      <DropdownMenu open={open} onOpenChange={onOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={messages.handle.menu}
            title={`${messages.handle.drag}\n${messages.handle.menu}`}
            className={cn(
              "sixb-editor-handle-button cursor-grab touch-none active:cursor-grabbing"
            )}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              // A press opens the menu only once it is a click, not the start of a drag.
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              press.current = { x: event.clientX, y: event.clientY, dragging: false }
            }}
            onPointerMove={(event) => {
              const pressed = press.current
              if (!pressed) return
              const far =
                Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y) >
                DRAG_THRESHOLD
              if (!pressed.dragging && !far) return
              pressed.dragging = true
              run({ name: "drag", pos, ...point(event) })
            }}
            onPointerUp={(event) => {
              const pressed = press.current
              press.current = null
              if (!pressed) return
              if (pressed.dragging) run({ name: "drop", pos, ...point(event) })
              else onOpen(true)
            }}
            onPointerCancel={() => {
              if (press.current?.dragging) run({ name: "endDrag" })
              press.current = null
            }}
          >
            <GripVertical className="size-[18px]" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="left"
          align="start"
          sideOffset={6}
          className="w-56"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <BlockMenuItems
            textual={textual}
            types={choices}
            messages={messages}
            onTurnInto={(id) => run({ name: "turnInto", block: id as PageBlockId, pos })}
            onDuplicate={() => run({ name: "duplicate", pos })}
            onMove={(by) => run({ name: "move", pos, by })}
            onRemove={() => run({ name: "remove", pos })}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Where a dragged block will land: a line across the page. */
function DropLine({ line }: { readonly line: EditorRect }) {
  return (
    <div
      className="pointer-events-none absolute z-10 h-[3px] rounded-full bg-primary"
      style={{ left: line.left, top: line.top - 1.5, width: Math.max(0, line.right - line.left) }}
    />
  )
}
