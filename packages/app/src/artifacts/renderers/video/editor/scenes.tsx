import type {
  ArtifactLiveUser,
  VideoComposition,
  VideoFileTimeline,
  VideoScene,
} from "@sixb/core/artifacts/live"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowLeft, ArrowRight, Copy, Ellipsis, Pencil, Sparkles, Trash2 } from "lucide-react"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react"
import { useArtifactMessages } from "../../../messages"
import { type MediaTarget, sceneStillUrl, useMediaParts } from "./media"
import { useReorder } from "./reorder"
import { sceneFootage, sceneName } from "./selection"

// The video's scenes as a row of cards, in play order: each a picture of its middle, its name and
// its length. A card is dragged to reorder, and its menu renames, duplicates, moves or deletes it.
// The scene the Agent is changing glows as a canvas's boards do; the people on the video show on
// the scene they have open.

export interface SceneActions {
  readonly select: (scene: VideoScene) => void
  readonly move: (scene: VideoScene, to: number) => void
  readonly duplicate: (scene: VideoScene) => void
  readonly remove: (scene: VideoScene) => void
  readonly rename: (scene: VideoScene, label: string) => void
}

export function ScenesStrip({
  composition,
  timelines,
  target,
  selected,
  playing,
  agentScenes,
  people,
  actions,
  formatLength,
}: {
  readonly composition: VideoComposition
  readonly timelines: ReadonlyMap<string, VideoFileTimeline>
  readonly target: MediaTarget
  /** The scene open on the timeline. */
  readonly selected: string | undefined
  /** The scene under the playhead. */
  readonly playing: string | undefined
  readonly agentScenes: ReadonlySet<string>
  /** Who else has each scene open, by its id. */
  readonly people: ReadonlyMap<string, readonly ArtifactLiveUser[]>
  readonly actions: SceneActions
  readonly formatLength: (ms: number) => string
}) {
  const messages = useArtifactMessages().videoEditor
  const list = useRef<HTMLOListElement | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const { scenes } = composition
  const { drag, start } = useReorder({
    items: () => [...(list.current?.querySelectorAll<HTMLElement>("[data-reorder-id]") ?? [])],
    axis: "x",
    onMove: (id, _from, to) => {
      const scene = scenes.find((each) => each.id === id)
      if (scene) actions.move(scene, to)
    },
  })

  const onKeyDown = (event: ReactKeyboardEvent, scene: VideoScene, index: number) => {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
    event.preventDefault()
    actions.move(scene, index + (event.key === "ArrowLeft" ? -1 : 1))
  }

  return (
    <section aria-label={messages.scenes} className="relative min-w-0">
      <ol
        ref={list}
        className="m-0 flex list-none gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:thin]"
      >
        {scenes.map((scene, index) => (
          <li key={scene.id} className="relative flex shrink-0 items-stretch">
            {drag && drag.slot === index && drag.id !== scene.id ? <DropMark /> : null}
            <SceneCard
              scene={scene}
              index={index}
              timeline={timelines.get(scene.src)}
              target={target}
              selected={scene.id === selected}
              playing={scene.id === playing}
              agent={agentScenes.has(scene.id)}
              people={people.get(scene.id) ?? []}
              dragging={drag?.id === scene.id}
              renaming={renaming === scene.id}
              length={formatLength(scene.durationMs)}
              onPointerDown={(event) => {
                if (renaming !== scene.id) start(event, scene.id, () => actions.select(scene))
              }}
              onKeyDown={(event) => onKeyDown(event, scene, index)}
              onRename={(label) => {
                setRenaming(null)
                if (label !== null) actions.rename(scene, label)
              }}
              menu={
                <SceneMenu
                  name={sceneName(scene)}
                  first={index === 0}
                  last={index === scenes.length - 1}
                  only={scenes.length === 1}
                  onRename={() => setRenaming(scene.id)}
                  onDuplicate={() => actions.duplicate(scene)}
                  onMove={(by) => actions.move(scene, index + by)}
                  onDelete={() => actions.remove(scene)}
                />
              }
            />
            {drag && drag.slot === scenes.length && index === scenes.length - 1 ? (
              <DropMark end />
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  )
}

function DropMark({ end = false }: { readonly end?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-y-1 z-10 w-0.5 rounded-full bg-primary",
        end ? "-right-[5px]" : "-left-[5px]"
      )}
    />
  )
}

function SceneCard({
  scene,
  index,
  timeline,
  target,
  selected,
  playing,
  agent,
  people,
  dragging,
  renaming,
  length,
  menu,
  onRename,
  ...handlers
}: {
  readonly scene: VideoScene
  readonly index: number
  readonly timeline: VideoFileTimeline | undefined
  readonly target: MediaTarget
  readonly selected: boolean
  readonly playing: boolean
  readonly agent: boolean
  readonly people: readonly ArtifactLiveUser[]
  readonly dragging: boolean
  readonly renaming: boolean
  readonly length: string
  readonly menu: React.ReactNode
  readonly onRename: (label: string | null) => void
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onKeyDown: (event: ReactKeyboardEvent) => void
}) {
  const messages = useArtifactMessages().videoEditor
  const name = sceneName(scene)

  return (
    <div
      data-scene-card={scene.id}
      data-reorder-id={scene.id}
      className={cn(
        "group/scene relative w-36 rounded-lg transition-opacity",
        dragging && "opacity-40"
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={messages.sceneLabel(index + 1, name, length)}
        title={agent ? messages.agentEditing : messages.reorderHint}
        className={cn(
          "relative block w-full touch-none overflow-hidden rounded-lg bg-muted text-left outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "ring-2 ring-primary" : "ring-1 ring-border hover:ring-foreground/30",
          agent && "sixb-agent-board"
        )}
        {...handlers}
      >
        <SceneThumbnail scene={scene} timeline={timeline} target={target} />
        <span className="absolute top-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/60 px-1.5 text-[11px] font-semibold text-white tabular-nums backdrop-blur-sm">
          {index + 1}
        </span>
        {playing ? (
          <span
            aria-hidden="true"
            className="absolute right-1.5 bottom-1.5 size-1.5 rounded-full bg-white shadow-[0_0_0_2px_rgb(0_0_0/0.4)]"
          />
        ) : null}
        {agent ? (
          <span className="absolute bottom-1.5 left-1.5 flex h-5 items-center gap-1 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
            <Sparkles className="size-3" aria-hidden="true" />
            {messages.agentShort}
          </span>
        ) : null}
      </button>

      <div className="mt-1.5 flex items-center gap-1 px-0.5">
        {renaming ? (
          <RenameField name={scene.label ?? ""} placeholder={scene.id} onDone={onRename} />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
            title={name}
          >
            {name}
          </span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{length}</span>
      </div>

      {people.length > 0 ? (
        <span className="absolute -top-1.5 -right-1.5 flex -space-x-1">
          {people.slice(0, 3).map((person) => (
            <span
              key={person.id}
              title={messages.peerSelected(person.name)}
              className="grid size-5 place-items-center rounded-full text-[10px] font-semibold text-white ring-2 ring-background"
              style={{ background: person.color }}
            >
              {(person.name || "?").slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
      ) : null}

      <div className="absolute top-1 right-1 opacity-0 transition-opacity group-focus-within/scene:opacity-100 group-hover/scene:opacity-100 has-[[data-state=open]]:opacity-100 [@media(pointer:coarse)]:opacity-100">
        {menu}
      </div>
    </div>
  )
}

function SceneMenu({
  name,
  first,
  last,
  only,
  onRename,
  onDuplicate,
  onMove,
  onDelete,
}: {
  readonly name: string
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={messages.sceneOptions(name)}
          className="grid size-6 place-items-center rounded-md bg-black/55 text-white outline-none backdrop-blur-sm hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white"
        >
          <Ellipsis className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
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

/** Types a scene's new name: Enter keeps it, Escape or leaving with nothing changed drops it. */
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

  const finish = (label: string | null) => {
    if (done.current) return
    done.current = true
    onDone(label === name ? null : label)
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
      className="h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  const still = sceneStillUrl(target, scene.id)
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
