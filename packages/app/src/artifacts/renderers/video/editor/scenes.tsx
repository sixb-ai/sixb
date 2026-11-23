import type { ArtifactLiveUser, VideoFileTimeline, VideoScene } from "@sixb/core/artifacts/live"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowLeft, ArrowRight, Copy, Ellipsis, Pencil, Sparkles, Trash2 } from "lucide-react"
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react"
import { videoStillUrl } from "../../../file-source"
import { useArtifactMessages } from "../../../messages"
import { useSize } from "../player"
import { type MediaTarget, useMediaParts } from "./media"
import { sceneFootage, sceneName } from "./selection"

// A scene on the timeline's Chapters bar, where the person reads it as a chapter: its name and its
// length along the time it plays, quiet beside the tracks; too short for its name, its number, the
// name in a tooltip. The chapter under the playhead is underlined, the one selected outlined. It is
// dragged along the bar to reorder, its end to make it longer or shorter, double-clicked to rename,
// and its menu, or a right click, duplicates, moves or deletes it. The chapter the Agent is
// changing glows as a canvas's boards do; the people on the video show on the one they have open.

export interface SceneActions {
  readonly select: (scene: VideoScene) => void
  readonly move: (scene: VideoScene, to: number) => void
  readonly duplicate: (scene: VideoScene) => void
  readonly remove: (scene: VideoScene) => void
  readonly rename: (scene: VideoScene, label: string) => void
}

/** What a block its bar already sizes observes: nothing. */
const UNMEASURED: RefObject<HTMLDivElement | null> = { current: null }

/**
 * The narrowest a chapter shows its name with room for its menu, in pixels; narrower, its name
 * alone, cut short, its menu on a right click and the whole name in a tooltip; narrower than a few
 * letters, its number; narrower than its number, nothing but its edge, so no text ever runs into
 * the next chapter's.
 */
const NAME_FROM_PX = 72
const NUMBER_BELOW_PX = 36
const NUMBER_FROM_PX = 18

export function SceneBlock({
  scene,
  index,
  count,
  open,
  playing,
  agent,
  people,
  dragging,
  length,
  actions,
  onPress,
  width: drawn,
  children,
}: {
  readonly scene: VideoScene
  readonly index: number
  /** How many scenes the video has. */
  readonly count: number
  /** Whether it is the chapter selected. */
  readonly open: boolean
  /** Whether the playhead is in it. */
  readonly playing: boolean
  readonly agent: boolean
  /** Who else has it open. */
  readonly people: readonly ArtifactLiveUser[]
  readonly dragging: boolean
  readonly length: string
  readonly actions: SceneActions
  /** A press on it, which a drag reorders and a tap opens. */
  readonly onPress: (event: ReactPointerEvent) => void
  /** How wide it is drawn, in pixels, when its bar knows: else it is measured once laid out. */
  readonly width?: number
  /** What lies over it: the handle that drags its end. */
  readonly children?: React.ReactNode
}) {
  const messages = useArtifactMessages().videoEditor
  const name = sceneName(scene)
  const [renaming, setRenaming] = useState(false)
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  // Only a block its bar doesn't size measures itself: a bar of fifty chapters observes none.
  const measured = useSize(drawn === undefined ? box : UNMEASURED).width
  const width = drawn ?? measured
  // Until it is measured, it is laid out as a chapter with room for its name.
  const bare = width > 0 && width < NUMBER_FROM_PX
  const narrow = width > 0 && width < NUMBER_BELOW_PX
  const compact = width > 0 && width < NAME_FROM_PX

  const block = (
    <button
      type="button"
      aria-pressed={open}
      aria-current={playing ? "true" : undefined}
      aria-label={messages.sceneLabel(index + 1, name, length)}
      title={compact ? undefined : agent ? messages.agentEditing : messages.sceneHint}
      className={cn(
        "absolute inset-0 flex touch-none items-center gap-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        narrow ? "justify-center p-0" : compact ? "px-1.5" : "pr-8 pl-2"
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || renaming) return
        event.stopPropagation()
        onPress(event)
      }}
      // A press opens it as it lifts; Enter or Space, which press no pointer, open it here.
      onClick={(event) => {
        if (event.detail === 0) actions.select(scene)
      }}
      onDoubleClick={() => setRenaming(true)}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu(true)
      }}
      onKeyDown={(event) => {
        if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
        event.preventDefault()
        event.stopPropagation()
        actions.move(scene, index + (event.key === "ArrowLeft" ? -1 : 1))
      }}
    >
      {bare ? null : narrow ? (
        <span
          aria-hidden="true"
          className="text-[10px] font-semibold text-muted-foreground tabular-nums"
        >
          {renaming ? null : index + 1}
        </span>
      ) : renaming ? null : (
        <>
          {agent && !compact ? (
            <Sparkles className="size-3 shrink-0 text-primary" aria-hidden="true" />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate text-[11px] leading-none font-medium",
              open || playing ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {name}
          </span>
          {compact ? null : (
            <span className="shrink-0 text-[10px] leading-none text-muted-foreground/75 tabular-nums @max-[8rem]/chapter:hidden">
              {length}
            </span>
          )}
        </>
      )}
    </button>
  )

  return (
    <div
      ref={box}
      className={cn(
        "group/sceneblock @container/chapter absolute inset-0 overflow-hidden rounded-[5px] text-left transition-[opacity,background-color]",
        open
          ? "bg-[color-mix(in_oklab,var(--primary)_13%,var(--background))] ring-1 ring-primary/55 ring-inset"
          : "bg-muted/60 hover:bg-muted",
        agent && "sixb-agent-board",
        dragging && "opacity-40"
      )}
    >
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>{block}</TooltipTrigger>
          <TooltipContent>
            <span className="font-medium">{messages.sceneTitle(index + 1, name)}</span>
            <span className="text-background/70 tabular-nums"> · {length}</span>
            {agent ? (
              <span className="block text-background/70">{messages.agentEditing}</span>
            ) : null}
          </TooltipContent>
        </Tooltip>
      ) : (
        block
      )}

      {/* The chapter under the playhead, underlined. */}
      {playing ? (
        <span
          aria-hidden="true"
          data-chapter-playing=""
          className="pointer-events-none absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-primary/70"
        />
      ) : null}

      {renaming ? (
        <div className="absolute inset-y-0 right-7 left-1 z-10 flex items-center">
          <RenameField
            name={scene.label ?? ""}
            placeholder={scene.id}
            onDone={(label) => {
              setRenaming(false)
              if (label !== null) actions.rename(scene, label)
            }}
          />
        </div>
      ) : null}

      {people.length > 0 && !compact ? (
        <span className="pointer-events-none absolute top-1/2 right-7 flex -translate-y-1/2 -space-x-1">
          {people.slice(0, 3).map((person) => (
            <span
              key={person.id}
              title={messages.peerSelected(person.name)}
              className="grid size-4 place-items-center rounded-full text-[9px] font-semibold text-white ring-2 ring-background"
              style={{ background: person.color }}
            >
              {(person.name || "?").slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
      ) : null}

      {/* Too narrow for its name and its menu, a chapter keeps the menu for a right click. */}
      <div
        className={cn(
          "absolute top-1/2 right-2 z-10 -translate-y-1/2 transition-opacity",
          menu || (open && !compact)
            ? "opacity-100"
            : compact
              ? "pointer-events-none opacity-0"
              : "opacity-0 group-focus-within/sceneblock:opacity-100 group-hover/sceneblock:opacity-100"
        )}
      >
        <SceneMenu
          name={name}
          open={menu}
          onOpenChange={setMenu}
          renaming={renaming}
          first={index === 0}
          last={index === count - 1}
          only={count === 1}
          onRename={() => setRenaming(true)}
          onDuplicate={() => actions.duplicate(scene)}
          onMove={(by) => actions.move(scene, index + by)}
          onDelete={() => actions.remove(scene)}
        />
      </div>

      {children}
    </div>
  )
}

/** Where a chapter dragged along the bar lands: a line at the edge it would take. */
export function SceneDropMark({ left }: { readonly left: number }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0.5 z-20 w-0.5 -translate-x-1/2 rounded-full bg-primary"
      style={{ left: Math.max(2, left) }}
    />
  )
}

function SceneMenu({
  name,
  open,
  onOpenChange,
  renaming,
  first,
  last,
  only,
  onRename,
  onDuplicate,
  onMove,
  onDelete,
}: {
  readonly name: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Its name is being typed: the menu, closing, leaves the focus there. */
  readonly renaming: boolean
  readonly first: boolean
  readonly last: boolean
  readonly only: boolean
  readonly onRename: () => void
  readonly onDuplicate: () => void
  readonly onMove: (by: -1 | 1) => void
  readonly onDelete: () => void
}) {
  const messages = useArtifactMessages().videoEditor
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={messages.sceneOptions(name)}
          onPointerDown={(event) => event.stopPropagation()}
          className="grid size-5 place-items-center rounded text-muted-foreground outline-none hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Ellipsis className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        onCloseAutoFocus={(event) => {
          if (renaming) event.preventDefault()
        }}
      >
        <DropdownMenuItem onSelect={onRename}>
          <Pencil />
          {messages.rename}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDuplicate}>
          <Copy />
          {messages.duplicate}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
          <ArrowLeft />
          {messages.moveEarlier}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
          <ArrowRight />
          {messages.moveLater}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={only} onSelect={onDelete}>
          <Trash2 />
          {messages.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Types a chapter's new name: Enter keeps it, Escape or leaving with nothing changed drops it. */
export function RenameField({
  name,
  placeholder,
  onDone,
}: {
  readonly name: string
  readonly placeholder: string
  readonly onDone: (label: string | null) => void
}) {
  const field = useRef<HTMLInputElement | null>(null)
  const done = useRef(false)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  // The name it opened on: left as it was, it writes nothing, even when someone else renamed the
  // scene meanwhile.
  const from = useRef(name)
  const finish = (label: string | null) => {
    if (done.current) return
    done.current = true
    onDone(label === from.current ? null : label)
  }

  return (
    <input
      ref={field}
      defaultValue={name}
      placeholder={placeholder}
      aria-label={useArtifactMessages().videoEditor.name}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Enter") finish(event.currentTarget.value)
        if (event.key === "Escape") finish(null)
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      className="h-[1.375rem] min-w-0 flex-1 rounded-[4px] border border-input bg-background px-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

/**
 * A picture of a scene's middle: the still the export snapshots, else the frame of its footage
 * at that moment from the filmstrip, else its number on the video's shade.
 */
export function SceneThumbnail({
  scene,
  timeline,
  target,
}: {
  readonly scene: VideoScene
  readonly timeline: VideoFileTimeline | undefined
  readonly target: MediaTarget
}) {
  const still = videoStillUrl(target, scene.id)
  // Each address is tried once: a scene renamed or another version tries again.
  const [tried, setTried] = useState<{
    readonly url: string
    readonly shown: "still" | "fallback"
  } | null>(null)
  const shown = tried?.url === still ? tried.shown : "loading"
  const setShown = (next: "still" | "fallback") => setTried({ url: still, shown: next })

  const footage = sceneFootage(timeline)
  const parts = useMediaParts(shown === "fallback" ? target : null, footage?.src)
  const middle = scene.durationMs / 2
  const at = footage
    ? footage.mediaStartMs +
      Math.max(0, Math.min(middle - footage.startMs, (footage.durationMs ?? middle) - 1))
    : 0

  return (
    <span className="relative block aspect-video w-full overflow-hidden bg-neutral-900">
      {shown !== "fallback" ? (
        <img
          src={still}
          alt=""
          draggable={false}
          onLoad={() => setShown("still")}
          onError={() => setShown("fallback")}
          className={cn(
            "sixb-media-in absolute inset-0 size-full object-cover",
            shown === "still" ? "opacity-100" : "opacity-0"
          )}
        />
      ) : parts.filmstrip ? (
        <FilmstripFrame filmstrip={parts.filmstrip} atMs={at} className="absolute inset-0" />
      ) : (
        // No picture yet: the scene's first words, on the video's shade.
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center bg-gradient-to-br from-neutral-800 to-neutral-950 px-3 text-center"
        >
          <span className="line-clamp-2 text-[11px] leading-tight font-semibold text-white/70">
            {timeline?.texts[0]?.text ?? ""}
          </span>
        </span>
      )}
    </span>
  )
}

/** One thumbnail of a filmstrip, the one at `atMs` into its recording, covering its box. */
export function FilmstripFrame({
  filmstrip,
  atMs,
  className,
}: {
  readonly filmstrip: {
    readonly url: string
    readonly intervalMs: number
    readonly count: number
    readonly columns: number
    readonly width: number
    readonly height: number
  }
  readonly atMs: number
  readonly className?: string
}) {
  const index = Math.min(filmstrip.count - 1, Math.max(0, Math.floor(atMs / filmstrip.intervalMs)))
  const column = index % filmstrip.columns
  const row = Math.floor(index / filmstrip.columns)
  const rows = Math.ceil(filmstrip.count / filmstrip.columns)
  return (
    <span
      aria-hidden="true"
      className={cn("block bg-neutral-900", className)}
      style={{
        backgroundImage: `url("${filmstrip.url}")`,
        backgroundSize: `${filmstrip.columns * 100}% ${rows * 100}%`,
        backgroundPosition: `${filmstrip.columns > 1 ? (column / (filmstrip.columns - 1)) * 100 : 0}% ${rows > 1 ? (row / (rows - 1)) * 100 : 0}%`,
      }}
    />
  )
}
