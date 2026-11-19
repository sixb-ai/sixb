import type { FrameVideoText, VideoOutline } from "@sixb/core/artifacts"
import {
  type ArtifactLiveUser,
  cutRange,
  duplicateScene,
  moveClip,
  moveScene,
  removeClip,
  removeMediaRanges,
  removeScene,
  setClipSound,
  setClipTiming,
  setSceneLabel,
  setSceneLength,
  setVideoText,
  splitClip,
  trimClip,
  VIDEO_ENTRY,
  type VideoClip,
  type VideoEditResult,
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
  Keyboard,
  Magnet,
  Maximize2,
  Pause,
  Play,
  Plus,
  Scissors,
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
import { typesItself } from "../keys"
import { useSize } from "../player"
import { useMediaImport } from "./import"
import { InPlaceEditor, type InPlaceText } from "./in-place"
import { Inspector, type InspectorActions } from "./inspector"
import type { MediaTarget } from "./media"
import { MobileScenes } from "./mobile"
import { editPoints, type LaidClip, nextEditPoint, sceneAt } from "./model"
import { PlayMark, PreviewScreen, usePreview } from "./preview"
import { type EditorSelection, laidClips, openEnd, selectedClip, selectedScene } from "./selection"
import { Timeline, type ZoomControls } from "./timeline"
import { TranscriptPanel } from "./transcript-panel"

// Editing a video: its picture and the selection's settings at the top, and the timeline at the
// foot, its scenes along its first track. Every edit is a change to the live document, everyone's at once, and
// a step of the reader's undo; the Agent's own changes show as they land, and the scene it is
// changing glows. On a phone, the scenes are a list to reorder, trim and retitle.

/** The widest editor laid out as on a phone. */
const COMPACT_WIDTH = 640

/** How long a refusal stays said. */
const NOTICE_MS = 5_000

export default function VideoEditor({
  version,
  outline,
  live,
}: {
  readonly version: ArtifactVersion
  readonly outline: VideoOutline
  readonly live: LiveArtifact
}) {
  const messages = useArtifactMessages().videoEditor
  const video = liveVideoOf(live)
  const state = useSyncExternalStore(video.subscribe, video.getState, video.getState)
  const liveState = useLiveArtifactState(live)
  const presence = useLivePresence(live)
  const target: MediaTarget = { artifactId: version.artifactId, version: version.version }

  const root = useRef<HTMLDivElement | null>(null)
  const { width } = useSize(root)
  const compact = width > 0 && width < COMPACT_WIDTH

  const { frame, playback, cover } = usePreview(version, outline)
  const timeMs = Math.round(playback.time * 1000)

  const [selection, setSelection] = useState<EditorSelection>(null)
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [marks, setMarks] = useState<{ readonly in?: number; readonly out?: number }>({})
  const [magnetic, setMagnetic] = useState(true)
  const [snapping, setSnapping] = useState(true)
  const [panel, setPanel] = useState<"inspector" | "transcript">("inspector")
  const [notice, setNotice] = useState<{ readonly title: string; readonly detail?: string } | null>(
    null
  )
  const [dropping, setDropping] = useState(false)
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
  const open = composition
    ? (scenes.find((scene) => scene.id === openId) ??
      selectedScene(composition, selection) ??
      sceneAt(scenes, timeMs))
    : undefined
  const clips = useMemo(
    () => (composition ? laidClips(state, composition, open) : []),
    [state, composition, open]
  )
  const clip = selectedClip(state, selection)
  const playing = sceneAt(scenes, timeMs)

  // What the others see this reader working on: the scene open on the timeline.
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
    (detail: string) => setNotice({ title: messages.refused, detail }),
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

  const { uploads, importFiles } = useMediaImport(video, (detail) => setNotice({ title: detail }))

  const offsetOf = (file: string) =>
    file === VIDEO_ENTRY ? 0 : (scenes.find((scene) => scene.src === file)?.startMs ?? 0)
  const endOf = (file: string) => (composition ? openEnd(composition, file) : undefined)

  const seek = (ms: number, mode: "drag" | "commit" = "commit") =>
    playback.seek(Math.max(0, ms) / 1000, mode)

  const openScene = (scene: VideoScene, at = true) => {
    setOpenId(scene.id)
    setSelection({ type: "scene", scene: scene.id })
    if (at && (timeMs < scene.startMs || timeMs >= scene.startMs + scene.durationMs)) {
      seek(scene.startMs)
    }
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
      if (made && copy) {
        setOpenId(copy)
        setSelection({ type: "scene", scene: copy })
      }
    },
    remove: (scene: VideoScene) => {
      if (edit((sources) => removeScene(sources, scene.id))) {
        setSelection(null)
        setOpenId(undefined)
      }
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
      const words = state.timelines
        .get(file)
        ?.texts.find((each) => each.source.element.start === target.source.element.start)
      if (words) edit((sources) => setVideoText(sources, file, videoTarget(words), text))
    },
    removeClip: (file, target) => removeSelected({ file, clip: target }),
    splitClip: (file, target) => splitAt(file, target),
  }

  /** The clip the playhead splits: the one selected when it is under it, else the picture on top. */
  const splitTarget = (): LaidClip | undefined => {
    const under = clips.filter((laid) => laid.startMs + 100 <= timeMs && timeMs <= laid.endMs - 100)
    const chosen =
      clip && selection?.type === "clip"
        ? under.find((laid) => laid.file === selection.file && laid.clip.ref === clip.ref)
        : undefined
    return (
      chosen ??
      under.filter((laid) => laid.track === "picture" && laid.file !== VIDEO_ENTRY).at(-1) ??
      under.find((laid) => laid.file !== VIDEO_ENTRY)
    )
  }

  const cutMarks = () => {
    if (!open || marks.in === undefined || marks.out === undefined) return false
    const startMs = Math.max(marks.in, open.startMs) - open.startMs
    const endMs = Math.min(marks.out, open.startMs + open.durationMs) - open.startMs
    if (edit((sources) => cutRange(sources, open.src, { startMs, endMs }))) setMarks({})
    return true
  }

  const deleteSelection = () => {
    if (marks.in !== undefined && marks.out !== undefined) {
      cutMarks()
      return
    }
    if (clip && selection?.type === "clip") {
      removeSelected({ file: selection.file, clip })
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

    const command = event.metaKey || event.ctrlKey
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
      }
      return
    }
    if (event.altKey) return

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
          editPoints(composition, clips),
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
      case "s": {
        handled()
        const laid = splitTarget()
        if (laid) splitAt(laid.file, laid.clip)
        return
      }
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

  const drop = {
    onDragOver: (event: React.DragEvent) => {
      if (compact || !event.dataTransfer.types.includes("Files")) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
      setDropping(true)
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
    },
    onDrop: (event: React.DragEvent) => {
      if (compact || !open) return
      event.preventDefault()
      setDropping(false)
      void importFiles([...event.dataTransfer.files], {
        file: open.src,
        sceneStartMs: open.startMs,
        atMs: Math.min(Math.max(0, timeMs - open.startMs), open.durationMs),
      })
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

  const talking =
    clip && (clip.kind === "video" || clip.kind === "audio") && clip.src
      ? clip.src
      : clips.find(
          (laid) => laid.file !== VIDEO_ENTRY && laid.clip.kind === "video" && !laid.clip.silent
        )?.clip.src
  const splittable =
    !!clip &&
    selection?.type === "clip" &&
    splitTarget()?.clip.ref === clip.ref &&
    splitTarget()?.file === selection.file

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
                scene={
                  selection?.type === "scene" ? selectedScene(composition, selection) : undefined
                }
                clip={
                  clip && selection?.type === "clip" ? { file: selection.file, clip } : undefined
                }
                splittable={splittable}
                actions={inspectorActions}
              />
            ) : talking && open ? (
              <div data-transcript="" className="flex min-h-0 flex-1 flex-col">
                <TranscriptPanel
                  target={target}
                  src={talking}
                  clips={clips.filter(
                    (laid) => laid.clip.src === talking && laid.file === open.src
                  )}
                  timeMs={timeMs}
                  onSeek={(ms) => seek(ms)}
                  onRemove={(ranges) => {
                    const endMs = endOf(open.src)
                    edit((sources) =>
                      removeMediaRanges(sources, open.src, talking, ranges, {
                        ...(endMs === undefined ? {} : { endMs }),
                      })
                    )
                  }}
                />
              </div>
            ) : (
              <p className="m-0 p-4 text-[13px] text-muted-foreground">{messages.selectSpeech}</p>
            )}
          </div>
        </aside>
      </div>

      {banner}

      {/* A height of its own, so opening a scene with more rows never moves the picture. */}
      <div className="flex h-[min(45%,18.5rem)] min-h-[12rem] shrink-0 flex-col border-t border-border">
        <Timeline
          composition={composition}
          clips={clips}
          open={open}
          selection={selection}
          timeMs={timeMs}
          marks={marks}
          snapping={snapping}
          agentScenes={agentScenes}
          people={people}
          timelines={state.timelines}
          target={target}
          uploads={uploads}
          dropTarget={dropping}
          formatLength={length}
          edits={{
            seek,
            select: setSelection,
            open: (scene) => openScene(scene, false),
            moveClip: (laid, startMs) =>
              edit((sources) =>
                moveClip(sources, laid.file, videoTarget(laid.clip), startMs - offsetOf(laid.file))
              ),
            trimClip: (laid, side, atMs) => {
              const endMs = endOf(laid.file)
              edit((sources) =>
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
                )
              )
            },
            sceneLength: sceneActions.sceneLength,
            scene: sceneActions,
          }}
          toolbar={(zoom) => (
            <Toolbar
              playing={playback.playing}
              onToggle={playback.toggle}
              timeMs={timeMs}
              durationMs={composition.durationMs}
              canSplit={!!splitTarget()}
              onSplit={() => {
                const laid = splitTarget()
                if (laid) splitAt(laid.file, laid.clip)
              }}
              canDelete={
                !!clip ||
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
              onMagnetic={setMagnetic}
              snapping={snapping}
              onSnapping={setSnapping}
              zoom={zoom}
              onImport={(files) => {
                if (!open) return
                void importFiles(files, {
                  file: open.src,
                  sceneStartMs: open.startMs,
                  atMs: Math.min(Math.max(0, timeMs - open.startMs), open.durationMs),
                })
              }}
              formatLength={length}
            />
          )}
        />
      </div>

      {dropping && open ? (
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
  readonly notice: { readonly title: string; readonly detail?: string }
  readonly onClose: () => void
  readonly floating?: boolean
}) {
  return (
    <div
      role="alert"
      className={cn(
        "pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-xl border border-border bg-background px-3.5 py-2.5 text-[13px] shadow-lg",
        floating
          ? "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
          : "mx-4 mt-3"
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
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

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <ToolButton label={playing ? messages.video.pause : messages.video.play} onClick={onToggle}>
        {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
      </ToolButton>
      <span className="mr-2 ml-1 text-[13px] text-foreground tabular-nums">
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
          <Button size="sm" variant="secondary" className="h-7 gap-1" onClick={onCutMarks}>
            <SquareDashedMousePointer />
            {editor.cutMarked(formatLength((marks.out ?? 0) - (marks.in ?? 0)))}
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={onClearMarks}>
            {editor.clearMarks}
          </Button>
        </>
      ) : null}

      <Divider />
      <Button
        size="sm"
        variant="ghost"
        className="h-8 gap-1.5"
        onClick={() => files.current?.click()}
      >
        <Plus />
        {editor.addMedia}
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

      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={magnetic}
              onPressedChange={onMagnetic}
              aria-label={editor.magnetic}
              className="h-8 gap-1.5 px-2 text-[13px]"
            >
              <Magnet />
              {editor.magnetic}
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
              className="h-8 px-2 text-[13px]"
            >
              {editor.snapping}
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
              {shortcuts(editor).map(([keys, what]) => (
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
            "grid size-8 place-items-center rounded-md text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4",
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

/** The editor's keys, each with what it does. */
function shortcuts(
  messages: ReturnType<typeof useArtifactMessages>["videoEditor"]
): readonly (readonly [string, string])[] {
  const help = messages.shortcutHelp
  return [
    [`${messages.space}, K`, help.play],
    ["J, L", help.skip],
    ["← →", help.frame],
    ["↑ ↓", help.edits],
    ["I, O", help.marks],
    ["S", help.split],
    ["⌫", help.delete],
    ["⌘Z, ⇧⌘Z", help.undo],
    ["⌘D", help.duplicate],
    [messages.shiftDragging, help.free],
  ]
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
}

function clockTenths(ms: number): string {
  const tenths = Math.floor(ms / 100) % 10
  return `${formatClock(ms / 1000)}.${tenths}`
}
