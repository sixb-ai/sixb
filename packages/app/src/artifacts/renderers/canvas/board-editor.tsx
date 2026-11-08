import { uploadFile } from "@sixb/client"
import {
  ARTIFACT_LIMITS,
  type CanvasBoard,
  type FrameEditTarget,
  type FrameEvent,
} from "@sixb/core/artifacts"
import {
  boardFilePath,
  boardFramePatches,
  mergeBoardText,
  setBoardImage,
  setBoardStyle,
} from "@sixb/core/artifacts/live"
import type { FileRef } from "@sixb/core/blob-storage"
import { Popover, PopoverContent, PopoverTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Code2, ImageIcon, LoaderCircle, MessageSquarePlus, Paintbrush } from "lucide-react"
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { ArtifactFrame, type ArtifactFrameHandle } from "../../frame"
import { useLiveBoardSource, useLiveStoredFiles } from "../../live/boards"
import type { LiveCanvas } from "../../live/canvas"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import { type ArtifactVersion, useFileText, versionFileSource } from "../../queries"
import { type CanvasImage, ImagePanel, type StyleChange, StylePanel } from "./board-properties"
import {
  boardAttribute,
  boardInlineStyle,
  boardReferencePath,
  showablePatches,
} from "./board-source"
import { CommentPin, DraftCard, type DraftPlace, type PinPlace, pinPoint } from "./comment-pins"

// A board opened over the canvas, as its page runs in its frame, and what the reader does on it:
// read it, edit what it shows, or pick what to comment on.
//
// The frame serves the board as a stored version holds it, marked for editing; the live document
// holds it as everyone is changing it now. The frame is kept at the version it loaded and told,
// element by element, what changed since (`edit.patch`), so typing goes on under the caret while
// others change other elements. It loads a newer version only when the elements themselves
// changed, or a picture it does not hold yet is shown, and then once the stored version holds it.
//
//   frame ── edit.select ──▶ the element picked, its toolbar        (the reader's own click)
//         ── edit.text ───▶ mergeBoardText → the board's Y.Text     (only for the element picked)
//         ◀─ edit.patch ── what the document changed since the frame's version

/** What edits a board's elements: the live canvas, under the reader's own undo. */
export type BoardEditor = Pick<LiveCanvas, "editBoard" | "stopCapturing">

/** What the reader is doing on an opened board. */
export type StageMode = "read" | "edit" | "comment"

/** An element picked to comment on: where the reader clicked, and what is there. */
export type CommentPick = Omit<DraftPlace, "board">

/** The image file types a board shows, by extension. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg)$/i

/**
 * Follows a board's frame and the live document together: the version it shows, kept until it
 * must move, what it showed last, and the patches that bring it to what the document holds.
 */
function useBoardFrame({
  version,
  board,
  live,
}: {
  readonly version: ArtifactVersion
  readonly board: CanvasBoard
  readonly live: LiveArtifact | null
}) {
  const source = useLiveBoardSource(live, board.file)
  const patching = source !== null
  const [pinned, setPinned] = useState(version)
  const shows = patching ? pinned : version
  const stored = useFileText(patching ? versionFileSource(pinned, board.file) : null).text

  const handle = useRef<ArtifactFrameHandle | null>(null)
  /** Each load the frame said it is ready, for what follows to start over. */
  const [loads, setLoads] = useState(0)
  /** What the frame shows now, once patched past its version's page. */
  const shown = useRef<string | null>(null)
  /** Pictures the reader just uploaded, shown from their bytes until a version holds them. */
  const previews = useRef(new Map<string, string>())
  /** The frame must load a newer version: the elements changed, or a picture is missing. */
  const [stale, setStale] = useState(false)
  const [holding, setHolding] = useState(false)

  const ready = useCallback(() => {
    shown.current = null
    setLoads((count) => count + 1)
  }, [])

  // What the document holds now, as patches to what the frame shows.
  useEffect(() => {
    if (loads === 0 || stored === undefined || source === null) return

    const patches = boardFramePatches(shown.current ?? stored, source)
    if (patches === null) {
      setStale(true)
      return
    }

    const holds = (path: string) => shows.files.some((file) => file.path === path)
    const showable = showablePatches(patches, board.file, holds, previews.current)
    if (showable.waiting) setStale(true)
    shown.current = source
    if (showable.patches.length === 0) return

    handle.current?.send("edit.patch", { patches: showable.patches }).catch(() => {})
  }, [loads, stored, source, shows, board.file])

  // A stale frame loads the version the viewer has now once it is past the one it shows, and
  // while the reader is not typing in it.
  useEffect(() => {
    if (!stale || holding || version.revision <= pinned.revision) return
    setStale(false)
    setPinned(version)
  }, [stale, holding, version, pinned.revision])

  /** Loads the frame's page again, as what it shows can no longer be patched. */
  const resync = useCallback(() => {
    shown.current = null
    handle.current?.send("reload", {}).catch(() => {})
  }, [])

  return {
    shows,
    source,
    handle,
    loads,
    ready,
    resync,
    stale,
    previews: previews.current,
    hold: setHolding,
  }
}

/**
 * An opened board at its size on screen: its page in its frame, the picture under it until it is
 * ready, comments' pins over it, and, editing, the picked element's tools.
 */
export function BoardStage({
  version,
  board,
  title,
  scale,
  live,
  canvas,
  mode,
  pins,
  activePin,
  draft,
  fallback,
  failure,
  onPress,
  onPick,
  onOpenPin,
  onSubmitDraft,
  onCancelDraft,
}: {
  readonly version: ArtifactVersion
  readonly board: CanvasBoard
  readonly title: string
  readonly scale: number
  /** The canvas held live, whose document the board is patched from. */
  readonly live: LiveArtifact | null
  /** The live canvas the reader edits; null while they may not. */
  readonly canvas: BoardEditor | null
  readonly mode: StageMode
  readonly pins: readonly PinPlace[]
  readonly activePin: string | null
  readonly draft: DraftPlace | null
  readonly fallback?: ReactNode
  readonly failure?: ReactNode
  readonly onPress: (text: string) => void
  readonly onPick: (pick: CommentPick) => void
  readonly onOpenPin: (id: string) => void
  readonly onSubmitDraft: (body: string) => Promise<void>
  readonly onCancelDraft: () => void
}) {
  const messages = useArtifactMessages().canvas
  const frame = useBoardFrame({ version, board, live })
  const editing = mode === "edit" && canvas !== null
  const [selected, setSelected] = useState<FrameEditTarget | null>(null)
  // The element picked, as the event handler reads it: what the frame says the reader typed in is
  // taken only for it.
  const picked = useRef<FrameEditTarget | null>(null)
  picked.current = editing ? selected : null

  const { hold } = frame
  useEffect(() => {
    hold(editing && selected?.kind === "text")
  }, [hold, editing, selected])

  // Out of editing, nothing stays picked.
  useEffect(() => {
    if (!editing) setSelected(null)
  }, [editing])

  // The frame picks and types as the mode says, each time it loads.
  const send = frame.handle
  useEffect(() => {
    if (frame.loads === 0) return
    send.current?.send("edit", { on: mode !== "read", typing: editing }).catch(() => {})
  }, [frame.loads, mode, editing, send])

  const point = useCallback(
    (at: { readonly x: number; readonly y: number } | undefined, rect: FrameEditTarget["rect"]) => {
      const x = at?.x ?? rect.x + rect.width
      const y = at?.y ?? rect.y
      return {
        x: Math.min(1, Math.max(0, x / board.w)),
        y: Math.min(1, Math.max(0, y / board.h)),
      }
    },
    [board.w, board.h]
  )

  const onEvent = useCallback(
    (event: FrameEvent) => {
      switch (event.event) {
        case "ready":
          frame.ready()
          return
        case "press":
          onPress(event.params.text)
          return
        case "edit.select": {
          const { target, at } = event.params
          if (mode === "comment") {
            if (!target) return
            const element = target.address ?? target.within ?? undefined
            onPick({
              ...(element ? { element } : {}),
              ...(target.address && target.label ? { label: target.label } : {}),
              point: point(at, target.rect),
            })
            return
          }
          if (!editing) return
          picked.current = target
          setSelected(target)
          return
        }
        case "edit.text": {
          // The board's scripts can post this too: only the words of the element the reader
          // picked, a text, are taken.
          const chosen = picked.current
          const { address, base, text } = event.params
          if (!canvas || chosen?.kind !== "text" || chosen.address !== address) return

          try {
            canvas.editBoard(board.file, (source) => mergeBoardText(source, address, base, text))
          } catch {
            // The element is no longer text there: the board changed under the reader.
            setSelected(null)
            frame.resync()
          }
          return
        }
        default:
          return
      }
    },
    [frame, mode, editing, canvas, board.file, onPress, onPick, point]
  )

  return (
    <div className="relative size-full">
      <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: board.w, height: board.h, transform: `scale(${scale})` }}
        >
          <ArtifactFrame
            key={board.id}
            version={frame.shows}
            entry={board.file}
            title={messages.boardFrame(title)}
            className="size-full"
            editable
            handle={frame.handle}
            onEvent={onEvent}
            fallback={fallback}
            failure={failure}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0" data-board-overlay="">
        {pins.map((pin, index) => {
          const at = pinPoint(pin, pin.point ? 0 : index)
          return (
            <div
              key={pin.id}
              className="absolute"
              style={{ left: at.x * board.w * scale, top: at.y * board.h * scale }}
            >
              <CommentPin
                number={pin.number}
                label={pin.label}
                active={activePin === pin.id}
                resolved={pin.resolved}
                onClick={() => onOpenPin(pin.id)}
              />
            </div>
          )
        })}

        {draft ? (
          <div
            className="absolute"
            style={{ left: draft.point.x * board.w * scale, top: draft.point.y * board.h * scale }}
          >
            <CommentPin label={messages.comments.newPin} active resolved={false} draft />
            <div
              className={cn("absolute", draft.point.y > 0.6 ? "bottom-8" : "top-0")}
              style={cardPlace(draft.point.x * board.w * scale, board.w * scale)}
            >
              <DraftCard onSubmit={onSubmitDraft} onCancel={onCancelDraft} />
            </div>
          </div>
        ) : null}

        {editing && selected ? (
          <ElementTools
            key={selected.address ?? "scripted"}
            target={selected}
            scale={scale}
            board={board}
            version={version}
            live={live}
            canvas={canvas}
            source={frame.source}
            previews={frame.previews}
            onComment={() =>
              onPick({
                ...(selected.address !== null
                  ? { element: selected.address, label: selected.label }
                  : selected.within
                    ? { element: selected.within }
                    : {}),
                point: point(undefined, selected.rect),
              })
            }
          />
        ) : null}
      </div>

      {frame.stale ? (
        <span
          role="status"
          className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border"
        >
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          {messages.edit.updating}
        </span>
      ) : null}
    </div>
  )
}

/** The widest a new comment's card is, as `DraftCard` draws it. */
const CARD_WIDTH = 288

/**
 * Where a new comment's card sits from its pin, `x` along a stage `width` wide: beside the pin,
 * else as far left as it must to stay on the stage, and narrower on a stage narrower than it.
 */
function cardPlace(x: number, width: number): { left: number; width: number } {
  const card = Math.min(CARD_WIDTH, width - 16)
  const beside = 36
  const left = Math.max(8 - x, Math.min(beside, width - 8 - card - x))
  return { left, width: card }
}

/**
 * The picked element's tools, floating above it: what it is, its style, an image's picture, and a
 * comment on it. What a script built says so, and offers a comment.
 */
function ElementTools({
  target,
  scale,
  board,
  version,
  live,
  canvas,
  source,
  previews,
  onComment,
}: {
  readonly target: FrameEditTarget
  readonly scale: number
  readonly board: CanvasBoard
  readonly version: ArtifactVersion
  readonly live: LiveArtifact | null
  readonly canvas: BoardEditor
  readonly source: string | null
  readonly previews: Map<string, string>
  readonly onComment: () => void
}) {
  const messages = useArtifactMessages().canvas
  const rect = target.rect
  const left = Math.max(0, rect.x * scale)
  const above = rect.y * scale >= 44
  const top = above ? rect.y * scale - 40 : (rect.y + rect.height) * scale + 8

  return (
    <div
      role="toolbar"
      aria-label={messages.edit.tools}
      data-board-tools=""
      className="pointer-events-auto absolute flex max-w-[calc(100%-8px)] items-center gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-[0_1px_2px_rgb(0_0_0/0.08),0_10px_28px_-14px_rgb(0_0_0/0.35)] backdrop-blur motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
      style={{ left, top }}
    >
      {target.kind === "scripted" ? (
        <span className="flex min-w-0 items-center gap-2 px-2 text-xs">
          <Code2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0">
            <span className="font-medium text-foreground">{messages.edit.scripted}</span>
            <span className="text-muted-foreground"> · {messages.edit.scriptedHint}</span>
          </span>
        </span>
      ) : (
        <>
          <span className="max-w-40 truncate px-2 text-xs font-medium text-foreground">
            {messages.edit.element(messages.edit.kinds[target.kind], tagOf(target.address))}
          </span>
          <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
          {target.kind === "image" ? (
            <ImageTool
              address={target.address}
              board={board}
              version={version}
              live={live}
              canvas={canvas}
              source={source}
              previews={previews}
            />
          ) : null}
          <StyleTool
            address={target.address}
            words={target.kind === "text" || target.kind === "box"}
            board={board}
            canvas={canvas}
            source={source}
          />
        </>
      )}
      <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
      <ToolButton label={messages.toolbar.comment} onClick={onComment}>
        <MessageSquarePlus />
      </ToolButton>
    </div>
  )
}

/** The tag an address ends at: `h1` of `body>main:0>h1:0`. */
function tagOf(address: string): string {
  return address.split(">").at(-1)?.split(":")[0] ?? ""
}

function StyleTool({
  address,
  words,
  board,
  canvas,
  source,
}: {
  readonly address: string
  readonly words: boolean
  readonly board: CanvasBoard
  readonly canvas: BoardEditor
  readonly source: string | null
}) {
  const messages = useArtifactMessages().canvas.edit
  const style = useMemo(
    () => (source === null ? {} : boardInlineStyle(source, address)),
    [source, address]
  )

  const change = (properties: StyleChange): boolean => {
    try {
      canvas.stopCapturing()
      canvas.editBoard(board.file, (page) => setBoardStyle(page, address, properties))
      canvas.stopCapturing()
      return true
    } catch {
      return false
    }
  }

  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <ToolButton label={messages.style}>
          <Paintbrush />
        </ToolButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-auto p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <StylePanel style={style} words={words} onChange={change} />
      </PopoverContent>
    </Popover>
  )
}

function ImageTool({
  address,
  board,
  version,
  live,
  canvas,
  source,
  previews,
}: {
  readonly address: string
  readonly board: CanvasBoard
  readonly version: ArtifactVersion
  readonly live: LiveArtifact | null
  readonly canvas: BoardEditor
  readonly source: string | null
  readonly previews: Map<string, string>
}) {
  const messages = useArtifactMessages().canvas.edit
  const stored = useLiveStoredFiles(live)
  const [uploading, setUploading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const src = source === null ? null : boardAttribute(source, address, "src")
  const alt = source === null ? "" : (boardAttribute(source, address, "alt") ?? "")
  const current = src === null ? null : boardReferencePath(board.file, src)

  // The canvas's pictures: those the version holds, pictured, and those added since.
  const images = useMemo<CanvasImage[]>(() => {
    const listed = new Map<string, CanvasImage>()
    for (const file of version.files) {
      if (!IMAGE_EXTENSIONS.test(file.path)) continue
      const url = versionFileSource(version, file.path)?.inlineUrl
      listed.set(file.path, { path: file.path, ...(url ? { url } : {}) })
    }
    for (const path of stored.keys()) {
      if (IMAGE_EXTENSIONS.test(path) && !listed.has(path)) {
        const preview = previews.get(path)
        listed.set(path, { path, ...(preview ? { url: preview } : {}) })
      }
    }
    return [...listed.values()]
  }, [version, stored, previews])

  const show = (path: string, files: Readonly<Record<string, FileRef>>) => {
    canvas.stopCapturing()
    canvas.editBoard(
      board.file,
      (page) => setBoardImage(page, address, { src: boardFilePath(board.file, path) }),
      files
    )
    canvas.stopCapturing()
  }

  const upload = async (file: File) => {
    if (file.size > ARTIFACT_LIMITS.maxFileBytes) {
      setFailure(messages.tooLarge)
      return
    }
    setUploading(true)
    setFailure(null)
    try {
      const path = imagePath(board.file, file.name)
      const [ref, preview] = await Promise.all([
        uploadFile(file, { fileName: path.split("/").at(-1) ?? path }),
        // Without a preview, the picture shows once a version holds it.
        dataUrl(file).catch(() => null),
      ])
      if (preview) previews.set(path, preview)
      show(path, { [path]: ref })
    } catch {
      setFailure(messages.uploadFailed)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <ToolButton label={messages.replace}>
          <ImageIcon />
        </ToolButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-auto p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <ImagePanel
          current={current}
          alt={alt}
          images={images}
          uploading={uploading}
          failure={failure}
          onUpload={(file) => void upload(file)}
          onPick={(path) => show(path, {})}
          onAlt={(text) => {
            canvas.stopCapturing()
            canvas.editBoard(board.file, (page) => setBoardImage(page, address, { alt: text }))
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Where an uploaded picture goes: beside the board's page, in `images/`, under its own name made
 * safe and six random letters, so two uploads of one name never meet.
 */
export function imagePath(board: string, name: string): string {
  const folder = board.split("/").slice(0, -1)
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "png"
  const stem =
    name
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    String.fromCharCode(97 + (byte % 26))
  ).join("")
  return [...folder, "images", `${stem}-${suffix}.${extension}`].join("/")
}

/** A picture's bytes as a `data:` address, which the frame shows before a version holds it. */
async function dataUrl(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`
}

const TOOL =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:size-4"

/** A tool of the element's toolbar; a popover's trigger takes it as its own. */
const ToolButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { readonly label: string }
>(function ToolButton({ label, children, ...props }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} title={label} className={TOOL} {...props}>
      {children}
    </button>
  )
})
