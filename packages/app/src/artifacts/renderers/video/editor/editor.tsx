import type { FrameVideoText, VideoOutline } from "@sixb/core/artifacts"
import {
  type ArtifactLiveUser,
  cutRange,
  duplicateScene,
  findVideoTarget,
  moveClip,
  moveClips,
  moveScene,
  removeClip,
  removeClips,
  removeMediaRanges,
  removeScene,
  setClipSound,
  setClipTiming,
  setSceneLabel,
  setSceneLength,
  setVideoText,
  splitClip,
  splitClips,
  trimClip,
  VIDEO_ENTRY,
  type VideoAnimationLeft,
  type VideoClip,
  type VideoClipTarget,
  type VideoEditResult,
  type VideoPlaceResult,
  type VideoScene,
  type VideoSources,
  videoTarget,
} from "@sixb/core/artifacts/live"
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Toggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  ArrowRightFromLine,
  ArrowRightToLine,
  FoldHorizontal,
  Info,
  Keyboard,
  Maximize2,
  Pause,
  Play,
  Plus,
  Scissors,
  SeparatorVertical,
  SquareDashedMousePointer,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useLiveArtifactState } from "../../../live/hooks"
import { shareSelection, useLivePresence } from "../../../live/presence"
import type { LiveArtifact } from "../../../live/session"
import { liveVideoOf } from "../../../live/video"
import { useArtifactMessages } from "../../../messages"
import { formatClock } from "../../../playback"
import type { ArtifactVersion } from "../../../queries"
import { appleKeyboard, commandKey, typesItself } from "../keys"
import { useSize } from "../player"
import { useMediaImport } from "./import"
import { InPlaceEditor, type InPlaceText } from "./in-place"
import { Inspector, type InspectorActions } from "./inspector"
import type { MediaTarget } from "./media"
import { MobileScenes } from "./mobile"
import { editPoints, type LaidClip, nextEditPoint, openingSeek, sceneAt, sceneFor } from "./model"
import { readMagnetic, writeMagnetic } from "./preferences"
import { PlayMark, PreviewScreen, usePreview } from "./preview"
import {
  choose,
  chosenIn,
  clipName,
  type EditorSelection,
  everySceneClips,
  heardRecordings,
  laidClips,
  openEnd,
  sceneName,
  selectedClips,
  selectedScene,
  selectionOf,
  typedText,
} from "./selection"
import { Timeline, type ZoomControls } from "./timeline"
import { TranscriptTab } from "./transcript-panel"

// Editing a video: its picture and the selection's settings at the top, and the timeline at the
// foot, the whole video as one film, its scenes as chapters along its first bar. The chapter the
// reader works in, which the Transcript tab reads and Add media fills, is the one selected, else
// the one under the playhead. Every edit is a change to the live document, everyone's at once, and
// a step of the reader's undo; the Agent's own changes show as they land, and the chapter it is
// changing glows. On a phone, the chapters are a list to reorder, trim and retitle.

/** The widest editor laid out as on a phone. */
const COMPACT_WIDTH = 640

/** How long a refusal stays said. */
const NOTICE_MS = 5_000

/** What the editor says for a moment: a refusal, or what an edit could not take along. */
interface EditorNotice {
  readonly title: string
  readonly detail?: string
  readonly tone?: "warning" | "info"
}

/** The longest a clip's name is said in a notice, its words cut after. */
const NOTICE_NAME_LENGTH = 40

export default function VideoEditor({
  version,
  outline,
  live,
  start,
}: {
  readonly version: ArtifactVersion
  readonly outline: VideoOutline
  readonly live: LiveArtifact
  /** Where it opens, in seconds: the instant or scene its address names. */
  readonly start?: number
}) {
  const messages = useArtifactMessages().videoEditor
  const video = liveVideoOf(live)
  const state = useSyncExternalStore(video.subscribe, video.getState, video.getState)
  const liveState = useLiveArtifactState(live)
  const presence = useLivePresence(live)
  // The same object while the version is, so a clip's block is not drawn again for it.
  const target = useMemo<MediaTarget>(
    () => ({ artifactId: version.artifactId, version: version.version, files: version.files }),
    [version.artifactId, version.version, version.files]
  )

  const root = useRef<HTMLDivElement | null>(null)
  const { width } = useSize(root)
  const compact = width > 0 && width < COMPACT_WIDTH

  const { frame, playback, cover } = usePreview(version, outline, start)
  const timeMs = Math.round(playback.time * 1000)

  const [selection, setSelection] = useState<EditorSelection>(null)
  const [marks, setMarks] = useState<{ readonly in?: number; readonly out?: number }>({})
  const [magnetic, setMagnetic] = useState(readMagnetic)
  const [snapping, setSnapping] = useState(true)
  const [panel, setPanel] = useState<"inspector" | "transcript">("inspector")
  const [notice, setNotice] = useState<EditorNotice | null>(null)
  const [dropping, setDropping] = useState(false)
  // Where files dragged over the tracks would land; null over the rest of the editor.
  const [filesAt, setFilesAt] = useState<number | null>(null)
  // The animations already said to stay behind, each once while the editor is open.
  const told = useRef(new Set<string>())
  const [inPlace, setInPlace] = useState<InPlaceText | null>(null)
  // The click on the picture waiting for the frame's answer, by its own request.
  const picking = useRef<{
    readonly answer: (target: FrameVideoText | null) => void
    readonly timer: ReturnType<typeof setTimeout>
  } | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const composition = state.composition
  const scenes = composition?.scenes ?? []
  const playing = sceneAt(scenes, timeMs)
  const open = (composition ? selectedScene(composition, selection) : undefined) ?? playing
  // What the Transcript tab reads: the open chapter's clips and the video's own.
  const clips = useMemo(
    () => (composition ? laidClips(state, composition, open) : []),
    [state, composition, open]
  )
  // What the timeline shows, splits and steps through: every chapter's clips, where they play.
  const shown = useMemo(
    () => (composition ? everySceneClips(state, composition) : []),
    [state, composition]
  )
  // The clips selected, each in its file, and the one when it is alone.
  const picked = selectedClips(state, selection)
  const clip = picked.length === 1 ? picked[0] : undefined

  // What the others see this reader working on: the chapter they work in.
  const openSceneId = open?.id
  useEffect(() => {
    shareSelection(live, openSceneId ? [openSceneId] : [])
  }, [live, openSceneId])

  const agentScenes = useMemo(
    () => new Set(presence.agents.flatMap((agent) => agent.boards)),
    [presence.agents]
  )
  const people = useMemo(() => {
    const self = liveState.user?.id
    const byScene = new Map<string, ArtifactLiveUser[]>()
    for (const peer of presence.peers) {
      if (peer.user.id === self) continue
      for (const id of peer.selection) {
        const list = byScene.get(id) ?? []
        if (!list.some((user) => user.id === peer.user.id)) list.push(peer.user)
        byScene.set(id, list)
      }
    }
    return byScene
  }, [presence.peers, liveState.user?.id])

  // The picture lags the timeline until the change is saved, and the version read again; offline,
  // until the reader reconnects.
  const offline = liveState.connection === "offline"
  const updating =
    liveState.pending || (liveState.save !== null && liveState.save.revision > version.revision)

  // ── Edits ──────────────────────────────────────────────────────────

  const refuse = useCallback(
    (detail: string) => setNotice({ title: messages.refused, detail, tone: "warning" }),
    [messages.refused]
  )
  const edit = useCallback(
    (make: (sources: VideoSources) => VideoEditResult) => {
      const refused = video.apply(make)
      if (refused) refuse(refused)
      return refused === null
    },
    [video, refuse]
  )

  const { uploads, importFiles } = useMediaImport(video, (detail) =>
    setNotice({ title: detail, tone: "warning" })
  )

  /**
   * Makes an edit that places clips. A move's selection follows them to where they start now; a
   * clip whose animation stayed with its chapter is said once, kindly.
   */
  const place = (make: (sources: VideoSources) => VideoPlaceResult, follow: boolean) => {
    let result: VideoPlaceResult | undefined
    const made = edit((sources) => {
      result = make(sources)
      return result
    })
    if (!made || !result || !("edit" in result)) return

    const placed = result.clips ?? []
    if (follow && placed.length > 0) {
      setSelection(selectionOf(placed.map(({ file, clip }) => ({ file, target: clip }))))
    }
    tellAnimations(result.animationsLeft ?? [])
  }

  const tellAnimations = (left: readonly VideoAnimationLeft[]) => {
    const now = video.getState()
    const fresh = left.flatMap(({ clip, scene }) => {
      const found = findVideoTarget(now.timelines.get(clip.file)?.clips ?? [], clip.clip)
      if (Array.isArray(found)) return []

      const name = clipName(found as VideoClip)
      const key = `${scene}\n${name}`
      if (told.current.has(key)) return []
      told.current.add(key)
      const chapter = now.composition?.scenes.find((each) => each.id === scene)
      return [{ name, chapter: chapter ? sceneName(chapter) : scene }]
    })

    const [first] = fresh
    if (!first) return
    setNotice(
      fresh.length === 1
        ? {
            title: messages.keepsLook(shortName(first.name)),
            detail: messages.animationStays(first.chapter),
            tone: "info",
          }
        : { title: messages.keepLooks(fresh.length), detail: messages.animationsStay, tone: "info" }
    )
  }

  const offsetOf = (file: string) =>
    file === VIDEO_ENTRY ? 0 : (scenes.find((scene) => scene.src === file)?.startMs ?? 0)
  const endOf = (file: string) => (composition ? openEnd(composition, file) : undefined)

  const seek = (ms: number, mode: "drag" | "commit" = "commit") =>
    playback.seek(Math.max(0, ms) / 1000, mode)

  const openScene = (scene: VideoScene) => {
    setSelection({ type: "scene", scene: scene.id })
    const at = openingSeek(scene, timeMs, composition?.fps ?? outline.fps)
    if (at !== undefined) seek(at)
  }

  const sceneActions = {
    select: (scene: VideoScene) => openScene(scene),
    move: (scene: VideoScene, to: number) => edit((sources) => moveScene(sources, scene.id, to)),
    duplicate: (scene: VideoScene) => {
      let copy: string | undefined
      const made = edit((sources) => {
        const result = duplicateScene(sources, scene.id)
        copy = "scene" in result ? result.scene : undefined
        return result
      })
      if (made && copy) setSelection({ type: "scene", scene: copy })
    },
    remove: (scene: VideoScene) => {
      if (edit((sources) => removeScene(sources, scene.id))) setSelection(null)
    },
    rename: (scene: VideoScene, label: string) =>
      edit((sources) => setSceneLabel(sources, scene.id, label)),
    sceneLength: (scene: VideoScene, ms: number) =>
      edit((sources) => setSceneLength(sources, scene.id, ms)),
  }

  /** Splits a clip at the playhead; the second part is selected. */
  const splitAt = (file: string, target: VideoClip) => {
    let second: string | undefined
    const made = edit((sources) => {
      const result = splitClip(sources, file, videoTarget(target), timeMs - offsetOf(file), {
        ...(endOf(file) === undefined ? {} : { endMs: endOf(file) }),
      })
      second = "clip" in result ? result.clip : undefined
      return result
    })
    if (made && second) setSelection({ type: "clip", file, target: second })
  }

  /** Splits the clips selected together at the playhead; their second parts are selected. */
  const splitGroup = (group: readonly LaidClip[]) => {
    let seconds: readonly VideoClipTarget[] = []
    const made = edit((sources) => {
      const result = splitClips(
        sources,
        group.map((laid) => ({
          file: laid.file,
          clip: videoTarget(laid.clip),
          atMs: timeMs - offsetOf(laid.file),
          ...(endOf(laid.file) === undefined ? {} : { endMs: endOf(laid.file) }),
        }))
      )
      seconds = "edit" in result ? (result.clips ?? []) : []
      return result
    })
    if (made) setSelection(selectionOf(seconds.map(({ file, clip }) => ({ file, target: clip }))))
  }

  const removeGroup = (group: readonly { readonly file: string; readonly clip: VideoClip }[]) => {
    const removed = edit((sources) =>
      removeClips(
        sources,
        group.map((laid) => ({
          file: laid.file,
          clip: videoTarget(laid.clip),
          ...(endOf(laid.file) === undefined ? {} : { endMs: endOf(laid.file) }),
        })),
        { ripple: magnetic }
      )
    )
    if (removed) setSelection(null)
  }

  const removeSelected = (laid: { readonly file: string; readonly clip: VideoClip }) => {
    const endMs = endOf(laid.file)
    if (
      edit((sources) =>
        removeClip(sources, laid.file, videoTarget(laid.clip), {
          ripple: magnetic,
          ...(endMs === undefined ? {} : { endMs }),
        })
      )
    ) {
      setSelection(null)
    }
  }

  const inspectorActions: InspectorActions = {
    renameScene: sceneActions.rename,
    sceneLength: sceneActions.sceneLength,
    duplicateScene: sceneActions.duplicate,
    removeScene: sceneActions.remove,
    clipTiming: (file, target, timing) =>
      edit((sources) => setClipTiming(sources, file, videoTarget(target), timing)),
    clipSound: (file, target, sound) =>
      edit((sources) => setClipSound(sources, file, videoTarget(target), sound)),
    text: (file, text, words) => edit((sources) => setVideoText(sources, file, text, words)),
    clipText: (file, target, text) => {
      const words = typedText(state.timelines.get(file), target)
      if (words) edit((sources) => setVideoText(sources, file, videoTarget(words), text))
    },
    removeClip: (file, target) => removeSelected({ file, clip: target }),
    splitClip: (file, target) => splitAt(file, target),
    splitClips: () => splitNow(),
    removeClips: () => removeGroup(picked),
  }

  /** The clip the playhead splits: the one selected when it is under it, else the picture on top. */
  const splitTarget = (): LaidClip | undefined => {
    const under = shown.filter((laid) => laid.startMs + 100 <= timeMs && timeMs <= laid.endMs - 100)
    const chosen = clip
      ? under.find((laid) => laid.file === clip.file && laid.clip.ref === clip.clip.ref)
      : undefined
    return (
      chosen ??
      under.filter((laid) => laid.track === "picture" && laid.file !== VIDEO_ENTRY).at(-1) ??
      under.find((laid) => laid.file !== VIDEO_ENTRY)
    )
  }

  /** The clips selected together that the playhead is inside, which S splits. */
  const groupUnder = (): LaidClip[] =>
    picked.length > 1
      ? chosenIn(shown, selection).filter(
          (laid) => laid.startMs + 100 <= timeMs && timeMs <= laid.endMs - 100
        )
      : []

  /** What S does: splits the clips selected together under the playhead, or the one it splits. */
  const splitNow = () => {
    if (picked.length > 1) {
      const under = groupUnder()
      if (under.length > 0) splitGroup(under)
      return
    }
    const laid = splitTarget()
    if (laid) splitAt(laid.file, laid.clip)
  }
  const canSplit = () => (picked.length > 1 ? groupUnder().length > 0 : !!splitTarget())

  /** Cuts the marked range out of the video, from every scene it spans. */
  const cutMarks = () => {
    if (marks.in === undefined || marks.out === undefined) return false
    const range = { startMs: Math.min(marks.in, marks.out), endMs: Math.max(marks.in, marks.out) }
    if (edit((sources) => cutRange(sources, range))) setMarks({})
    return true
  }

  const deleteSelection = () => {
    if (marks.in !== undefined && marks.out !== undefined) {
      cutMarks()
      return
    }
    if (picked.length > 1) {
      removeGroup(picked)
      return
    }
    if (clip) {
      removeSelected(clip)
      return
    }
    if (selection?.type === "scene") {
      const scene = scenes.find((each) => each.id === selection.scene)
      if (scene && scenes.length > 1) sceneActions.remove(scene)
    }
  }

  /**
   * A click on the paused picture: the words the frame finds there open to be typed over, as a
   * scene's file holds them; anywhere else, the video plays.
   */
  const pick = (point: { readonly x: number; readonly y: number }) => {
    if (inPlace) {
      setInPlace(null)
      return
    }
    // A click before the last one's answer replaces it, and the first answer then serves it once.
    if (picking.current) clearTimeout(picking.current.timer)
    const request = {
      timer: setTimeout(() => {
        if (picking.current !== request) return
        picking.current = null
        playback.toggle()
      }, 400),
      answer: (target: FrameVideoText | null) => {
        if (picking.current !== request) return
        clearTimeout(request.timer)
        picking.current = null
        const found = target && composition ? textOf(target) : null
        if (found) setInPlace(found)
        else playback.toggle()
      },
    }
    picking.current = request
    frame.current?.send("video.pick", point).catch(() => {})
  }

  /**
   * The text of a scene's file the frame found, by its words and their place among the same; none
   * for words of a composition the editor does not open, or no longer where the frame saw them.
   */
  const textOf = (target: FrameVideoText): InPlaceText | null => {
    const file = target.scene ? scenes.find((scene) => scene.id === target.scene)?.src : VIDEO_ENTRY
    if (!file) return null
    const same = (state.timelines.get(file)?.texts ?? []).filter(
      (text) => text.tag === target.tag && text.text === target.text
    )
    const text = same[target.occurrence]
    return text
      ? { file, ref: text.ref, target: videoTarget(text), text: text.text, rect: target.rect }
      : null
  }

  useEffect(() => {
    if (playback.playing) setInPlace(null)
  }, [playback.playing])

  // ── Keys ───────────────────────────────────────────────────────────

  const onKey = (event: KeyboardEvent) => {
    if (typesItself(event.target, event.key)) return
    const active = document.activeElement
    if (active && active !== document.body && !root.current?.contains(active)) return
    if (active?.closest("[role=menu], [role=dialog], [data-transcript]")) return

    const command = commandKey(event)
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    const frameMs = 1000 / (composition?.fps ?? 30)
    const handled = (): void => event.preventDefault()

    if (command) {
      if (key === "z") {
        handled()
        if (event.shiftKey) video.redo()
        else video.undo()
      } else if (key === "y") {
        handled()
        video.redo()
      } else if (key === "d" && open) {
        handled()
        sceneActions.duplicate(open)
      } else if (key === "a") {
        handled()
        setSelection(choose(shown))
      }
      return
    }
    // The other modifier, Ctrl on a Mac and ⌘ elsewhere, leaves the keys to the system.
    if (event.altKey || event.metaKey || event.ctrlKey) return

    switch (key) {
      case " ":
      case "k":
        handled()
        playback.toggle()
        return
      case "j":
        handled()
        seek(timeMs - 1000)
        return
      case "l":
        handled()
        seek(timeMs + 1000)
        return
      case "ArrowLeft":
      case "ArrowRight": {
        handled()
        if (playback.playing) playback.pause()
        const by = event.shiftKey ? 1000 : frameMs
        seek(timeMs + (key === "ArrowLeft" ? -by : by))
        return
      }
      case "ArrowUp":
      case "ArrowDown": {
        if (!composition) return
        handled()
        const point = nextEditPoint(
          editPoints(composition, shown),
          timeMs,
          key === "ArrowUp" ? -1 : 1
        )
        if (point !== undefined) seek(point)
        return
      }
      case "Home":
        handled()
        seek(0)
        return
      case "End":
        handled()
        seek(composition?.durationMs ?? 0)
        return
      case "i":
        handled()
        setMarks((current) => ordered({ ...current, in: timeMs }))
        return
      case "o":
        handled()
        setMarks((current) => ordered({ ...current, out: timeMs }))
        return
      case "s":
        handled()
        splitNow()
        return
      case "Delete":
      case "Backspace":
        handled()
        deleteSelection()
        return
      case "Escape":
        if (marks.in !== undefined || marks.out !== undefined) setMarks({})
        else setSelection(null)
        return
    }
  }
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) keyRef.current(event)
    }
    window.addEventListener("keydown", listen)
    return () => window.removeEventListener("keydown", listen)
  }, [])

  // ── Layout ─────────────────────────────────────────────────────────

  if (!composition) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <TriangleAlert className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="m-0 text-sm font-medium">{messages.broken}</p>
        {state.error ? (
          <p className="m-0 max-w-md text-[13px] text-muted-foreground">{state.error}</p>
        ) : null}
      </div>
    )
  }

  const length = (ms: number) => `${formatTenths(ms)} ${messages.seconds}`
  const banner = state.error ? (
    <Banner tone="warning">
      {messages.broken}: {state.error}
    </Banner>
  ) : open && agentScenes.has(open.id) ? (
    <Banner tone="agent">{messages.agentConflict}</Banner>
  ) : null

  /** Where Add media, or files dropped on the picture, land: the open chapter, at the playhead. */
  const atPlayhead = () =>
    open
      ? {
          file: open.src,
          sceneStartMs: open.startMs,
          atMs: Math.min(Math.max(0, timeMs - open.startMs), open.durationMs),
        }
      : undefined

  /** Where files dropped on the tracks land: at that instant, in the chapter there. */
  const atInstant = (ms: number) => {
    const chapter = sceneFor(scenes, ms)
    return chapter
      ? {
          file: chapter.src,
          sceneStartMs: chapter.startMs,
          atMs: Math.max(0, ms - chapter.startMs),
        }
      : undefined
  }

  const drop = {
    onDragOver: (event: React.DragEvent) => {
      if (compact || !event.dataTransfer.types.includes("Files")) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
      setDropping(true)
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDropping(false)
      setFilesAt(null)
    },
    onDrop: (event: React.DragEvent) => {
      if (compact) return
      event.preventDefault()
      const at = filesAt === null ? atPlayhead() : atInstant(filesAt)
      setDropping(false)
      setFilesAt(null)
      if (at) void importFiles([...event.dataTransfer.files], at)
    },
  }

  if (compact) {
    return (
      <div
        ref={root}
        data-sixb-artifact=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
      >
        <PreviewScreen
          version={version}
          outline={outline}
          frame={frame}
          cover={cover}
          playback={playback}
          updating={updating}
          offline={offline}
          compact
        >
          {!playback.playing && playback.phase === "ready" ? (
            <PlayMark onPlay={playback.play} />
          ) : null}
        </PreviewScreen>
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2 text-xs text-muted-foreground tabular-nums">
          <span>{formatClock(playback.time)}</span>
          <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="absolute inset-y-0 left-0 bg-foreground/70"
              style={{ width: `${(timeMs / Math.max(1, composition.durationMs)) * 100}%` }}
            />
          </span>
          <span>{formatClock(composition.durationMs / 1000)}</span>
        </div>
        {banner}
        {notice ? <Notice notice={notice} onClose={() => setNotice(null)} /> : null}
        <MobileScenes
          composition={composition}
          timelines={state.timelines}
          target={target}
          open={selection?.type === "scene" ? selection.scene : undefined}
          playing={playing?.id}
          agentScenes={agentScenes}
          actions={{
            select: (scene) => {
              if (selection?.type === "scene" && selection.scene === scene.id) setSelection(null)
              else openScene(scene)
            },
            move: sceneActions.move,
            sceneLength: sceneActions.sceneLength,
            duplicate: sceneActions.duplicate,
            remove: sceneActions.remove,
            text: inspectorActions.text,
            removeClip: (file, target) =>
              edit((sources) =>
                // On a phone, a clip goes and leaves its time: nothing else moves.
                removeClip(sources, file, videoTarget(target), {
                  ripple: false,
                  ...(endOf(file) === undefined ? {} : { endMs: endOf(file) }),
                })
              ),
          }}
        />
      </div>
    )
  }

  // What the Transcript tab reads: the recordings heard in the open scene, and the selected clip's.
  const heard = heardRecordings(clips, open, timeMs)
  const selectedRecording =
    clip && (clip.clip.kind === "video" || clip.clip.kind === "audio") && clip.clip.src
      ? {
          src: clip.clip.src,
          file: clip.file,
          clips: clips.filter((laid) => laid.file === clip.file && laid.clip.src === clip.clip.src),
        }
      : undefined
  const splittable =
    picked.length > 1
      ? groupUnder().length > 0
      : !!clip && splitTarget()?.clip.ref === clip.clip.ref && splitTarget()?.file === clip.file

  return (
    <div
      ref={root}
      data-sixb-artifact=""
      aria-label={messages.region(version.title)}
      role="region"
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      {...drop}
    >
      <div className="flex min-h-0 flex-1 border-b border-border">
        <div className="flex min-w-0 flex-1 flex-col bg-muted/30 p-4">
          <PreviewScreen
            version={version}
            outline={outline}
            frame={frame}
            cover={cover}
            playback={playback}
            updating={updating}
            offline={offline}
            onPick={pick}
            onFrameEvent={(event) => {
              if (event.event === "video.picked") picking.current?.answer(event.params.target)
            }}
          >
            {inPlace ? (
              <InPlaceEditor
                key={`${inPlace.file}#${inPlace.ref}`}
                target={inPlace}
                onClose={() => setInPlace(null)}
                onCommit={(text) =>
                  edit((sources) => setVideoText(sources, inPlace.file, inPlace.target, text))
                }
              />
            ) : null}
          </PreviewScreen>
        </div>

        <aside className="flex w-80 shrink-0 flex-col border-l border-border">
          <div
            role="tablist"
            className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2"
          >
            {(["inspector", "transcript"] as const).map((each) => (
              <button
                key={each}
                type="button"
                role="tab"
                aria-selected={panel === each}
                onClick={() => setPanel(each)}
                className={cn(
                  "h-8 rounded-md px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  panel === each
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {each === "inspector" ? messages.inspector : messages.transcript}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {panel === "inspector" ? (
              <Inspector
                composition={composition}
                timelines={state.timelines}
                scene={selectedScene(composition, selection)}
                clip={clip}
                clips={picked.length > 1 ? picked : undefined}
                splittable={splittable}
                target={target}
                actions={inspectorActions}
              />
            ) : (
              <div data-transcript="" className="flex min-h-0 flex-1 flex-col">
                <TranscriptTab
                  target={target}
                  scene={open?.id}
                  recordings={heard}
                  selected={selectedRecording}
                  timeMs={timeMs}
                  onSeek={(ms) => seek(ms)}
                  onRemove={(recording, ranges) => {
                    const endMs = endOf(recording.file)
                    edit((sources) =>
                      removeMediaRanges(sources, recording.file, recording.src, ranges, {
                        ...(endMs === undefined ? {} : { endMs }),
                      })
                    )
                  }}
                />
              </div>
            )}
          </div>
        </aside>
      </div>

      {banner}

      {/* A height of its own, so opening a scene with more rows never moves the picture. */}
      <div className="flex h-[min(45%,18.5rem)] min-h-[12rem] shrink-0 flex-col border-t border-border">
        <Timeline
          composition={composition}
          clips={shown}
          selection={selection}
          timeMs={timeMs}
          marks={marks}
          snapping={snapping}
          magnetic={magnetic}
          agentScenes={agentScenes}
          people={people}
          target={target}
          uploads={uploads}
          dropTarget={dropping}
          filesAt={dropping ? filesAt : null}
          formatLength={length}
          edits={{
            seek,
            select: setSelection,
            moveClip: (laid, startMs) =>
              place(
                (sources) =>
                  moveClip(
                    sources,
                    laid.file,
                    videoTarget(laid.clip),
                    startMs - offsetOf(laid.file)
                  ),
                true
              ),
            moveClips: (group, deltaMs) =>
              place(
                (sources) =>
                  moveClips(
                    sources,
                    group.map((laid) => ({ file: laid.file, clip: videoTarget(laid.clip) })),
                    deltaMs
                  ),
                true
              ),
            trimClip: (laid, side, atMs) => {
              const endMs = endOf(laid.file)
              place(
                (sources) =>
                  trimClip(
                    sources,
                    laid.file,
                    videoTarget(laid.clip),
                    side,
                    atMs - offsetOf(laid.file),
                    {
                      ripple: magnetic,
                      ...(endMs === undefined ? {} : { endMs }),
                    }
                  ),
                false
              )
            },
            sceneLength: sceneActions.sceneLength,
            scene: sceneActions,
            dropOver: setFilesAt,
          }}
          toolbar={(zoom) => (
            <Toolbar
              playing={playback.playing}
              onToggle={playback.toggle}
              timeMs={timeMs}
              durationMs={composition.durationMs}
              canSplit={canSplit()}
              onSplit={splitNow}
              canDelete={
                picked.length > 0 ||
                selection?.type === "scene" ||
                (marks.in !== undefined && marks.out !== undefined)
              }
              onDelete={deleteSelection}
              marks={marks}
              onMarkIn={() => setMarks((current) => ordered({ ...current, in: timeMs }))}
              onMarkOut={() => setMarks((current) => ordered({ ...current, out: timeMs }))}
              onClearMarks={() => setMarks({})}
              onCutMarks={cutMarks}
              magnetic={magnetic}
              onMagnetic={(on) => {
                setMagnetic(on)
                writeMagnetic(on)
              }}
              snapping={snapping}
              onSnapping={setSnapping}
              zoom={zoom}
              onImport={(files) => {
                const at = atPlayhead()
                if (at) void importFiles(files, at)
              }}
              formatLength={length}
            />
          )}
        />
      </div>

      {/* Over the tracks, the timeline shows where files land; anywhere else, this says. */}
      {dropping && filesAt === null && open ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-background px-10 py-8 text-center shadow-xl">
            <Upload className="size-6 text-primary" aria-hidden="true" />
            <p className="m-0 text-sm font-semibold">{messages.dropHere(open.label ?? open.id)}</p>
            <p className="m-0 text-[13px] text-muted-foreground">{messages.dropHint}</p>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-50 flex justify-center px-4">
          <Notice notice={notice} onClose={() => setNotice(null)} floating />
        </div>
      ) : null}
    </div>
  )
}

/** Marks in order: in before out. */
function ordered(marks: { readonly in?: number; readonly out?: number }) {
  if (marks.in !== undefined && marks.out !== undefined && marks.in > marks.out) {
    return { in: marks.out, out: marks.in }
  }
  return marks
}

function formatTenths(ms: number): string {
  return String(Math.round(ms / 100) / 10)
}

/** A clip's name as a notice says it: its first words, when it is a long caption. */
function shortName(name: string): string {
  return name.length > NOTICE_NAME_LENGTH
    ? `${name.slice(0, NOTICE_NAME_LENGTH - 1).trimEnd()}…`
    : name
}

function Banner({
  tone,
  children,
}: {
  readonly tone: "warning" | "agent"
  readonly children: ReactNode
}) {
  return (
    <p
      role="status"
      className={cn(
        "m-0 flex items-center gap-2 border-t px-4 py-2 text-[13px]",
        tone === "warning"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "border-primary/20 bg-primary/5 text-foreground"
      )}
    >
      {children}
    </p>
  )
}

function Notice({
  notice,
  onClose,
  floating = false,
}: {
  readonly notice: EditorNotice
  readonly onClose: () => void
  readonly floating?: boolean
}) {
  const info = notice.tone === "info"
  return (
    <div
      role={info ? "status" : "alert"}
      className={cn(
        "pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13px] shadow-lg",
        floating
          ? "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
          : "mx-4 mt-3"
      )}
    >
      {info ? (
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium">{notice.title}</p>
        {notice.detail ? <p className="m-0 mt-0.5 text-muted-foreground">{notice.detail}</p> : null}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={useArtifactMessages().videoEditor.dismiss}
        className="-mt-0.5 -mr-1 grid size-6 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

function Toolbar({
  playing,
  onToggle,
  timeMs,
  durationMs,
  canSplit,
  onSplit,
  canDelete,
  onDelete,
  marks,
  onMarkIn,
  onMarkOut,
  onClearMarks,
  onCutMarks,
  magnetic,
  onMagnetic,
  snapping,
  onSnapping,
  zoom,
  onImport,
  formatLength,
}: {
  readonly playing: boolean
  readonly onToggle: () => void
  readonly timeMs: number
  readonly durationMs: number
  readonly canSplit: boolean
  readonly onSplit: () => void
  readonly canDelete: boolean
  readonly onDelete: () => void
  readonly marks: { readonly in?: number; readonly out?: number }
  readonly onMarkIn: () => void
  readonly onMarkOut: () => void
  readonly onClearMarks: () => void
  readonly onCutMarks: () => void
  readonly magnetic: boolean
  readonly onMagnetic: (on: boolean) => void
  readonly snapping: boolean
  readonly onSnapping: (on: boolean) => void
  readonly zoom: ZoomControls
  readonly onImport: (files: File[]) => void
  readonly formatLength: (ms: number) => string
}) {
  const messages = useArtifactMessages()
  const editor = messages.videoEditor
  const files = useRef<HTMLInputElement | null>(null)
  const marked = marks.in !== undefined && marks.out !== undefined

  // Narrower than its labels, as on a tablet or beside the comments, its buttons keep their icons
  // and say the rest in their tooltips; narrower still, the row scrolls rather than lose a control.
  return (
    <div className="@container/toolbar flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 [scrollbar-width:none]">
      <ToolButton label={playing ? messages.video.pause : messages.video.play} onClick={onToggle}>
        {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
      </ToolButton>
      <span className="mr-2 ml-1 shrink-0 text-[13px] whitespace-nowrap text-foreground tabular-nums">
        {clockTenths(timeMs)}
        <span className="text-muted-foreground"> / {clockTenths(durationMs)}</span>
      </span>

      <Divider />
      <ToolButton label={editor.splitHint} onClick={onSplit} disabled={!canSplit}>
        <Scissors />
      </ToolButton>
      <ToolButton label={editor.deleteHint} onClick={onDelete} disabled={!canDelete}>
        <Trash2 />
      </ToolButton>
      <ToolButton label={editor.markIn} onClick={onMarkIn} pressed={marks.in !== undefined}>
        <ArrowRightFromLine />
      </ToolButton>
      <ToolButton label={editor.markOut} onClick={onMarkOut} pressed={marks.out !== undefined}>
        <ArrowRightToLine />
      </ToolButton>
      {marked ? (
        <>
          <Button size="sm" variant="secondary" className="h-7 shrink-0 gap-1" onClick={onCutMarks}>
            <SquareDashedMousePointer />
            {editor.cutMarked(formatLength((marks.out ?? 0) - (marks.in ?? 0)))}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 @max-5xl/toolbar:px-1.5"
            title={editor.clearMarks}
            onClick={onClearMarks}
          >
            <X className="hidden @max-5xl/toolbar:block" aria-hidden="true" />
            <span className="@max-5xl/toolbar:sr-only">{editor.clearMarks}</span>
          </Button>
        </>
      ) : null}

      <Divider />
      <Button
        size="sm"
        variant="ghost"
        className="h-8 shrink-0 gap-1.5 @max-4xl/toolbar:px-2"
        title={editor.addMedia}
        onClick={() => files.current?.click()}
      >
        <Plus />
        <span className="@max-4xl/toolbar:sr-only">{editor.addMedia}</span>
      </Button>
      <input
        ref={files}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={(event) => {
          const chosen = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ""
          if (chosen.length > 0) onImport(chosen)
        }}
      />

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={magnetic}
              onPressedChange={onMagnetic}
              aria-label={editor.magnetic}
              className="h-8 gap-1.5 px-2 text-[13px]"
            >
              <FoldHorizontal />
              <span className="@max-4xl/toolbar:sr-only">{editor.magnetic}</span>
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>{editor.magneticHint}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={snapping}
              onPressedChange={onSnapping}
              aria-label={editor.snapping}
              className="h-8 gap-1.5 px-2 text-[13px]"
            >
              <SeparatorVertical />
              <span className="@max-4xl/toolbar:sr-only">{editor.snapping}</span>
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>{editor.snappingHint}</TooltipContent>
        </Tooltip>
        <Divider />
        <ToolButton label={editor.zoomOut} onClick={zoom.zoomOut} disabled={!zoom.canZoomOut}>
          <ZoomOut />
        </ToolButton>
        <ToolButton label={editor.zoomIn} onClick={zoom.zoomIn} disabled={!zoom.canZoomIn}>
          <ZoomIn />
        </ToolButton>
        <ToolButton label={editor.zoomFit} onClick={zoom.fit}>
          <Maximize2 />
        </ToolButton>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              title={editor.shortcuts}
              aria-label={editor.shortcuts}
              className="grid size-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
            >
              <Keyboard />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <h3 className="m-0 mb-2 text-sm font-semibold">{editor.shortcuts}</h3>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              {shortcuts(editor, appleKeyboard()).map(([keys, what]) => (
                <div key={keys} className="contents">
                  <dt className="font-mono text-xs text-foreground">{keys}</dt>
                  <dd className="m-0 text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

function ToolButton({
  label,
  onClick,
  disabled = false,
  pressed,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
  readonly pressed?: boolean
  readonly children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-md text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4",
            pressed && "bg-muted text-primary"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The editor's keys, each with what it does, with ⌘ on a Mac and Ctrl elsewhere. */
function shortcuts(
  messages: ReturnType<typeof useArtifactMessages>["videoEditor"],
  apple: boolean
): readonly (readonly [string, string])[] {
  const help = messages.shortcutHelp
  const command = apple ? "⌘" : "Ctrl+"
  return [
    [`${messages.space}, K`, help.play],
    ["J, L", help.skip],
    ["← →", help.frame],
    ["↑ ↓", help.edits],
    ["I, O", help.marks],
    ["S", help.split],
    ["⌫", help.delete],
    [apple ? "⌘Z, ⇧⌘Z" : "Ctrl+Z, Ctrl+Y", help.undo],
    [`${command}D`, help.duplicate],
    [messages.commandClicking(apple ? "⌘" : "Ctrl"), help.select],
    [`${command}A`, help.selectAll],
    [messages.escape, help.deselect],
    [messages.shiftDragging, help.free],
  ]
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
}

function clockTenths(ms: number): string {
  const tenths = Math.floor(ms / 100) % 10
  return `${formatClock(ms / 1000)}.${tenths}`
}
