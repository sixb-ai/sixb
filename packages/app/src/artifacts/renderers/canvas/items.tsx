import type {
  CanvasBoard,
  CanvasEmbed,
  CanvasNote,
  CanvasSection,
  CanvasShapeItem,
  CanvasText,
} from "@sixb/core/artifacts"
import { CANVAS_TEXT_PIXELS, canvasNoteFontSize, canvasShapeFontSize } from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import { Handle, type NodeProps, type NodeTypes, Position, useStoreApi } from "@xyflow/react"
import { AppWindow, ArrowUpRight, Link2, Maximize2 } from "lucide-react"
import { memo, type ReactNode, useSyncExternalStore } from "react"
import { useArtifactMessages } from "../../messages"
import { artifactChanged } from "../../queries"
import { ArtifactEmbed, ArtifactLink } from "../../references/references"
import { TONE_COLORS } from "../../tones"
import { ItemTile, LiveBoard, useLive, useLiveBoards } from "./board"
import { EditChrome, InPlaceText, useCanvasEditing } from "./editing"
import type { CanvasFlowNode } from "./layout"
import { boardPreviewSize, boardPreviewUrl } from "./previews"

/**
 * Every item's look on the board. Boards and embeds are pages and artifacts under their names,
 * live where the board shows them large enough; sections are headings; the rest draw as they are,
 * in the theme's colors. Each draws again only when its own node changes: a canvas holds up to a
 * thousand.
 */
export const CANVAS_NODE_TYPES: NodeTypes = {
  board: memo(BoardNode),
  section: memo(SectionNode),
  note: memo(NoteNode),
  text: memo(TextNode),
  shape: memo(ShapeNode),
  embed: memo(EmbedNode),
  point: memo(PointNode),
}

/** The ends an arrow attaches to. Arrows find their own sides, so these are never seen. */
function Ends() {
  return (
    <>
      <Handle type="source" position={Position.Top} isConnectable={false} className="!invisible" />
      <Handle type="target" position={Position.Top} isConnectable={false} className="!invisible" />
    </>
  )
}

/** The zoom below which names give way to the canvas: smaller, they could not be read. */
const NAMES_FROM_ZOOM = 0.35
/**
 * How far a name grows against the zoom to keep its size on screen: twice its size at most, which
 * fits the room the Agent's guide leaves above a board and under a section's heading.
 */
const MAX_NAME_SCALE = 2
/** How wide on screen an item is before its name is shown above it. */
const NAMED_FROM_WIDTH = 120

/**
 * The CSS variable names scale by, which the board sets on itself as it zooms, so no item draws
 * again for a frame of a zoom.
 */
export const NAME_SCALE = "--sixb-name-scale"

/** `scale` as the CSS variable gives it, 1 where nothing sets it. */
export const NAME_SCALE_VALUE = `var(${NAME_SCALE}, 1)`

/**
 * How much names grow against the zoom, as a design tool names its frames: their size on screen
 * from 100% down to half, then shrinking with the canvas.
 */
export function nameScale(zoom: number): number {
  return Math.min(MAX_NAME_SCALE, Math.max(1, 1 / zoom))
}

/**
 * Below this zoom, the board marks itself far (`data-far`): a tile waiting for its picture, a few
 * dozen pixels wide, stops breathing, which would repaint every such tile at each frame.
 */
export const FAR_BELOW_ZOOM = 0.2

/** What the board sets on itself as it zooms, so no item draws again for a frame of a zoom. */
export function zoomMarks(zoom: number): { readonly nameScale: string; readonly far: boolean } {
  // Rounded, so a zoom between the steps it can show changes nothing.
  return { nameScale: nameScale(zoom).toFixed(3), far: zoom < FAR_BELOW_ZOOM }
}

/** Where React Flow's view is zoomed, and whether it waits to be fitted. */
export interface Zoom {
  readonly zoom: number
  readonly fitViewQueued: boolean
}

/** What of React Flow's store the zoom is read from. */
interface ZoomSource {
  getState(): {
    readonly transform: readonly [number, number, number]
    readonly fitViewQueued: boolean
  }
  subscribe(listener: () => void): () => void
}

const zooms = new WeakMap<
  ZoomSource,
  { readonly get: () => Zoom; readonly subscribe: (listener: () => void) => () => void }
>()

/**
 * The zoom of a React Flow store, told to its listeners only as it changes: the store changes for
 * every node someone moves, and an item that asks only how far the view is zoomed is not asked
 * again for each. One subscription to the store, while anyone listens.
 */
export function zoomOf(source: ZoomSource) {
  let entry = zooms.get(source)
  if (entry) return entry

  const read = (): Zoom => {
    const { transform, fitViewQueued } = source.getState()
    return { zoom: transform[2], fitViewQueued }
  }
  let current = read()
  const listeners = new Set<() => void>()
  let unsubscribe: (() => void) | null = null

  entry = {
    // Nobody listening, nothing keeps it up to date: it is read as it is asked for.
    get: () => {
      if (!unsubscribe) current = same(current, read())
      return current
    },
    subscribe: (listener) => {
      listeners.add(listener)
      unsubscribe ??= source.subscribe(() => {
        const next = same(current, read())
        if (next === current) return
        current = next
        for (const each of listeners) each()
      })
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || !unsubscribe) return
        unsubscribe()
        unsubscribe = null
      }
    },
  }
  zooms.set(source, entry)
  return entry
}

function same(last: Zoom, next: Zoom): Zoom {
  return last.zoom === next.zoom && last.fitViewQueued === next.fitViewQueued ? last : next
}

/** What an item reads of the zoom, read again only as the zoom changes. */
function useZoomed<T>(select: (zoom: Zoom) => T): T {
  const zoom = zoomOf(useStoreApi())
  return useSyncExternalStore(zoom.subscribe, () => select(zoom.get()))
}

/** Whether names show at all: zoomed out further, they give way to the canvas. */
export function useNamesShown(): boolean {
  return useZoomed(({ zoom }) => zoom >= NAMES_FROM_ZOOM)
}

/** Whether an item is wide enough on screen to show its name above it. */
function useNamed(width: number): boolean {
  return useZoomed(({ zoom }) => width * zoom >= NAMED_FROM_WIDTH)
}

/**
 * The row above a board or an embed: its icon and name, ending in an ellipsis before the item's
 * right edge, where its action sits.
 */
function NameRow({
  width,
  icon,
  name,
  action,
}: {
  /** The named item's width, in canvas pixels. */
  readonly width: number
  readonly icon: ReactNode
  readonly name: string
  readonly action?: ReactNode
}) {
  return (
    <div
      className="pointer-events-none absolute bottom-full left-0 flex h-7 origin-bottom-left items-center gap-1.5 pb-1.5 text-[13px] font-medium text-muted-foreground"
      style={{
        width: `calc(${width}px / ${NAME_SCALE_VALUE})`,
        transform: `scale(${NAME_SCALE_VALUE})`,
      }}
    >
      <span className="shrink-0 [&>svg]:size-3.5" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {action}
    </div>
  )
}

function itemOf<Item>(props: NodeProps<CanvasFlowNode>): Item {
  return props.data.item as Item
}

/**
 * A screen of the canvas: its page, live where the board shows it large enough, under its name
 * and the button that opens it.
 */
function BoardNode(props: NodeProps<CanvasFlowNode>) {
  const board = itemOf<CanvasBoard>(props)
  const messages = useArtifactMessages().canvas
  const { version, previews, mode, open } = useLiveBoards()
  const queries = useQueryClient()
  // Until the view is fitted it is at 100%, which is not where the reader sees the board: the
  // small picture first, then the full one if the board is drawn large.
  const previewSize = useZoomed(({ zoom, fitViewQueued }) =>
    fitViewQueued ? "small" : boardPreviewSize(board.w * zoom, window.devicePixelRatio || 1)
  )
  const shown = useNamesShown()
  const named = useNamed(board.w)
  const title = board.title ?? board.id
  return (
    <div className="relative size-full">
      <Ends />
      <EditChrome id={board.id} selected={props.selected} />
      {shown && named ? (
        <NameRow
          width={board.w}
          icon={<AppWindow />}
          name={title}
          action={
            open ? (
              <button
                type="button"
                // React Flow leaves a press on it to the button: no pan, no drag.
                className="nodrag nopan pointer-events-auto -my-1 flex size-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={messages.openBoard(title)}
                title={messages.openBoard(title)}
                onClick={() => open(board.id)}
              >
                <Maximize2 className="size-3.5" aria-hidden="true" />
              </button>
            ) : null
          }
        />
      ) : null}
      <div className="sixb-canvas-surface size-full overflow-hidden">
        <LiveBoard
          id={board.id}
          file={board.file}
          title={title}
          tile={
            <ItemTile
              icon={AppWindow}
              {...(version && previews[board.id] === "ready"
                ? {
                    preview: boardPreviewUrl(version, board.id, mode, previewSize),
                    // A small picture that can't be had gives way to the full one.
                    ...(previewSize === "small"
                      ? { fallback: boardPreviewUrl(version, board.id, mode) }
                      : {}),
                  }
                : {})}
              pending={previews[board.id] === "pending"}
              // The version may have moved past the revision pictured: it is read again.
              {...(version ? { onFail: () => artifactChanged(queries, version.artifactId) } : {})}
            />
          }
        />
      </div>
    </div>
  )
}

/**
 * A heading over the items it groups, at the top left of its region: the region itself is not
 * drawn, but it is what an address to the section frames.
 */
function SectionNode(props: NodeProps<CanvasFlowNode>) {
  const section = itemOf<CanvasSection>(props)
  const shown = useNamesShown()
  const editing = useCanvasEditing()
  const heading =
    "absolute top-0 left-0 m-0 origin-top-left text-base leading-6 font-semibold tracking-[-0.01em] text-foreground"
  return (
    <div className="relative size-full">
      <Ends />
      <EditChrome id={section.id} selected={props.selected} />
      {editing?.typing === section.id ? (
        <div className={cn(heading, "pointer-events-auto")} style={{ width: section.w }}>
          <InPlaceText id={section.id} value={section.title ?? ""} />
        </div>
      ) : section.title && shown ? (
        // While the canvas is edited, the heading is what takes the section: a press anywhere
        // else in its region falls through to what the region holds, or pans.
        <h3
          className={cn(
            heading,
            "truncate",
            editing ? "pointer-events-auto cursor-grab" : "pointer-events-none"
          )}
          style={{
            maxWidth: `calc(${section.w}px / ${NAME_SCALE_VALUE})`,
            transform: `scale(${NAME_SCALE_VALUE})`,
          }}
        >
          {section.title}
        </h3>
      ) : null}
    </div>
  )
}

/**
 * A sticky note in its tone: amber, as a note pad's, when it names none, and plain paper when it
 * is neutral. Its height grows to hold its text.
 */
function NoteNode(props: NodeProps<CanvasFlowNode>) {
  const note = itemOf<CanvasNote>(props)
  const tone = note.tone ?? "warning"
  const editing = useCanvasEditing()
  return (
    <div
      className={cn(
        "relative rounded-[4px] px-[1em] py-[0.85em] leading-[1.4] font-medium whitespace-pre-wrap text-foreground",
        tone === "neutral"
          ? "sixb-canvas-surface"
          : "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_10px_24px_-14px_rgb(0_0_0/0.28)]"
      )}
      style={{
        width: "100%",
        // As tall as its box while it is resized, and never shorter than its height.
        minHeight: `max(${note.h ?? Math.min(note.w, 112)}px, 100%)`,
        fontSize: canvasNoteFontSize(note.w),
        ...(tone === "neutral"
          ? {}
          : { backgroundColor: `color-mix(in oklab, ${TONE_COLORS[tone]} 20%, var(--card))` }),
      }}
    >
      <Ends />
      <EditChrome id={note.id} selected={props.selected} />
      {editing?.typing === note.id ? (
        <InPlaceText
          id={note.id}
          value={note.text}
          multiline
          className="leading-[1.4] font-medium"
        />
      ) : (
        note.text
      )}
    </div>
  )
}

/** A label or a heading on the canvas itself. */
function TextNode(props: NodeProps<CanvasFlowNode>) {
  const text = itemOf<CanvasText>(props)
  const size = CANVAS_TEXT_PIXELS[text.size]
  const editing = useCanvasEditing()
  return (
    <div
      className={cn(
        "relative whitespace-pre-wrap text-foreground",
        (text.size === "xl" || text.size === "xxl") && "font-bold tracking-[-0.025em]",
        text.size === "l" && "font-semibold tracking-[-0.015em]",
        text.size === "s" && "text-muted-foreground"
      )}
      style={{
        fontSize: size,
        lineHeight: text.size === "s" || text.size === "m" ? 1.45 : 1.15,
        ...(text.w === undefined ? { width: "max-content", minWidth: "100%" } : { width: "100%" }),
      }}
    >
      <Ends />
      <EditChrome id={text.id} selected={props.selected} />
      {editing?.typing === text.id ? (
        <InPlaceText id={text.id} value={text.text} multiline className="min-w-[8ch]" />
      ) : (
        text.text
      )}
    </div>
  )
}

/** A rectangle, ellipse, or diamond with its text in the middle. */
function ShapeNode(props: NodeProps<CanvasFlowNode>) {
  const shape = itemOf<CanvasShapeItem>(props)
  const fill = shape.tone
    ? `color-mix(in oklab, ${TONE_COLORS[shape.tone]} 16%, var(--card))`
    : "var(--card)"
  const stroke = "color-mix(in oklab, var(--foreground) 32%, transparent)"
  const editing = useCanvasEditing()
  const fontSize = canvasShapeFontSize(shape.w, shape.h)
  const textBox = cn(
    "relative text-center leading-snug font-medium text-foreground",
    // A diamond's middle is narrower than its box.
    shape.shape === "diamond" ? "max-w-[60%]" : "max-w-[80%]"
  )
  return (
    <div className="relative flex size-full items-center justify-center">
      <Ends />
      <EditChrome id={shape.id} selected={props.selected} />
      <svg
        viewBox={`0 0 ${shape.w} ${shape.h}`}
        className="absolute inset-0 size-full overflow-visible"
        aria-hidden="true"
      >
        {shape.shape === "ellipse" ? (
          <ellipse
            cx={shape.w / 2}
            cy={shape.h / 2}
            rx={shape.w / 2}
            ry={shape.h / 2}
            style={{ fill, stroke }}
            strokeWidth={1.5}
          />
        ) : shape.shape === "diamond" ? (
          <polygon
            points={`${shape.w / 2},0 ${shape.w},${shape.h / 2} ${shape.w / 2},${shape.h} 0,${shape.h / 2}`}
            style={{ fill, stroke }}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ) : (
          <rect
            width={shape.w}
            height={shape.h}
            rx={10}
            style={{ fill, stroke }}
            strokeWidth={1.5}
          />
        )}
      </svg>
      {editing?.typing === shape.id ? (
        <div className={cn(textBox, "w-full")} style={{ fontSize }}>
          <InPlaceText id={shape.id} value={shape.text ?? ""} className="text-center" />
        </div>
      ) : shape.text ? (
        // A larger shape is read from further out, as a note is.
        <span className={textBox} style={{ fontSize }}>
          {shape.text}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Another artifact on the canvas at the item's size, as a deck's box shows one: a chart, a range,
 * a slide, a section, a page's card, or another canvas's board. It shows once the view shows it
 * large enough, as a board runs, and its tile until then. One the reader can't open, or whose part
 * is gone, says so in place.
 */
function EmbedNode(props: NodeProps<CanvasFlowNode>) {
  const embed = itemOf<CanvasEmbed>(props)
  const messages = useArtifactMessages().canvas
  const live = useLive(embed.id)
  const shown = useNamesShown()
  const named = useNamed(embed.w) && shown && Boolean(embed.title)
  return (
    <div className="relative size-full">
      <Ends />
      <EditChrome id={embed.id} selected={props.selected} />
      {named && embed.title ? (
        <NameRow
          width={embed.w}
          icon={<Link2 />}
          name={embed.title}
          action={
            <ArtifactLink
              address={embed.src}
              className="nodrag nopan pointer-events-auto -my-1 flex size-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
              <span className="sr-only">{messages.open}</span>
            </ArtifactLink>
          }
        />
      ) : null}
      {/* Named, its link is in the row above; the embed's own gives way. */}
      <div
        className="sixb-canvas-surface sixb-canvas-embed size-full overflow-hidden"
        {...(named ? { "data-named": "" } : {})}
      >
        {live ? (
          <ArtifactEmbed address={embed.src} caption={embed.title ?? ""} fill />
        ) : (
          <ItemTile icon={Link2} />
        )}
      </div>
    </div>
  )
}

/** An arrow's end at a bare point. */
function PointNode() {
  return (
    <div className="size-px">
      <Ends />
    </div>
  )
}
