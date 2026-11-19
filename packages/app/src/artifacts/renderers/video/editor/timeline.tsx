import {
  type ArtifactLiveUser,
  findVideoTarget,
  VIDEO_ENTRY,
  type VideoComposition,
  type VideoFileTimeline,
  type VideoScene,
  type VideoTrack,
  videoTarget,
} from "@sixb/core/artifacts/live"
import { Tooltip, TooltipContent, TooltipTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AudioLines, Image as ImageIcon, TriangleAlert, Type, Video } from "lucide-react"
import {
  Fragment,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useArtifactMessages } from "../../../messages"
import { formatClock } from "../../../playback"
import { Waveform } from "../../../waveform"
import { type MediaTarget, useMediaParts } from "./media"
import {
  fitZoom,
  type LaidClip,
  rulerSteps,
  SNAP_PX,
  sceneSpans,
  snapMove,
  snapTo,
  trackRows,
  zoomAround,
} from "./model"
import { useReorder } from "./reorder"
import { FilmstripFrame, type SceneActions, SceneBlock, SceneDropMark } from "./scenes"
import { clipName, type EditorSelection } from "./selection"

// The timeline: one axis for the whole video, its scenes along the top, each with its picture, the
// open scene's clips under them on the picture, text and sound tracks, and the video's own
// soundtrack at the foot. A scene is dragged along its track to reorder it.
// Clips are dragged to move and trimmed by their edges, snapping to the playhead, the marks, every
// edge and the cuts of their footage; Shift lets them go free. Ctrl or ⌘ with the wheel, or a
// pinch, zooms around the pointer.

/** The column of track names, which stays on the left as the timeline scrolls. */
const LABELS_PX = 112
/** Room after the video's end, to drop and trim past it. */
const TAIL_PX = 160

const ROW_PX: Record<"ruler" | "scenes" | VideoTrack, number> = {
  ruler: 24,
  scenes: 52,
  picture: 44,
  text: 26,
  sound: 36,
}

/**
 * Each track's colour, from the app's own tokens so it sits in its palette, light and dark: the
 * picture in the project's colour, words on a tint of it, sound on the neutral. Labels keep the
 * contrast their tokens are made for.
 */
export const TRACK_TONE: Record<VideoTrack, string> = {
  picture: "bg-primary text-primary-foreground",
  text: "bg-[color-mix(in_oklab,var(--primary)_16%,var(--background))] text-foreground",
  sound: "bg-[color-mix(in_oklab,var(--foreground)_11%,var(--background))] text-foreground",
}

/** A clip, or a scene's end, being dragged: where it was, and where it is now. */
type Drag =
  | {
      readonly type: "move"
      readonly clip: LaidClip
      readonly x: number
      readonly startMs: number
      readonly moved: boolean
      readonly target?: number
    }
  | {
      readonly type: "trim"
      readonly clip: LaidClip
      readonly edge: "start" | "end"
      readonly x: number
      readonly atMs: number
      readonly target?: number
    }
  | {
      readonly type: "scene"
      readonly scene: VideoScene
      readonly x: number
      readonly endMs: number
      readonly target?: number
    }
  | { readonly type: "scrub" }

export interface TimelineEdits {
  readonly seek: (ms: number, mode: "drag" | "commit") => void
  readonly select: (selection: EditorSelection) => void
  readonly open: (scene: VideoScene) => void
  readonly moveClip: (clip: LaidClip, startMs: number) => void
  readonly trimClip: (clip: LaidClip, edge: "start" | "end", atMs: number) => void
  readonly sceneLength: (scene: VideoScene, ms: number) => void
  /** Reorders, duplicates, deletes or renames a scene. */
  readonly scene: SceneActions
}

export function Timeline({
  composition,
  clips,
  open,
  selection,
  timeMs,
  marks,
  snapping,
  agentScenes,
  people,
  timelines,
  target,
  uploads,
  toolbar,
  edits,
  dropTarget,
  formatLength,
}: {
  readonly composition: VideoComposition
  /** The open scene's clips and the video's own, laid out in its time. */
  readonly clips: readonly LaidClip[]
  readonly open: VideoScene | undefined
  readonly selection: EditorSelection
  readonly timeMs: number
  readonly marks: { readonly in?: number; readonly out?: number }
  readonly snapping: boolean
  readonly agentScenes: ReadonlySet<string>
  /** Who else has each scene open, by its id. */
  readonly people: ReadonlyMap<string, readonly ArtifactLiveUser[]>
  /** Each file's clips and texts, which a scene's picture falls back on. */
  readonly timelines: ReadonlyMap<string, VideoFileTimeline>
  readonly target: MediaTarget
  /** Files being uploaded, shown where they will land. */
  readonly uploads: readonly {
    readonly id: string
    readonly name: string
    readonly startMs: number
    readonly durationMs: number
    readonly progress: number
    readonly track: VideoTrack
  }[]
  readonly toolbar: (zoom: ZoomControls) => ReactNode
  readonly edits: TimelineEdits
  /** Whether files are being dragged over the editor. */
  readonly dropTarget: boolean
  /** A scene's length, as the reader reads it. */
  readonly formatLength: (ms: number) => string
}) {
  const messages = useArtifactMessages().videoEditor
  const scroller = useRef<HTMLDivElement | null>(null)
  const scenesRow = useRef<HTMLDivElement | null>(null)

  // A scene dragged along its track lands before the scene whose middle it passes.
  const { drag: reorder, start: startReorder } = useReorder({
    items: () => [...(scenesRow.current?.querySelectorAll<HTMLElement>("[data-reorder-id]") ?? [])],
    axis: "x",
    onMove: (id, _from, to) => {
      const scene = composition.scenes.find((each) => each.id === id)
      if (scene) edits.scene.move(scene, to)
    },
  })
  const [width, setWidth] = useState(0)
  const [pxPerSecond, setPxPerSecond] = useState<number | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag

  // The timeline's own width, which the first zoom fits the video to.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fit = fitZoom(composition.durationMs, Math.max(0, width - LABELS_PX - 48))
  const zoom = pxPerSecond ?? fit
  // The first fit holds as the video's length changes, so an edit never rescales the timeline
  // under the reader's pointer; Fit to window fits it again.
  useEffect(() => {
    if (pxPerSecond === null && width > 0) setPxPerSecond(fit)
  }, [pxPerSecond, width, fit])
  const px = (ms: number) => (ms / 1000) * zoom
  const contentWidth = Math.max(width, LABELS_PX + px(composition.durationMs) + TAIL_PX)

  /** The instant under a pointer, from the video's start. */
  const msAt = (clientX: number) => {
    const element = scroller.current
    if (!element) return 0
    const left = element.getBoundingClientRect().left
    return Math.max(0, ((clientX - left + element.scrollLeft - LABELS_PX) / zoom) * 1000)
  }

  // Zooming around the pointer: Ctrl or ⌘ with the wheel, as a trackpad's pinch sends it.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const anchor = event.clientX - element.getBoundingClientRect().left - LABELS_PX
      const next = zoomAround(
        { pxPerSecond: zoomRef.current, scrollLeft: element.scrollLeft },
        Math.exp(-event.deltaY / 200),
        Math.max(0, anchor)
      )
      setPxPerSecond(next.pxPerSecond)
      requestAnimationFrame(() => {
        element.scrollLeft = next.scrollLeft
      })
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [])

  const zoomBy = (factor: number) => {
    const element = scroller.current
    const playhead = px(timeMs) - (element?.scrollLeft ?? 0)
    const anchor =
      playhead >= 0 && playhead <= width - LABELS_PX ? playhead : (width - LABELS_PX) / 2
    const next = zoomAround(
      { pxPerSecond: zoom, scrollLeft: element?.scrollLeft ?? 0 },
      factor,
      anchor
    )
    setPxPerSecond(next.pxPerSecond)
    requestAnimationFrame(() => {
      if (element) element.scrollLeft = next.scrollLeft
    })
  }

  // As the playhead moves, playing or sought, it stays in sight, a page at a time. Nothing else
  // scrolls the timeline: a click, an edit or someone else's change leaves it where the reader is.
  useEffect(() => {
    const element = scroller.current
    if (!element || dragRef.current) return
    const at = (timeMs / 1000) * zoomRef.current
    const visible = element.clientWidth - LABELS_PX
    if (at < element.scrollLeft || at > element.scrollLeft + visible - 24) {
      element.scrollLeft = Math.max(0, at - visible * 0.1)
    }
  }, [timeMs])

  // What edges snap to: the playhead, the marks, every edge, and the cuts of the dragged footage.
  const parts = useMediaParts(
    drag && drag.type !== "scrub" && drag.type !== "scene" ? target : null,
    drag && (drag.type === "move" || drag.type === "trim") ? drag.clip.clip.src : undefined
  )
  const targets = useMemo(() => {
    const dragged = drag && (drag.type === "move" || drag.type === "trim") ? drag.clip : null
    // The clip dragged, as the timeline lays it out now: a change that lands mid-drag lays it anew.
    const points = new Set<number>([0, timeMs])
    if (marks.in !== undefined) points.add(marks.in)
    if (marks.out !== undefined) points.add(marks.out)
    for (const scene of composition.scenes) {
      points.add(scene.startMs)
      points.add(scene.startMs + scene.durationMs)
    }
    for (const clip of clips) {
      if (dragged && sameClip(clip, dragged)) continue
      points.add(clip.startMs)
      if (!clip.open) points.add(clip.endMs)
    }
    if (dragged) {
      for (const cut of parts.cuts) {
        points.add(dragged.startMs + cut - dragged.clip.mediaStartMs)
      }
    }
    return [...points]
  }, [composition, clips, timeMs, marks.in, marks.out, drag, parts.cuts])

  const threshold = (SNAP_PX / zoom) * 1000
  const snapMs = (ms: number, free: boolean) =>
    snapping && !free ? snapTo(ms, targets, threshold) : { ms }

  // ── Dragging ───────────────────────────────────────────────────────

  const startDrag = (event: ReactPointerEvent, next: Drag) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag(next)
  }

  const onDragMove = (event: ReactPointerEvent) => {
    const current = dragRef.current
    if (!current) return
    const free = event.shiftKey

    if (current.type === "scrub") {
      edits.seek(msAt(event.clientX), "drag")
      return
    }

    const delta = ((event.clientX - current.x) / zoom) * 1000
    if (current.type === "move") {
      const length = current.clip.endMs - current.clip.startMs
      const raw = Math.max(0, current.clip.startMs + delta)
      const snapped =
        snapping && !free ? snapMove(raw, length, targets, threshold) : { startMs: raw }
      setDrag({
        ...current,
        startMs: snapped.startMs,
        moved: current.moved || Math.abs(event.clientX - current.x) > 3,
        ...(snapped.target === undefined ? { target: undefined } : { target: snapped.target }),
      } as Drag)
      return
    }

    if (current.type === "trim") {
      const from = current.edge === "start" ? current.clip.startMs : current.clip.endMs
      const snapped = snapMs(from + delta, free)
      setDrag({ ...current, atMs: snapped.ms, target: snapped.target } as Drag)
      return
    }

    const end = current.scene.startMs + current.scene.durationMs
    const snapped = snapMs(Math.max(current.scene.startMs + 100, end + delta), free)
    setDrag({ ...current, endMs: snapped.ms, target: snapped.target } as Drag)
  }

  const onDragEnd = (event: ReactPointerEvent) => {
    const current = dragRef.current
    setDrag(null)
    if (!current) return

    switch (current.type) {
      case "scrub":
        edits.seek(msAt(event.clientX), "commit")
        return
      case "move":
        if (!current.moved) {
          edits.select({
            type: "clip",
            file: current.clip.file,
            target: videoTarget(current.clip.clip),
          })
          return
        }
        edits.moveClip(current.clip, current.startMs)
        return
      case "trim":
        edits.trimClip(current.clip, current.edge, current.atMs)
        return
      case "scene":
        edits.sceneLength(current.scene, current.endMs - current.scene.startMs)
        return
    }
  }

  const dragHandlers = {
    onPointerMove: onDragMove,
    onPointerUp: onDragEnd,
    onPointerCancel: () => setDrag(null),
  }

  // ── Layout ─────────────────────────────────────────────────────────

  // The clip selected, as its file is now.
  const chosen =
    selection?.type === "clip"
      ? findVideoTarget(
          clips.filter((laid) => laid.file === selection.file).map((laid) => laid.clip),
          selection.target
        )
      : undefined

  const rows = trackRows(clips)
  const sceneClips = clips.filter((clip) => clip.file !== VIDEO_ENTRY)
  const ownClips = clips.filter((clip) => clip.file === VIDEO_ENTRY)
  const tracks: {
    readonly id: string
    readonly track: VideoTrack
    readonly label: string
    readonly clips: readonly LaidClip[]
    readonly rows: number
  }[] = [
    {
      id: "picture",
      track: "picture",
      label: messages.tracks.picture,
      clips: sceneClips.filter((clip) => clip.track === "picture"),
      rows: rows.picture,
    },
    {
      id: "text",
      track: "text",
      label: messages.tracks.text,
      clips: sceneClips.filter((clip) => clip.track === "text"),
      rows: rows.text,
    },
    {
      id: "sound",
      track: "sound",
      label: messages.tracks.sound,
      clips: sceneClips.filter((clip) => clip.track === "sound"),
      rows: rows.sound,
    },
  ]
  if (ownClips.length > 0) {
    tracks.push({
      id: "soundtrack",
      track: "sound",
      label: messages.tracks.soundtrack,
      clips: ownClips,
      rows: Math.max(1, ...ownClips.map((clip) => clip.row + 1)),
    })
  }

  // Each scene where it shows, its end as dragged, and what it plays with the next.
  const sceneEnd = (scene: VideoScene) =>
    drag?.type === "scene" && drag.scene.id === scene.id
      ? drag.endMs
      : scene.startMs + scene.durationMs
  const spans = sceneSpans(
    composition.scenes.map((scene) => ({ startMs: scene.startMs, endMs: sceneEnd(scene) }))
  )

  /** Where a scene dropped in `slot` goes: the start of the scene there, or the video's end. */
  const dropAt = (slot: number) => {
    const scene = composition.scenes[slot]
    return px(scene ? scene.startMs : composition.durationMs)
  }

  const snapLine =
    drag && "target" in drag && drag.target !== undefined ? px(drag.target) : undefined
  const { major, minor } = rulerSteps(zoom)

  return (
    <section aria-label={messages.timeline} className="flex min-h-0 flex-1 flex-col">
      {toolbar({
        zoomIn: () => zoomBy(1.5),
        zoomOut: () => zoomBy(1 / 1.5),
        fit: () => {
          setPxPerSecond(fit)
          if (scroller.current) scroller.current.scrollLeft = 0
        },
        canZoomIn: zoom < 640,
        canZoomOut: zoom > fit + 0.01,
      })}

      <div
        ref={scroller}
        data-video-timeline=""
        className={cn(
          "relative min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:thin]",
          dropTarget && "bg-primary/5"
        )}
      >
        <div className="relative" style={{ width: contentWidth }}>
          {/* The ruler: a click or a drag moves the playhead. */}
          <div
            className="sticky top-0 z-20 flex border-b border-border bg-background/95 backdrop-blur"
            style={{ height: ROW_PX.ruler }}
          >
            <div
              className="sticky left-0 z-10 shrink-0 bg-background"
              style={{ width: LABELS_PX }}
            />
            <div
              role="slider"
              tabIndex={-1}
              aria-label={messages.playhead}
              aria-valuemin={0}
              aria-valuemax={composition.durationMs / 1000}
              aria-valuenow={timeMs / 1000}
              className="relative flex-1 cursor-pointer touch-none select-none"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                edits.seek(msAt(event.clientX), "drag")
                startDrag(event, { type: "scrub" })
              }}
              {...dragHandlers}
            >
              <Ruler
                durationMs={composition.durationMs + (TAIL_PX / zoom) * 1000}
                major={major}
                minor={minor}
                px={px}
              />
            </div>
          </div>

          <Row
            label={messages.tracks.scenes}
            height={ROW_PX.scenes}
            rowRef={scenesRow}
            onBackground={(event) => edits.seek(msAt(event.clientX), "commit")}
          >
            {composition.scenes.map((scene, index) => {
              const span = spans[index]
              if (!span) return null
              const endHandle = (
                <EdgeHandle
                  edge="end"
                  label={messages.length}
                  onPointerDown={(event) =>
                    startDrag(event, {
                      type: "scene",
                      scene,
                      x: event.clientX,
                      endMs: scene.startMs + scene.durationMs,
                    })
                  }
                  {...dragHandlers}
                />
              )
              return (
                <Fragment key={scene.id}>
                  <div
                    data-timeline-scene={scene.id}
                    data-reorder-id={scene.id}
                    className="absolute inset-y-1"
                    style={{
                      left: px(span.startMs),
                      width: Math.max(4, px(span.endMs - span.startMs)),
                    }}
                  >
                    <SceneBlock
                      scene={scene}
                      index={index}
                      count={composition.scenes.length}
                      timeline={timelines.get(scene.src)}
                      target={target}
                      open={open?.id === scene.id}
                      agent={agentScenes.has(scene.id)}
                      people={people.get(scene.id) ?? []}
                      dragging={reorder?.id === scene.id}
                      length={formatLength(sceneEnd(scene) - scene.startMs)}
                      actions={edits.scene}
                      onPress={(event) => startReorder(event, scene.id, () => edits.open(scene))}
                    >
                      {span.crossfade ? null : endHandle}
                    </SceneBlock>
                  </div>
                  {span.crossfade ? (
                    <Crossfade
                      left={px(span.crossfade.startMs)}
                      width={px(span.crossfade.endMs - span.crossfade.startMs)}
                      label={messages.crossfade(
                        formatLength(span.crossfade.endMs - span.crossfade.startMs)
                      )}
                    >
                      {endHandle}
                    </Crossfade>
                  ) : null}
                </Fragment>
              )
            })}
            {reorder ? <SceneDropMark left={dropAt(reorder.slot)} /> : null}
          </Row>

          {tracks.map((track) => (
            <Row
              key={track.id}
              label={track.label}
              icon={trackIcon(track.track)}
              height={ROW_PX[track.track] * track.rows}
              onBackground={(event) => {
                edits.select(null)
                edits.seek(msAt(event.clientX), "commit")
              }}
              muted={track.id !== "soundtrack" && !open}
            >
              {track.id !== "soundtrack" && open ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 bg-foreground/[0.025] dark:bg-foreground/[0.04]"
                  style={{ left: px(open.startMs), width: px(open.durationMs) }}
                />
              ) : null}
              {track.clips.map((laid) => {
                const selected = chosen === laid.clip
                const moving =
                  drag?.type === "move" && sameClip(drag.clip, laid) && drag.moved ? drag : null
                const trimming = drag?.type === "trim" && sameClip(drag.clip, laid) ? drag : null
                const start = moving
                  ? moving.startMs
                  : trimming?.edge === "start"
                    ? trimming.atMs
                    : laid.startMs
                const end = moving
                  ? moving.startMs + laid.endMs - laid.startMs
                  : trimming?.edge === "end"
                    ? trimming.atMs
                    : laid.endMs
                return (
                  <ClipBlock
                    key={`${laid.file}#${laid.clip.ref}`}
                    laid={laid}
                    selected={selected}
                    dragging={!!moving || !!trimming}
                    left={px(start)}
                    width={Math.max(6, px(end - start))}
                    top={laid.row * ROW_PX[track.track]}
                    height={ROW_PX[track.track]}
                    target={target}
                    zoom={zoom}
                    viewStartMs={start}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      startDrag(event, {
                        type: "move",
                        clip: laid,
                        x: event.clientX,
                        startMs: laid.startMs,
                        moved: false,
                      })
                    }}
                    onTrim={(event, edge) =>
                      startDrag(event, {
                        type: "trim",
                        clip: laid,
                        edge,
                        x: event.clientX,
                        atMs: edge === "start" ? laid.startMs : laid.endMs,
                      })
                    }
                    onSelect={() =>
                      edits.select({
                        type: "clip",
                        file: laid.file,
                        target: videoTarget(laid.clip),
                      })
                    }
                    dragHandlers={dragHandlers}
                  />
                )
              })}
              {uploads
                .filter((upload) => upload.track === track.track && track.id !== "soundtrack")
                .map((upload) => (
                  <div
                    key={upload.id}
                    className="absolute inset-y-1 overflow-hidden rounded-md border border-dashed border-primary/60 bg-primary/10"
                    style={{ left: px(upload.startMs), width: Math.max(24, px(upload.durationMs)) }}
                  >
                    <span
                      className="absolute inset-y-0 left-0 bg-primary/20 transition-[width] duration-300"
                      style={{ width: `${Math.round(upload.progress * 100)}%` }}
                    />
                    <span className="relative flex h-full items-center px-2 text-[11px] font-medium text-foreground">
                      <span className="truncate">
                        {messages.uploading(upload.name, Math.round(upload.progress * 100))}
                      </span>
                    </span>
                  </div>
                ))}
            </Row>
          ))}

          {/* Marks in and out, over every track. */}
          {marks.in !== undefined || marks.out !== undefined ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 z-10 border-x-2 border-warning/80 bg-warning/10"
              style={{
                left: LABELS_PX + px(marks.in ?? 0),
                width: Math.max(2, px((marks.out ?? composition.durationMs) - (marks.in ?? 0))),
              }}
            />
          ) : null}

          {snapLine !== undefined ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-warning"
              style={{ left: LABELS_PX + snapLine }}
            />
          ) : null}

          {/* The playhead, its knob on the ruler. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-500"
            style={{ left: LABELS_PX + px(timeMs) }}
          >
            <span className="absolute -top-px -left-[5px] h-3 w-[11px] rounded-b-sm bg-red-500" />
          </span>
        </div>
      </div>
    </section>
  )
}

/** Whether two laid clips are the same clip of the same file, laid out at different times. */
function sameClip(a: LaidClip, b: LaidClip): boolean {
  return a.file === b.file && a.clip.ref === b.clip.ref
}

export interface ZoomControls {
  readonly zoomIn: () => void
  readonly zoomOut: () => void
  readonly fit: () => void
  readonly canZoomIn: boolean
  readonly canZoomOut: boolean
}

function trackIcon(track: VideoTrack) {
  switch (track) {
    case "picture":
      return <Video aria-hidden="true" />
    case "text":
      return <Type aria-hidden="true" />
    case "sound":
      return <AudioLines aria-hidden="true" />
  }
}

/** A track: its name in the sticky column, and its clips along the time. */
function Row({
  label,
  icon,
  height,
  muted = false,
  rowRef,
  onBackground,
  children,
}: {
  readonly label: string
  readonly icon?: ReactNode
  readonly height: number
  readonly muted?: boolean
  readonly rowRef?: Ref<HTMLDivElement>
  readonly onBackground: (event: ReactPointerEvent) => void
  readonly children: ReactNode
}) {
  return (
    <div className="flex border-b border-border/70" style={{ height }}>
      <div
        className="sticky left-0 z-10 flex shrink-0 items-start gap-1.5 border-r border-border/70 bg-background px-3 pt-2 text-[11px] font-medium text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
        style={{ width: LABELS_PX }}
      >
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div
        ref={rowRef}
        className={cn("relative flex-1", muted && "opacity-50")}
        onPointerDown={(event) => {
          if (event.button === 0 && event.target === event.currentTarget) onBackground(event)
        }}
      >
        {children}
      </div>
    </div>
  )
}

function Ruler({
  durationMs,
  major,
  minor,
  px,
}: {
  readonly durationMs: number
  readonly major: number
  readonly minor: number
  readonly px: (ms: number) => number
}) {
  const ticks: { readonly ms: number; readonly major: boolean }[] = []
  for (let ms = 0; ms <= durationMs; ms += minor) {
    ticks.push({ ms, major: Math.round(ms) % major === 0 })
  }
  return (
    <>
      {ticks.map((tick) => (
        <span
          key={tick.ms}
          aria-hidden="true"
          className={cn(
            "absolute bottom-0 w-px",
            tick.major ? "h-2.5 bg-muted-foreground/60" : "h-1.5 bg-muted-foreground/30"
          )}
          style={{ left: px(tick.ms) }}
        >
          {tick.major ? (
            <span className="absolute bottom-3 left-1 text-[10px] whitespace-nowrap text-muted-foreground tabular-nums">
              {rulerLabel(tick.ms, major)}
            </span>
          ) : null}
        </span>
      ))}
    </>
  )
}

/** A ruler mark's time: minutes and seconds, with tenths when the marks are closer than a second. */
function rulerLabel(ms: number, step: number): string {
  const seconds = ms / 1000
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  const shown = step < 1000 ? rest.toFixed(1) : String(Math.round(rest))
  return `${minutes}:${shown.padStart(step < 1000 ? 4 : 2, "0")}`
}

/**
 * Two scenes playing together, between them on the Scenes track: a band of their own, hatched,
 * which says how long they cross. It holds the first scene's end, which a drag moves.
 */
function Crossfade({
  left,
  width,
  label,
  children,
}: {
  readonly left: number
  readonly width: number
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="img"
          aria-label={label}
          data-crossfade=""
          className="group/sceneblock absolute inset-y-1 overflow-hidden rounded-[3px] border border-border bg-muted"
          style={{
            left,
            width: Math.max(4, width),
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, var(--foreground) 16%, transparent) 4px 5px)",
          }}
        >
          {children}
        </div>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function EdgeHandle({
  edge,
  label,
  ...handlers
}: {
  readonly edge: "start" | "end"
  readonly label: string
  readonly onPointerDown: (event: ReactPointerEvent) => void
  readonly onPointerMove: (event: ReactPointerEvent) => void
  readonly onPointerUp: (event: ReactPointerEvent) => void
  readonly onPointerCancel: () => void
}) {
  return (
    <span
      aria-hidden="true"
      title={label}
      className={cn(
        "group/edge absolute inset-y-0 z-10 flex w-2.5 cursor-ew-resize touch-none items-center",
        edge === "start" ? "left-0 justify-start pl-0.5" : "right-0 justify-end pr-0.5"
      )}
      {...handlers}
    >
      <span className="h-1/2 w-[3px] rounded-full bg-foreground/0 transition-colors group-hover/edge:bg-foreground/45 group-hover/sceneblock:bg-foreground/25" />
    </span>
  )
}

function ClipBlock({
  laid,
  selected,
  dragging,
  left,
  width,
  top,
  height,
  target,
  zoom,
  viewStartMs,
  onPointerDown,
  onTrim,
  onSelect,
  dragHandlers,
}: {
  readonly laid: LaidClip
  readonly selected: boolean
  readonly dragging: boolean
  readonly left: number
  readonly width: number
  readonly top: number
  readonly height: number
  readonly target: MediaTarget
  readonly zoom: number
  /** Where the block starts now, as dragged: its art follows its file from there. */
  readonly viewStartMs: number
  readonly onPointerDown: (event: ReactPointerEvent) => void
  readonly onTrim: (event: ReactPointerEvent, edge: "start" | "end") => void
  readonly onSelect: () => void
  readonly dragHandlers: {
    readonly onPointerMove: (event: ReactPointerEvent) => void
    readonly onPointerUp: (event: ReactPointerEvent) => void
    readonly onPointerCancel: () => void
  }
}) {
  const messages = useArtifactMessages().videoEditor
  const { clip } = laid
  const media = clip.kind === "video" || clip.kind === "audio" || clip.kind === "image"
  const parts = useMediaParts(media ? target : null, clip.src)
  const kind = clip.caption ? messages.clipKinds.caption : messages.clipKinds[clip.kind]
  const name = clipName(clip)
  // A recording that cannot be read plays nothing: it says so, rather than look like the others.
  const failed = media && parts.failed !== undefined
  // Where in its file the block's left edge is: a start trimmed moves into it.
  const mediaAt = clip.mediaStartMs + (viewStartMs - laid.startMs)
  const filmed = clip.kind === "video" && !!parts.filmstrip
  // Where its recording ends, from the block's left edge, when the clip lasts longer than it.
  const fileEndPx =
    (clip.kind === "video" || clip.kind === "audio") && parts.durationMs !== undefined
      ? ((parts.durationMs - mediaAt) / 1000) * zoom
      : undefined
  const runsOut = fileEndPx !== undefined && fileEndPx < width - 2

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={failed ? `${kind}, ${name}, ${messages.unreadable}` : `${kind}, ${name}`}
      data-timeline-clip={clip.ref}
      data-failed={failed ? "" : undefined}
      className={cn(
        "group/clip absolute touch-none overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
        failed
          ? "bg-[color-mix(in_oklab,var(--destructive)_10%,var(--background))] text-destructive"
          : TRACK_TONE[clip.track],
        selected
          ? "z-10 ring-2 ring-foreground ring-offset-1 ring-offset-background"
          : failed
            ? "ring-1 ring-destructive/45"
            : "ring-1 ring-black/10 dark:ring-white/10",
        dragging && "z-20 shadow-lg opacity-90",
        "cursor-grab active:cursor-grabbing"
      )}
      style={{
        left,
        width,
        top: top + 2,
        height: height - 4,
        ...(failed
          ? {
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in oklab, var(--destructive) 14%, transparent) 5px 6px)",
            }
          : {}),
      }}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      {...dragHandlers}
    >
      {filmed && parts.filmstrip ? (
        <FilmstripRun
          filmstrip={parts.filmstrip}
          fromMs={mediaAt}
          width={width}
          height={height - 4}
          zoom={zoom}
        />
      ) : null}
      {(clip.kind === "audio" || (clip.kind === "video" && !clip.silent)) && parts.waveform ? (
        <Waveform
          url={parts.waveform}
          fromMs={mediaAt}
          width={width}
          zoom={zoom}
          compact={clip.kind === "video"}
        />
      ) : null}
      {runsOut && parts.durationMs !== undefined ? (
        <FileEnd
          left={Math.max(0, fileEndPx ?? 0)}
          label={messages.fileEnds(formatClock(parts.durationMs / 1000))}
        />
      ) : null}
      {media && parts.processing ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-pulse bg-white/10 motion-reduce:animate-none"
        />
      ) : null}

      <span className="pointer-events-none relative flex h-full min-w-0 items-start gap-1 px-1.5 pt-1 text-[11px] leading-tight font-medium">
        {failed ? (
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
        ) : clip.kind === "image" ? (
          <ImageIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
        ) : null}
        {/* Over its frames or its peaks, the name sits on a shade of its own, whatever they show. */}
        <span
          className={cn(
            "truncate",
            filmed && "-mx-0.5 rounded-[3px] bg-black/55 px-1 text-white backdrop-blur-sm",
            !filmed &&
              clip.kind === "audio" &&
              parts.waveform &&
              "-mx-0.5 rounded-[3px] bg-background/80 px-1"
          )}
        >
          {name}
        </span>
        {failed ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium">{messages.unreadable}</span>
        ) : media && parts.processing ? (
          <span className="ml-auto shrink-0 rounded bg-black/55 px-1 text-[10px] font-normal text-white">
            {messages.processing}
          </span>
        ) : null}
      </span>

      <TrimHandle
        edge="start"
        onPointerDown={(event) => onTrim(event, "start")}
        {...dragHandlers}
      />
      {laid.open ? null : (
        <TrimHandle edge="end" onPointerDown={(event) => onTrim(event, "end")} {...dragHandlers} />
      )}
    </div>
  )
}

/**
 * What a clip plays past the end of its recording: dimmed and hatched from where the file ends,
 * which its tooltip says. The picture holds its last frame there, and the sound is silent.
 */
function FileEnd({ left, label }: { readonly left: number; readonly label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-file-end=""
          className="absolute inset-y-0 right-0 border-l border-current/50"
          style={{
            left,
            backgroundColor: "color-mix(in oklab, var(--background) 62%, transparent)",
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in oklab, var(--foreground) 14%, transparent) 5px 6px)",
          }}
        >
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function TrimHandle({
  edge,
  onPointerDown,
  ...handlers
}: {
  readonly edge: "start" | "end"
  readonly onPointerDown: (event: ReactPointerEvent) => void
  readonly onPointerMove: (event: ReactPointerEvent) => void
  readonly onPointerUp: (event: ReactPointerEvent) => void
  readonly onPointerCancel: () => void
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-y-0 z-10 w-2 cursor-ew-resize touch-none bg-white/0 transition-colors hover:bg-white/35 group-aria-pressed/clip:bg-white/25",
        edge === "start" ? "left-0 rounded-l-md" : "right-0 rounded-r-md"
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        onPointerDown(event)
      }}
      {...handlers}
    />
  )
}

/** A footage clip's frames along it, each the one at its place in the file. */
function FilmstripRun({
  filmstrip,
  fromMs,
  width,
  height,
  zoom,
}: {
  readonly filmstrip: Parameters<typeof FilmstripFrame>[0]["filmstrip"]
  readonly fromMs: number
  readonly width: number
  readonly height: number
  readonly zoom: number
}) {
  const tile = Math.max(24, (height * filmstrip.width) / filmstrip.height)
  const count = Math.min(80, Math.ceil(width / tile))
  return (
    <span aria-hidden="true" className="absolute inset-0 flex opacity-80">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={`${index}-${Math.round(fromMs)}`}
          className="h-full shrink-0 overflow-hidden border-r border-black/20"
          style={{ width: tile }}
        >
          <FilmstripFrame
            filmstrip={filmstrip}
            atMs={fromMs + ((index + 0.5) * tile * 1000) / zoom}
            className="size-full"
          />
        </span>
      ))}
    </span>
  )
}
