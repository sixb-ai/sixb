import {
  type ArtifactLiveUser,
  VIDEO_ENTRY,
  type VideoComposition,
  type VideoScene,
  type VideoTrack,
  videoTarget,
} from "@sixb/core/artifacts/live"
import { Tooltip, TooltipContent, TooltipTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AudioLines, Image as ImageIcon, TriangleAlert, Type, Video } from "lucide-react"
import {
  Fragment,
  memo,
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
import { commandKey } from "../keys"
import { type MediaTarget, useMediaParts } from "./media"
import {
  type ClipBox,
  chainKey,
  clipKey,
  fitZoom,
  groupDelta,
  inRectangle,
  type LaidClip,
  rulerSteps,
  SNAP_PX,
  sceneAt,
  sceneFor,
  sceneSpans,
  snapMove,
  snapTo,
  trackRows,
  zoomAround,
} from "./model"
import { useReorder } from "./reorder"
import { FilmstripFrame, type SceneActions, SceneBlock, SceneDropMark } from "./scenes"
import { choose, chosenIn, clipName, type EditorSelection, sceneName, toggled } from "./selection"

// The timeline: one axis for the whole video, as one continuous film. Its scenes are chapters on a
// slim bar along the top, with a faint line across the tracks where each starts; every chapter's
// clips lie under them on the picture, text and sound tracks, where they play, and the video's own
// soundtrack at the foot. A chapter is dragged along its bar to reorder it.
// Clips are dragged to move, anywhere along the video, and trimmed by their edges, snapping to the
// playhead, the marks, every edge, the chapters' and the cuts of their footage; Shift lets them go
// free. Dropped across a chapter's edge, a clip lands where the video plays it (see the core's
// placement). Ctrl or ⌘ with the wheel, or a pinch, zooms around the pointer.
// The command key, ⌘ on a Mac and Ctrl elsewhere, adds a clip clicked to the selection or takes it
// out, and dragged, draws a rectangle that selects every clip it touches. A selected clip dragged
// moves every selected clip with it.
// A drag redraws only what it moves: each clip is a block of its own, drawn again only when what it
// shows changes, so a video of hundreds of captions follows the pointer.

/** The column of track names, which stays on the left as the timeline scrolls. */
const LABELS_PX = 112
/** Room after the video's end, to drop and trim past it. */
const TAIL_PX = 160
/** The playhead's knob on the ruler, centred on its line; each ruler mark's time starts past it. */
const KNOB_PX = 11
/** A trim handle's width, and the narrowest block that has both at that width. */
const HANDLE_PX = 8
const HANDLES_FROM_PX = 24

const ROW_PX: Record<"ruler" | "scenes" | VideoTrack, number> = {
  ruler: 24,
  scenes: 30,
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
      /** The clips selected with it, itself included, which move as much. */
      readonly group?: readonly LaidClip[]
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
  | {
      readonly type: "marquee"
      /** Where it was pressed and where the pointer is: an instant, and how far down the tracks. */
      readonly from: TrackPoint
      readonly to: TrackPoint
      /** The clip pressed, which a press let go without a drag adds or takes out. */
      readonly over?: LaidClip
      /** The selection before it, which the clips it touches join. */
      readonly before: EditorSelection
      readonly moved: boolean
      /** The clips it touches now, by file and ref. */
      readonly touched: string
    }

/** A point over the tracks: the instant under it, and its pixels from the first track's top. */
interface TrackPoint {
  readonly ms: number
  readonly y: number
}

export interface TimelineEdits {
  readonly seek: (ms: number, mode: "drag" | "commit") => void
  readonly select: (selection: EditorSelection) => void
  readonly moveClip: (clip: LaidClip, startMs: number) => void
  /** Moves clips together by `deltaMs`, as one edit. */
  readonly moveClips: (clips: readonly LaidClip[], deltaMs: number) => void
  readonly trimClip: (clip: LaidClip, edge: "start" | "end", atMs: number) => void
  readonly sceneLength: (scene: VideoScene, ms: number) => void
  /** Reorders, duplicates, deletes or renames a scene. */
  readonly scene: SceneActions
  /** Files dragged over the tracks would land at this instant; null once they leave. */
  readonly dropOver?: (ms: number | null) => void
}

/** What a clip's block does with the pointer, the same functions from one render to the next. */
interface ClipHandlers {
  readonly press: (event: ReactPointerEvent, laid: LaidClip) => void
  readonly trim: (event: ReactPointerEvent, laid: LaidClip, edge: "start" | "end") => void
  readonly select: (laid: LaidClip) => void
  readonly onPointerMove: (event: ReactPointerEvent) => void
  readonly onPointerUp: (event: ReactPointerEvent) => void
  readonly onPointerCancel: () => void
}

export function Timeline({
  composition,
  clips,
  selection,
  timeMs,
  marks,
  snapping,
  magnetic = false,
  agentScenes,
  people,
  target,
  uploads,
  toolbar,
  edits,
  dropTarget,
  filesAt = null,
  formatLength,
}: {
  readonly composition: VideoComposition
  /** Every chapter's clips and the video's own, laid out in its time. */
  readonly clips: readonly LaidClip[]
  readonly selection: EditorSelection
  readonly timeMs: number
  readonly marks: { readonly in?: number; readonly out?: number }
  readonly snapping: boolean
  /** Whether a trim closes its gap: a start trimmed then keeps its place, as far into its file. */
  readonly magnetic?: boolean
  readonly agentScenes: ReadonlySet<string>
  /** Who else has each scene open, by its id. */
  readonly people: ReadonlyMap<string, readonly ArtifactLiveUser[]>
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
  /** Where files dragged over the tracks would land, from the video's start. */
  readonly filesAt?: number | null
  /** A scene's length, as the reader reads it. */
  readonly formatLength: (ms: number) => string
}) {
  const messages = useArtifactMessages().videoEditor
  const scroller = useRef<HTMLDivElement | null>(null)
  const scenesRow = useRef<HTMLDivElement | null>(null)
  const tracksArea = useRef<HTMLDivElement | null>(null)

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

  // What edges snap to: the playhead, the marks, every edge, the chapters', and the cuts of the
  // dragged footage. Worked out once a drag starts, not as it moves: it holds the same clips.
  const dragged = drag && (drag.type === "move" || drag.type === "trim") ? drag.clip : null
  const draggedGroup = drag?.type === "move" ? drag.group : undefined
  const parts = useMediaParts(dragged ? target : null, dragged?.clip.src)
  const targets = useMemo(() => {
    // Clips dragged together snap to what stays, never to each other.
    const moving = new Set([...(dragged ? [dragged] : []), ...(draggedGroup ?? [])].map(clipKey))
    const points = new Set<number>([0, timeMs])
    if (marks.in !== undefined) points.add(marks.in)
    if (marks.out !== undefined) points.add(marks.out)
    for (const scene of composition.scenes) {
      points.add(scene.startMs)
      points.add(scene.startMs + scene.durationMs)
    }
    // The clip dragged, as the timeline lays it out now: a change that lands mid-drag lays it anew.
    for (const clip of clips) {
      if (moving.has(clipKey(clip))) continue
      points.add(clip.startMs)
      if (!clip.open) points.add(clip.endMs)
    }
    if (dragged) {
      for (const cut of parts.cuts) {
        points.add(dragged.startMs + cut - dragged.clip.mediaStartMs)
      }
    }
    return [...points]
  }, [composition, clips, timeMs, marks.in, marks.out, dragged, draggedGroup, parts.cuts])

  const threshold = (SNAP_PX / zoom) * 1000
  const snapMs = (ms: number, free: boolean) =>
    snapping && !free ? snapTo(ms, targets, threshold) : { ms }

  /** Where a clip's scene starts, which its start is never trimmed before. */
  const sceneStartOf = (file: string) =>
    file === VIDEO_ENTRY
      ? 0
      : (composition.scenes.find((scene) => scene.src === file)?.startMs ?? 0)

  // ── Dragging ───────────────────────────────────────────────────────

  const startDrag = (event: ReactPointerEvent, next: Drag) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag(next)
  }

  const onDragMove = (event: ReactPointerEvent) => {
    const current = dragRef.current
    if (!current || current.type === "marquee") return
    const free = event.shiftKey

    if (current.type === "scrub") {
      edits.seek(msAt(event.clientX), "drag")
      return
    }

    const delta = ((event.clientX - current.x) / zoom) * 1000
    if (current.type === "move") {
      const { clip, group } = current
      const length = clip.endMs - clip.startMs
      const raw = group ? clip.startMs + delta : Math.max(0, clip.startMs + delta)
      const snapped =
        snapping && !free ? snapMove(raw, length, targets, threshold) : { startMs: raw }

      // Anywhere along the video: together, the clips go as far as the first to reach its start.
      const startMs = group
        ? clip.startMs +
          groupDelta(
            group.map((each) => ({ startMs: each.startMs, floorMs: 0 })),
            snapped.startMs - clip.startMs
          )
        : snapped.startMs
      const target = startMs === snapped.startMs ? snapped.target : undefined
      setDrag({
        ...current,
        startMs,
        moved: current.moved || Math.abs(event.clientX - current.x) > 3,
        target,
      })
      return
    }

    if (current.type === "trim") {
      const { clip, edge } = current
      const snapped = snapMs((edge === "start" ? clip.startMs : clip.endMs) + delta, free)
      // As the edit will have it: a recording's start never before its file's, nor, unless it
      // closes its gap and keeps its place, before its chapter's; any other clip's never before
      // its chapter's; and a clip never shorter than a few frames.
      const plays = clip.clip.kind === "video" || clip.clip.kind === "audio"
      const floor = plays
        ? Math.max(
            clip.startMs - clip.clip.mediaStartMs,
            magnetic ? Number.NEGATIVE_INFINITY : sceneStartOf(clip.file)
          )
        : sceneStartOf(clip.file)
      // A clip that goes on in other chapters is trimmed as one: back into its first chapter, or
      // on into its last.
      const span = spanOf(clip)
      const atMs =
        edge === "start"
          ? Math.min(Math.max(floor, snapped.ms), span.endMs - 100)
          : Math.max(span.startMs + 100, snapped.ms)
      setDrag({ ...current, atMs, target: atMs === snapped.ms ? snapped.target : undefined })
      return
    }

    const end = current.scene.startMs + current.scene.durationMs
    const snapped = snapMs(Math.max(current.scene.startMs + 100, end + delta), free)
    setDrag({ ...current, endMs: snapped.ms, target: snapped.target } as Drag)
  }

  const onDragEnd = (event: ReactPointerEvent) => {
    const current = dragRef.current
    if (current?.type === "marquee") return
    // A trim handle's release bubbles to its clip, whose handlers end the same drag: it ends once.
    dragRef.current = null
    setDrag(null)
    if (!current) return

    switch (current.type) {
      case "scrub":
        edits.seek(msAt(event.clientX), "commit")
        return
      case "move":
        // A press let go, or a clip brought back where it was, as a snap or a group held at the
        // video's start does: it is chosen, and nothing is edited.
        if (!current.moved || current.startMs === current.clip.startMs) {
          edits.select(selectionOfClip(headOf(current.clip)))
          return
        }
        if (current.group) edits.moveClips(current.group, current.startMs - current.clip.startMs)
        else edits.moveClip(current.clip, current.startMs)
        return
      case "trim": {
        const was = current.edge === "start" ? current.clip.startMs : current.clip.endMs
        if (current.atMs !== was) edits.trimClip(current.clip, current.edge, current.atMs)
        return
      }
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

  // Each clip that goes on in other scenes, by its first part's key: its parts, laid out now.
  const chains = useMemo(() => {
    const found = new Map<string, LaidClip[]>()
    for (const laid of clips) {
      if (laid.chain) found.set(laid.chain.key, [...(found.get(laid.chain.key) ?? []), laid])
    }
    return found
  }, [clips])
  const partsOf = (laid: LaidClip) => (laid.chain ? (chains.get(laid.chain.key) ?? [laid]) : [laid])
  /** Where a clip plays as one, all its parts. */
  const spanOf = (laid: LaidClip) => {
    const parts = partsOf(laid)
    return {
      startMs: Math.min(...parts.map((part) => part.startMs)),
      endMs: Math.max(...parts.map((part) => part.endMs)),
    }
  }
  /**
   * A part as a trim of its clip leaves it: its first part starting, or its last ending, at the
   * edge dragged, the parts it passes hidden, the others cut there.
   */
  const trimmedPart = (laid: LaidClip, trim: Extract<Drag, { type: "trim" }>) => {
    const span = spanOf(laid)
    if (trim.edge === "end") {
      const endMs = laid.endMs >= span.endMs ? trim.atMs : Math.min(laid.endMs, trim.atMs)
      return {
        startMs: laid.startMs,
        endMs: Math.max(laid.startMs, endMs),
        hidden: endMs <= laid.startMs,
      }
    }
    const startMs = laid.startMs <= span.startMs ? trim.atMs : Math.max(laid.startMs, trim.atMs)
    return {
      startMs: Math.min(startMs, laid.endMs),
      endMs: laid.endMs,
      hidden: startMs >= laid.endMs,
    }
  }
  /** The part a selection names for a clip: its first. */
  const headOf = (laid: LaidClip) => partsOf(laid).find((part) => part.chain?.first) ?? laid

  // What each clip's block calls, the same functions in every render, which reach this render's.
  const latest = useRef<ClipHandlers | null>(null)
  latest.current = {
    press: (event, laid) => {
      if (event.button !== 0) return
      if (commandKey(event)) {
        startSelecting(event, laid)
        return
      }
      // A clip goes with the clips selected with it, and as a whole: every part of it.
      const together = chosen.length > 1 && chosenKeys.has(chainKey(laid))
      const group = together ? chosen.flatMap(partsOf) : partsOf(laid)
      startDrag(event, {
        type: "move",
        clip: laid,
        ...(group.length > 1 ? { group } : {}),
        x: event.clientX,
        startMs: laid.startMs,
        moved: false,
      })
    },
    trim: (event, laid, edge) => {
      // With the command key, a press on an edge selects, as anywhere else on the clip.
      if (commandKey(event)) {
        startSelecting(event, laid)
        return
      }
      startDrag(event, {
        type: "trim",
        clip: laid,
        edge,
        x: event.clientX,
        atMs: edge === "start" ? laid.startMs : laid.endMs,
      })
    },
    select: (laid) => edits.select(selectionOfClip(headOf(laid))),
    ...dragHandlers,
  }
  const clipHandlers = useMemo<ClipHandlers>(
    () => ({
      press: (event, laid) => latest.current?.press(event, laid),
      trim: (event, laid, edge) => latest.current?.trim(event, laid, edge),
      select: (laid) => latest.current?.select(laid),
      onPointerMove: (event) => latest.current?.onPointerMove(event),
      onPointerUp: (event) => latest.current?.onPointerUp(event),
      onPointerCancel: () => latest.current?.onPointerCancel(),
    }),
    []
  )

  // ── Layout ─────────────────────────────────────────────────────────

  // The clips selected, as their files are now, each as a whole, and those a drag moves.
  const chosen = chosenIn(clips, selection).map(headOf)
  const chosenKeys = new Set(chosen.map(chainKey))
  const movingKeys =
    drag?.type === "move" && drag.moved
      ? new Set([drag.clip, ...(drag.group ?? [])].map(clipKey))
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

  // Where each clip is drawn down the tracks, which a selection rectangle touches.
  const boxes: ClipBox<LaidClip>[] = []
  let tracksHeight = 0
  for (const track of tracks) {
    const height = ROW_PX[track.track]
    for (const laid of track.clips) {
      boxes.push({
        clip: laid,
        startMs: laid.startMs,
        endMs: laid.endMs,
        top: tracksHeight + rowTop(track.track, laid.row, track.rows) + 2,
        height: height - 4,
      })
    }
    tracksHeight += height * track.rows
  }

  // ── Selecting ──────────────────────────────────────────────────────

  const trackPoint = (event: ReactPointerEvent): TrackPoint => ({
    ms: msAt(event.clientX),
    y: event.clientY - (tracksArea.current?.getBoundingClientRect().top ?? 0),
  })

  /** A press with the command key, on a clip or between them: a click, or a rectangle dragged. */
  const startSelecting = (event: ReactPointerEvent, over?: LaidClip) => {
    event.stopPropagation()
    // Nothing of the page is selected as the rectangle grows.
    event.preventDefault()
    tracksArea.current?.setPointerCapture(event.pointerId)
    const at = trackPoint(event)
    setDrag({
      type: "marquee",
      from: at,
      to: at,
      over,
      before: selection,
      moved: false,
      touched: "",
    })
  }

  const onSelectingMove = (event: ReactPointerEvent) => {
    const current = dragRef.current
    if (current?.type !== "marquee") return
    const to = trackPoint(event)
    const moved =
      current.moved ||
      Math.abs(px(to.ms - current.from.ms)) > 3 ||
      Math.abs(to.y - current.from.y) > 3
    if (!moved) return

    // Each clip it touches a part of, as a whole.
    const touched = [
      ...new Map(
        inRectangle(boxes, current.from, to).map((laid) => [chainKey(laid), headOf(laid)])
      ).values(),
    ]
    const key = touched.map(clipKey).join("\n")
    setDrag({ ...current, to, moved, touched: key })
    if (key === current.touched && current.moved) return

    // What it touches joins what was selected, as the pointer goes.
    const before = chosenIn(clips, current.before).map(headOf)
    edits.select(
      choose([
        ...before,
        ...touched.filter((laid) => !before.some((each) => chainKey(each) === chainKey(laid))),
      ])
    )
  }

  const onSelectingEnd = () => {
    const current = dragRef.current
    if (current?.type !== "marquee") return
    dragRef.current = null
    setDrag(null)
    if (!current.moved && current.over) {
      edits.select(toggled(clips, current.before, headOf(current.over)))
    }
  }

  // The chapter selected, the one under the playhead, and where files dragged in would land.
  const chosenScene = selection?.type === "scene" ? selection.scene : undefined
  const playingScene = sceneAt(composition.scenes, timeMs)?.id
  const filesScene = filesAt === null ? undefined : sceneFor(composition.scenes, filesAt)

  /** Files dragged over the tracks: the instant they would land at, as the pointer goes. */
  const dropping = {
    onDragOver: (event: React.DragEvent) => {
      if (!edits.dropOver || !event.dataTransfer.types.includes("Files")) return
      edits.dropOver(msAt(event.clientX))
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) edits.dropOver?.(null)
    },
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
        {...dropping}
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
                    className="absolute inset-y-[3px]"
                    style={{
                      left: px(span.startMs),
                      width: Math.max(4, px(span.endMs - span.startMs)),
                    }}
                  >
                    <SceneBlock
                      scene={scene}
                      index={index}
                      count={composition.scenes.length}
                      open={chosenScene === scene.id}
                      playing={playingScene === scene.id}
                      agent={agentScenes.has(scene.id)}
                      people={people.get(scene.id) ?? []}
                      dragging={reorder?.id === scene.id}
                      length={formatLength(sceneEnd(scene) - scene.startMs)}
                      actions={edits.scene}
                      onPress={(event) =>
                        startReorder(event, scene.id, () => edits.scene.select(scene))
                      }
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

          {/* The tracks, where the command key draws a selection rectangle over the clips. */}
          <div
            ref={tracksArea}
            data-video-tracks=""
            className="relative select-none"
            onPointerMove={onSelectingMove}
            onPointerUp={onSelectingEnd}
            onPointerCancel={() => {
              if (dragRef.current?.type === "marquee") setDrag(null)
            }}
          >
            {/* Where each chapter starts, faint across the tracks, under the clips. */}
            {composition.scenes.map((scene, index) =>
              index === 0 ? null : (
                <span
                  key={scene.id}
                  aria-hidden="true"
                  data-chapter-edge={scene.id}
                  className="pointer-events-none absolute inset-y-0 w-px bg-foreground/[0.09] dark:bg-foreground/[0.13]"
                  style={{ left: LABELS_PX + px(scene.startMs) }}
                />
              )
            )}
            {tracks.map((track) => (
              <Row
                key={track.id}
                label={track.label}
                icon={trackIcon(track.track)}
                height={ROW_PX[track.track] * track.rows}
                onBackground={(event) => {
                  if (commandKey(event)) {
                    startSelecting(event)
                    return
                  }
                  edits.select(null)
                  edits.seek(msAt(event.clientX), "commit")
                }}
              >
                {track.clips.map((laid) => {
                  const key = clipKey(laid)
                  const moving = drag?.type === "move" && movingKeys?.has(key) ? drag : null
                  // A trim cuts every part of the clip it trims as one, and hides a part it passes.
                  const trimming =
                    drag?.type === "trim" && chainKey(drag.clip) === chainKey(laid) ? drag : null
                  // The clip dragged where it is dragged; the others selected with it as far.
                  const movedTo = moving
                    ? sameClip(moving.clip, laid)
                      ? moving.startMs
                      : laid.startMs + moving.startMs - moving.clip.startMs
                    : undefined
                  const trimmed = trimming ? trimmedPart(laid, trimming) : undefined
                  const start = movedTo ?? trimmed?.startMs ?? laid.startMs
                  const end =
                    movedTo !== undefined
                      ? movedTo + laid.endMs - laid.startMs
                      : (trimmed?.endMs ?? laid.endMs)
                  return (
                    <ClipBlock
                      key={key}
                      laid={laid}
                      selected={chosenKeys.has(chainKey(laid))}
                      dragging={!!moving || !!trimming}
                      hidden={trimmed?.hidden === true}
                      left={px(start)}
                      width={Math.max(6, px(end - start))}
                      top={rowTop(track.track, laid.row, track.rows)}
                      height={ROW_PX[track.track]}
                      target={target}
                      zoom={zoom}
                      viewStartMs={start}
                      handlers={clipHandlers}
                    />
                  )
                })}
                {uploads
                  .filter((upload) => upload.track === track.track && track.id !== "soundtrack")
                  .map((upload) => (
                    <div
                      key={upload.id}
                      className="absolute inset-y-1 overflow-hidden rounded-md border border-dashed border-primary/60 bg-primary/10"
                      style={{
                        left: px(upload.startMs),
                        width: Math.max(24, px(upload.durationMs)),
                      }}
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
            {drag?.type === "marquee" && drag.moved ? (
              <Marquee
                left={LABELS_PX + px(Math.min(drag.from.ms, drag.to.ms))}
                right={LABELS_PX + px(Math.max(drag.from.ms, drag.to.ms))}
                top={Math.max(0, Math.min(drag.from.y, drag.to.y))}
                bottom={Math.min(tracksHeight, Math.max(drag.from.y, drag.to.y))}
                // Never over the track names, which stay on the left as the timeline scrolls.
                minLeft={LABELS_PX + (scroller.current?.scrollLeft ?? 0)}
              />
            ) : null}
          </div>

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

          {/* Where files dragged over the tracks would land, and in which chapter. */}
          {filesAt !== null && filesScene ? (
            <span
              aria-hidden="true"
              data-drop-at=""
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 -translate-x-1/2 bg-primary"
              style={{ left: LABELS_PX + px(filesAt) }}
            >
              <span
                className="absolute left-1.5 rounded-md bg-primary px-2 py-1 text-[11px] font-medium whitespace-nowrap text-primary-foreground shadow-md"
                style={{ top: ROW_PX.ruler + ROW_PX.scenes + 6 }}
              >
                {messages.dropHere(sceneName(filesScene))}
              </span>
            </span>
          ) : null}

          {/* The playhead, its knob on the ruler. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-500"
            style={{ left: LABELS_PX + px(timeMs) }}
          >
            <span
              className="absolute -top-px h-3 rounded-b-sm bg-red-500"
              style={{ left: -Math.floor(KNOB_PX / 2), width: KNOB_PX }}
            />
          </span>
        </div>
      </div>
    </section>
  )
}

/** The rectangle the command key draws over the tracks, in pixels of the timeline's content. */
function Marquee({
  left,
  right,
  top,
  bottom,
  minLeft,
}: {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly minLeft: number
}) {
  const from = Math.max(left, minLeft)
  return (
    <span
      aria-hidden="true"
      data-marquee=""
      className="pointer-events-none absolute z-[15] rounded-[3px] border border-primary/80 bg-primary/10"
      style={{
        left: from,
        width: Math.max(0, right - from),
        top,
        height: Math.max(0, bottom - top),
      }}
    />
  )
}

/**
 * Where a row is drawn down its track: on the picture and text tracks from the foot, so a clip
 * painted over another lies above it; sounds from the top.
 */
function rowTop(track: VideoTrack, row: number, rows: number): number {
  const height = ROW_PX[track]
  return track === "sound" ? row * height : (rows - 1 - row) * height
}

/** The selection of one laid clip, as its file names it now. */
function selectionOfClip(laid: LaidClip): EditorSelection {
  return { type: "clip", file: laid.file, target: videoTarget(laid.clip) }
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
  rowRef,
  onBackground,
  children,
}: {
  readonly label: string
  readonly icon?: ReactNode
  readonly height: number
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
        className="relative flex-1"
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
          {/* Past the playhead's knob, so the time it rests on stays readable, 0:00 first. */}
          {tick.major ? (
            <span
              className="absolute bottom-3 text-[10px] whitespace-nowrap text-muted-foreground tabular-nums"
              style={{ left: Math.ceil(KNOB_PX / 2) + 2 }}
            >
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
 * Two chapters playing together, between them on the Chapters bar: a light band of their own,
 * hatched, which says how long they cross. It holds the first chapter's end, which a drag moves.
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
          className="group/sceneblock absolute inset-y-[3px] overflow-hidden rounded-[4px] bg-muted/40"
          style={{
            left,
            width: Math.max(4, width),
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, var(--foreground) 9%, transparent) 4px 5px)",
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

/**
 * A clip on its track. Drawn again only when one of its values changes: its handlers are the same
 * from one render to the next, so a drag redraws the blocks it moves, never the others.
 */
const ClipBlock = memo(function ClipBlock({
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
  hidden = false,
  handlers,
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
  /** Passed by a trim of its clip: kept, for the drag it may hold, but not seen. */
  readonly hidden?: boolean
  readonly handlers: ClipHandlers
}) {
  const messages = useArtifactMessages().videoEditor
  const dragHandlers = {
    onPointerMove: handlers.onPointerMove,
    onPointerUp: handlers.onPointerUp,
    onPointerCancel: handlers.onPointerCancel,
  }
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
  // Its edges trim it where the clip, as a whole, starts and ends, and only with room left to hold
  // it by the middle: a quarter of a narrow block each, none for one under 16 pixels.
  // A block being dragged keeps its handles, whatever the drag makes of it: one is held.
  const handle = width >= HANDLES_FROM_PX || dragging ? HANDLE_PX : width >= 16 ? width / 4 : 0
  const trimsStart = handle > 0 && (!laid.chain || laid.chain.first)
  const trimsEnd = handle > 0 && !laid.open && (!laid.chain || laid.chain.last)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={failed ? `${kind}, ${name}, ${messages.unreadable}` : `${kind}, ${name}`}
      data-timeline-clip={clip.ref}
      data-timeline-file={laid.file}
      data-failed={failed ? "" : undefined}
      className={cn(
        "group/clip absolute touch-none overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
        // A part against the part before or after it is one block with it.
        laid.chain?.joinsBefore && "rounded-l-none",
        laid.chain?.joinsAfter && "rounded-r-none",
        failed
          ? "bg-[color-mix(in_oklab,var(--destructive)_10%,var(--background))] text-destructive"
          : TRACK_TONE[clip.track],
        selected
          ? "z-10 ring-2 ring-foreground ring-offset-1 ring-offset-background"
          : failed
            ? "ring-1 ring-destructive/45"
            : "ring-1 ring-black/10 dark:ring-white/10",
        dragging && "z-20 shadow-lg opacity-90",
        hidden && "opacity-0",
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
      onPointerDown={(event) => handlers.press(event, laid)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          handlers.select(laid)
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

      {/* Where it goes on from the part before it, at its chapter's edge. */}
      {laid.chain?.joinsBefore ? (
        <span
          aria-hidden="true"
          data-seam=""
          className="pointer-events-none absolute inset-y-1.5 left-0 w-px bg-current opacity-30"
        />
      ) : null}

      {trimsStart ? (
        <TrimHandle
          edge="start"
          width={handle}
          onPointerDown={(event) => handlers.trim(event, laid, "start")}
          {...dragHandlers}
        />
      ) : null}
      {trimsEnd ? (
        <TrimHandle
          edge="end"
          width={handle}
          onPointerDown={(event) => handlers.trim(event, laid, "end")}
          {...dragHandlers}
        />
      ) : null}
    </div>
  )
})

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
  width,
  onPointerDown,
  ...handlers
}: {
  readonly edge: "start" | "end"
  readonly width: number
  readonly onPointerDown: (event: ReactPointerEvent) => void
  readonly onPointerMove: (event: ReactPointerEvent) => void
  readonly onPointerUp: (event: ReactPointerEvent) => void
  readonly onPointerCancel: () => void
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-y-0 z-10 cursor-ew-resize touch-none bg-white/0 transition-colors hover:bg-white/35 group-aria-pressed/clip:bg-white/25",
        edge === "start" ? "left-0 rounded-l-md" : "right-0 rounded-r-md"
      )}
      style={{ width }}
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
