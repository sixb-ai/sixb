import type {
  CanvasBoard,
  CanvasEmbed,
  CanvasNote,
  CanvasSection,
  CanvasShapeItem,
  CanvasText,
} from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { Handle, type NodeProps, type NodeTypes, Position, useStore } from "@xyflow/react"
import { AppWindow, Link2, Maximize2 } from "lucide-react"
import type { ReactNode } from "react"
import { useArtifactMessages } from "../../messages"
import { TONE_COLORS } from "../../tones"
import { LiveBoard, useLiveBoards } from "./board"
import { type CanvasFlowNode, TEXT_SIZES } from "./layout"

/**
 * Every item's look on the board. Boards are pages under their names, live where the board shows
 * them, and embeds outlines; sections are headings; the rest draw as they are, in the theme's
 * colors.
 */
export const CANVAS_NODE_TYPES: NodeTypes = {
  board: BoardNode,
  section: SectionNode,
  note: NoteNode,
  text: TextNode,
  shape: ShapeNode,
  embed: EmbedNode,
  point: PointNode,
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
 * How much names grow against the zoom, as a design tool names its frames: their size on screen
 * from 100% down to half, then shrinking with the canvas, then gone. Null when they are hidden.
 */
export function useNameScale(): number | null {
  return useStore((state) => {
    const zoom = state.transform[2]
    if (zoom < NAMES_FROM_ZOOM) return null
    return Math.min(MAX_NAME_SCALE, Math.max(1, 1 / zoom))
  })
}

/** Whether an item is wide enough on screen to show its name above it. */
function useNamed(width: number): boolean {
  return useStore((state) => width * state.transform[2] >= NAMED_FROM_WIDTH)
}

/**
 * The row above a board or an embed: its icon and name, ending in an ellipsis before the item's
 * right edge, where an action can sit.
 */
function NameRow({
  width,
  scale,
  icon,
  name,
  action,
}: {
  /** The named item's width, in canvas pixels. */
  readonly width: number
  readonly scale: number
  readonly icon: ReactNode
  readonly name: string
  readonly action?: ReactNode
}) {
  return (
    <div
      className="pointer-events-none absolute bottom-full left-0 flex h-7 origin-bottom-left items-center gap-1.5 pb-1.5 text-[13px] font-medium text-muted-foreground"
      style={{ width: width / scale, transform: `scale(${scale})` }}
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
  const { open } = useLiveBoards()
  const scale = useNameScale()
  const named = useNamed(board.w)
  const title = board.title ?? board.id
  // Until the page runs, its outline: the name above says which it is.
  const tile = (
    <div className="flex size-full items-center justify-center bg-card">
      <AppWindow className="size-12 text-muted-foreground/30" strokeWidth={1} aria-hidden="true" />
    </div>
  )
  return (
    <div className="relative size-full">
      <Ends />
      {scale && named ? (
        <NameRow
          width={board.w}
          scale={scale}
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
        <LiveBoard id={board.id} file={board.file} title={title} tile={tile} />
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
  const scale = useNameScale()
  return (
    <div className="relative size-full">
      <Ends />
      {section.title && scale ? (
        <h3
          className="pointer-events-none absolute top-0 left-0 m-0 origin-top-left truncate text-base leading-6 font-semibold tracking-[-0.01em] text-foreground"
          style={{ maxWidth: section.w / scale, transform: `scale(${scale})` }}
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
  return (
    <div
      className={cn(
        "relative rounded-[4px] px-[1em] py-[0.85em] leading-[1.4] font-medium whitespace-pre-wrap text-foreground",
        tone === "neutral"
          ? "sixb-canvas-surface"
          : "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_10px_24px_-14px_rgb(0_0_0/0.28)]"
      )}
      style={{
        width: note.w,
        minHeight: note.h ?? Math.min(note.w, 112),
        // A wide note is read from further out, so its text is a little larger: never so large
        // that a few words fill it.
        fontSize: Math.round(Math.min(22, Math.max(15, note.w / 13))),
        ...(tone === "neutral"
          ? {}
          : { backgroundColor: `color-mix(in oklab, ${TONE_COLORS[tone]} 20%, var(--card))` }),
      }}
    >
      <Ends />
      {note.text}
    </div>
  )
}

/** A label or a heading on the canvas itself. */
function TextNode(props: NodeProps<CanvasFlowNode>) {
  const text = itemOf<CanvasText>(props)
  const size = TEXT_SIZES[text.size]
  return (
    <div
      className={cn(
        "relative whitespace-pre-wrap text-foreground",
        text.size === "xl" && "font-bold tracking-[-0.025em]",
        text.size === "l" && "font-semibold tracking-[-0.015em]",
        text.size === "s" && "text-muted-foreground"
      )}
      style={{
        fontSize: size,
        lineHeight: text.size === "xl" || text.size === "l" ? 1.15 : 1.45,
        ...(text.w === undefined ? { width: "max-content" } : { width: text.w }),
      }}
    >
      <Ends />
      {text.text}
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
  return (
    <div className="relative flex size-full items-center justify-center">
      <Ends />
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
      {shape.text ? (
        <span
          className={cn(
            "relative text-center leading-snug font-medium text-foreground",
            // A diamond's middle is narrower than its box.
            shape.shape === "diamond" ? "max-w-[60%]" : "max-w-[80%]"
          )}
          // A larger shape is read from further out, as a note is.
          style={{
            fontSize: Math.round(Math.min(22, Math.max(15, Math.min(shape.w, shape.h * 2) / 12))),
          }}
        >
          {shape.text}
        </span>
      ) : null}
    </div>
  )
}

/** Another artifact on the canvas, as its outline under its name until it draws there. */
function EmbedNode(props: NodeProps<CanvasFlowNode>) {
  const embed = itemOf<CanvasEmbed>(props)
  const messages = useArtifactMessages().canvas
  const scale = useNameScale()
  const named = useNamed(embed.w)
  return (
    <div className="relative size-full">
      <Ends />
      {embed.title && scale && named ? (
        <NameRow width={embed.w} scale={scale} icon={<Link2 />} name={embed.title} />
      ) : null}
      <div className="flex size-full flex-col items-center justify-center gap-2 rounded-[6px] border border-dashed border-border bg-card/60 text-muted-foreground">
        <Link2 className="size-6 opacity-50" aria-hidden="true" />
        <span className="text-sm">{embed.title ?? messages.embed}</span>
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
