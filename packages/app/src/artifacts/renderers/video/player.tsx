import type { VideoOutline, VideoOutlineScene } from "@sixb/core/artifacts"
import { Button, Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  Check,
  ListVideo,
  MessageSquare,
  MessageSquarePlus,
  Play,
  RotateCcw,
  TriangleAlert,
  VolumeX,
} from "lucide-react"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { useSharedGuest } from "../../../shared-session"
import { CommentModeHint } from "../../comments/commenting"
import type { CommentThread } from "../../comments/comments"
import { CommentsPanel } from "../../comments/panel"
import { useCopyFeedback } from "../../copy-feedback"
import { ArtifactFrame, type ArtifactFrameHandle } from "../../frame"
import { useArtifactMessages } from "../../messages"
import { formatClock, MEDIA_FRAME } from "../../playback"
import type { ArtifactVersion } from "../../queries"
import { artifactLink } from "../../target"
import { useArtifactView } from "../../view-context"
import { ChaptersPanel, chapterAt, chapterName } from "./chapters"
import { ThreadInstant, useVideoCommenting, VideoCommentPins } from "./comments"
import { ControlBar } from "./controls"
import { playerKeyAction, typesItself } from "./keys"
import { usePlayback } from "./playback"
import { Scrubber } from "./scrubber"

// Watching a video: its frame, played by HyperFrames' runtime at the composition's own size and
// scaled to the screen, letterboxed on the video's shade; the app's controls over its foot; its
// chapters and comments beside it, or in sheets on a phone.
//
// The frame takes no click of its own: what the reader clicks lands on the app's layer over it,
// which plays, pauses, or places a comment. So the player's keys, its controls and its comments
// stay the app's, wherever the reader's pointer is.

/**
 * How long the runtime has, once the frame loaded, to build the video's timeline. A runtime that
 * did not load, or stopped at its startup, is told at once by the frame; this bounds the rest, such
 * as a scene that never arrives.
 */
const START_TIMEOUT_MS = 20_000

/** How long the loading mark waits before showing, so a quick start shows none. */
const LOADING_DELAY_MS = 400

/** How long the controls stay after the pointer stops moving, while the video plays. */
const CONTROLS_IDLE_MS = 2_500

/** The widest player that is laid out as on a phone. */
const COMPACT_WIDTH = 640

export function VideoPlayer({
  version,
  outline,
  start,
}: {
  readonly version: ArtifactVersion
  readonly outline: VideoOutline
  /** Where the video opens, in seconds: an address's scene or instant. */
  readonly start: number
}) {
  const messages = useArtifactMessages().video
  const view = useArtifactView()
  const guest = useSharedGuest()

  const root = useRef<HTMLDivElement | null>(null)
  const screen = useRef<HTMLDivElement | null>(null)
  const picture = useRef<HTMLDivElement | null>(null)
  const frame = useRef<ArtifactFrameHandle | null>(null)

  // Each attempt loads the frame anew; Retry starts another, where the reader left off.
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState<number | null>(null)
  const [loaded, setLoaded] = useState<number | null>(null)
  const resumeAt = useRef(start)

  const window_ = useCallback(() => frame.current?.window() ?? null, [])
  const playback = usePlayback({
    frame: window_,
    key: String(attempt),
    fps: outline.fps,
    duration: outline.durationMs / 1000,
  })

  // Whether the reader has begun watching: played, or moved the playhead. Until then the video
  // shows a poster and a large play mark; from then on, a pause leaves the picture clean.
  const [begun, setBegun] = useState(false)
  useEffect(() => {
    if (playback.playing) setBegun(true)
  }, [playback.playing])

  // Once the runtime has built its timeline, the video goes where it opens. Opened at its start,
  // it shows its poster instead of a first frame its opening has not come into yet.
  const started = useRef<number | null>(null)
  useEffect(() => {
    if (playback.phase !== "ready" || started.current === attempt) return
    started.current = attempt
    if (resumeAt.current > 0) playback.seek(resumeAt.current)
    else if (!begun) playback.cue(posterAt(outline))
  }, [playback.phase, playback.seek, playback.cue, attempt, begun, outline])

  // A frame that loaded, but whose runtime never built the timeline, failed to start.
  useEffect(() => {
    if (loaded !== attempt || playback.phase !== "loading") return
    const timer = setTimeout(() => setFailed(attempt), START_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [loaded, attempt, playback.phase])

  const broken = failed === attempt || playback.phase === "failed"
  const retry = () => {
    resumeAt.current = playback.time
    setAttempt((current) => current + 1)
  }

  // Its size, which lays it out as on a phone, and the picture's, which scales the frame.
  const width = useWidth(root)
  const compact = width > 0 && width < COMPACT_WIDTH
  const box = useSize(picture)
  const scale = Math.min(box.width / outline.width, box.height / outline.height) || 0

  // Commenting, on the latest version only, as the API places comments on it.
  const commenting = useVideoCommenting({
    artifactId: view && version.version === view.latestVersion ? version.artifactId : null,
    title: version.title,
    revision: view?.revision ?? version.revision,
    outline,
  })
  const { setCommenting, setPanel: setCommentsPanel } = commenting

  // One panel at a time beside the video, or under it on a phone: its chapters, or its comments.
  // A phone, or a wide player, opens on its chapters, when it has more than one.
  const [chaptersOpen, setChaptersOpen] = useState(false)
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || width === 0) return
    opened.current = true
    if (outline.scenes.length > 1 && (width < COMPACT_WIDTH || width >= 1024)) {
      setChaptersOpen(true)
    }
  }, [outline.scenes.length, width])
  const showChapters = (open: boolean) => {
    setChaptersOpen(open)
    if (open) setCommentsPanel(false)
  }
  const showComments = (open: boolean) => {
    setCommentsPanel(open)
    if (open) setChaptersOpen(false)
  }
  // A comment just posted opens its panel, in the chapters' place.
  useEffect(() => {
    if (commenting.panel) setChaptersOpen(false)
  }, [commenting.panel])

  const fullscreen = useFullscreen(screen)
  // Filling the screen, the video shows alone: what opens beside it would not show.
  const filling = fullscreen.on || fullscreen.pseudo
  const [announcement, setAnnouncement] = useState("")
  const controls = useControlsShown(screen, playback.playing && !commenting.commenting)

  const chapter = chapterAt(outline, playback.time)
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
  const many = outline.scenes.length > 1

  const goTo = (seconds: number, say?: string) => {
    setBegun(true)
    playback.seek(seconds)
    if (say) setAnnouncement(say)
  }
  // The focus goes to the video, so Space plays the chapter rather than pressing it again.
  const goToChapter = (scene: VideoOutlineScene) => {
    goTo(scene.startMs / 1000, messages.chapterAnnounced(chapterName(scene)))
    screen.current?.focus({ preventScroll: true, focusVisible: false })
  }

  const placeComments = () => {
    if (!commenting.enabled) return
    if (!commenting.commenting) playback.pause()
    commenting.toggleCommenting()
  }
  const openThread = (thread: CommentThread) => {
    const at = thread.comment.anchor.at
    if (at !== undefined) {
      setBegun(true)
      playback.pause()
      playback.seek(at / 1000)
    }
    commenting.setActive(thread.comment.id)
    showComments(true)
  }

  // What the reader clicks on the video: a comment's place while commenting; else play or pause
  // with a mouse, and, under a finger, the controls shown or hidden, as phones' players do.
  const onPictureClick = (event: ReactPointerEvent<HTMLDivElement>) => {
    screen.current?.focus({ preventScroll: true, focusVisible: false })
    if (commenting.commenting) {
      const area = event.currentTarget.getBoundingClientRect()
      playback.pause()
      commenting.place(playback.time, {
        x: clamp((event.clientX - area.left) / area.width),
        y: clamp((event.clientY - area.top) / area.height),
      })
      return
    }
    if (commenting.draft) {
      commenting.cancelDraft()
      return
    }
    if (event.pointerType === "touch" && begun) {
      controls.toggle()
      return
    }
    playback.toggle()
  }

  const keyAction = (event: KeyboardEvent | ReactKeyboardEvent) => {
    if (typesItself(event.target, event.key)) return
    if (event.key === "Escape" && (commenting.draft || commenting.commenting)) {
      event.preventDefault()
      if (commenting.draft) commenting.cancelDraft()
      else setCommenting(false)
      return
    }

    const action = playerKeyAction(event, !playback.playing)
    if (!action) return
    event.preventDefault()
    controls.wake()
    switch (action.type) {
      case "toggle":
        playback.toggle()
        setAnnouncement(playback.playing ? messages.paused : messages.playing)
        return
      case "skip": {
        const to = Math.min(Math.max(playback.time + action.seconds, 0), playback.duration)
        goTo(to, messages.at(formatClock(to)))
        return
      }
      case "step":
        playback.pause()
        goTo(playback.time + action.frames / outline.fps)
        return
      case "start":
        goTo(0, messages.at(formatClock(0)))
        return
      case "end":
        goTo(playback.duration, messages.at(formatClock(playback.duration)))
        return
      case "mute":
        playback.setMuted(!playback.muted)
        setAnnouncement(playback.muted ? messages.unmuted : messages.muted)
        return
      case "fullscreen":
        fullscreen.toggle()
        return
      case "comment":
        placeComments()
        return
    }
  }
  usePageKeys(root, keyAction)

  // Scrubbing pauses the video, and playing goes on once the reader lets go.
  const resume = useRef(false)

  const { copied, copy } = useCopyFeedback()
  const copyLink =
    guest || !view
      ? null
      : () => {
          const seconds = Math.round(playback.time * 10) / 10
          copy(
            artifactLink(
              {
                type: "artifact",
                artifactId: version.artifactId,
                version: version.version,
                part: `t=${seconds}`,
              },
              view.latestVersion,
              location.origin
            )
          )
        }

  const loading = !broken && (playback.phase !== "ready" || !playback.loaded)
  const showLoading = useDelayed(loading, LOADING_DELAY_MS)
  const ratio = outline.width / outline.height

  const screenElement = (
    <div
      ref={screen}
      tabIndex={0}
      role="region"
      aria-label={messages.player(version.title)}
      aria-roledescription={messages.roleDescription}
      data-video-screen=""
      data-controls={controls.shown ? "" : undefined}
      onPointerMove={controls.onPointerMove}
      onPointerLeave={controls.onPointerLeave}
      className={cn(
        "@container group/screen relative isolate bg-neutral-950 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        fullscreen.on
          ? "size-full rounded-none"
          : compact
            ? "w-full shrink-0"
            : cn("rounded-xl", MEDIA_FRAME),
        fullscreen.pseudo && "fixed inset-0 z-[60] size-auto",
        !controls.shown && "cursor-none"
      )}
      style={
        filling
          ? undefined
          : compact
            ? { aspectRatio: String(ratio), maxHeight: "70vh" }
            : { aspectRatio: String(ratio), width: `min(100cqw, 100cqh * ${ratio})` }
      }
    >
      <div ref={picture} className="absolute inset-0 overflow-hidden rounded-[inherit]">
        <div
          className="absolute"
          style={{
            width: outline.width,
            height: outline.height,
            left: (box.width - outline.width * scale) / 2,
            top: (box.height - outline.height * scale) / 2,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            visibility: scale > 0 ? undefined : "hidden",
          }}
        >
          <ArtifactFrame
            key={attempt}
            version={version}
            title={version.title}
            handle={frame}
            sound
            className="size-full"
            onEvent={(event) => {
              if (event.event === "ready") setLoaded(attempt)
              // At once, rather than at the timeout: a runtime that did not load builds nothing.
              if (event.event === "failed" && playback.phase === "loading") setFailed(attempt)
            }}
            onFailure={() => setFailed(attempt)}
          />
        </div>
      </div>

      {/* The app's layer over the frame: it takes every click, and holds the comments' pins. */}
      <div
        className="absolute"
        data-video-picture=""
        style={{
          width: outline.width * scale,
          height: outline.height * scale,
          left: (box.width - outline.width * scale) / 2,
          top: (box.height - outline.height * scale) / 2,
        }}
      >
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0",
            commenting.commenting && "sixb-video-commenting",
            loading || broken ? "pointer-events-none" : null
          )}
          onPointerUp={(event) => {
            if (event.button === 0) onPictureClick(event)
          }}
          // A tap's mouse events follow its pointer's: its mousedown would take the focus back
          // from the comment field the tap just opened. The click above places the focus itself.
          onMouseDown={(event) => event.preventDefault()}
          onDoubleClick={() => {
            if (!commenting.commenting) fullscreen.toggle()
          }}
        />
        {commenting.enabled && !loading ? (
          <VideoCommentPins
            commenting={commenting}
            outline={outline}
            time={playback.time}
            width={outline.width * scale}
            height={outline.height * scale}
            onOpen={openThread}
          />
        ) : null}
      </div>

      {showLoading ? <Loading /> : null}
      {broken ? (
        <Failure
          unsupported={playback.phase === "failed"}
          onRetry={playback.phase === "failed" ? null : retry}
        />
      ) : null}

      {!loading && !broken && (!begun || playback.ended) && !commenting.commenting ? (
        <BigPlay
          label={playback.ended ? messages.replay : messages.play}
          replay={playback.ended}
          onClick={() => {
            screen.current?.focus({ preventScroll: true, focusVisible: false })
            playback.play()
          }}
        />
      ) : null}

      {playback.mediaFailed && !broken ? (
        <p
          role="status"
          className="pointer-events-none absolute top-3 right-3 z-20 m-0 flex h-8 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-medium text-white/90 ring-1 ring-white/15 backdrop-blur-md [&_svg]:size-3.5"
        >
          <TriangleAlert aria-hidden="true" />
          {messages.mediaFailed}
        </p>
      ) : null}

      {/* The menu it was copied from has closed: the picture says so. */}
      {copied ? (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 top-3 z-30 m-0 flex justify-center px-3"
        >
          <span className="flex h-8 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-medium text-white ring-1 ring-white/15 backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 [&_svg]:size-3.5">
            <Check aria-hidden="true" />
            {messages.linkCopied}
          </span>
        </p>
      ) : null}

      {playback.soundBlocked && !playback.muted ? (
        <button
          type="button"
          onClick={() => playback.setMuted(false)}
          className="absolute top-3 left-3 z-20 flex h-8 items-center gap-1.5 rounded-full bg-black/60 px-3 text-xs font-medium text-white ring-1 ring-white/15 backdrop-blur-md outline-none hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/80 [&_svg]:size-3.5"
        >
          <VolumeX aria-hidden="true" />
          {messages.soundBlocked}
        </button>
      ) : null}

      {commenting.commenting && !commenting.draft ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
          <CommentModeHint
            hint={touch ? messages.commentHintTouch : messages.commentHint}
            onExit={() => setCommenting(false)}
          />
        </div>
      ) : null}

      {/* Only the bar itself takes the pointer: the shade above it leaves the frame's clicks. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-20 rounded-b-[inherit] bg-gradient-to-t from-black/75 via-black/35 to-transparent pt-16 transition-opacity duration-300 motion-reduce:transition-none",
          controls.shown && !broken && !commenting.draft
            ? "opacity-100 *:pointer-events-auto"
            : "opacity-0"
        )}
      >
        <div onPointerEnter={controls.hold} onPointerLeave={controls.release}>
          <ControlBar
            playback={playback}
            chapter={many && chapter ? chapterName(chapter) : undefined}
            compact={compact}
            comments={
              commenting.enabled
                ? {
                    open: commenting.open,
                    placing: commenting.commenting,
                    panel: commenting.panel,
                    onPlace: placeComments,
                    onPanel: filling ? null : () => showComments(!commenting.panel),
                  }
                : null
            }
            chaptersOpen={chaptersOpen}
            onChapters={many && !filling ? () => showChapters(!chaptersOpen) : null}
            fullscreen={filling}
            onFullscreen={fullscreen.toggle}
            onCopyLink={copyLink}
            menuContainer={fullscreen.on ? screen.current : null}
            scrubber={
              <Scrubber
                outline={outline}
                time={playback.time}
                duration={playback.duration}
                playing={playback.playing}
                marks={commenting.marked.map(({ thread, seconds, label, excerpt }) => ({
                  id: thread.comment.id,
                  seconds,
                  label,
                  excerpt,
                  active: thread.comment.id === commenting.active,
                }))}
                onScrubStart={() => {
                  setBegun(true)
                  resume.current = playback.playing
                  if (playback.playing) playback.pause()
                }}
                onScrub={(seconds) => playback.seek(seconds, "drag")}
                onCommit={(seconds) => {
                  playback.seek(seconds)
                  if (resume.current) playback.play()
                  resume.current = false
                }}
                onMark={(id) => {
                  const thread = commenting.threads.find((each) => each.comment.id === id)
                  if (thread) openThread(thread)
                }}
              />
            }
          />
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )

  const panel =
    chaptersOpen && many ? (
      <ChaptersPanel
        outline={outline}
        current={chapter?.id}
        onSeek={goToChapter}
        onClose={() => setChaptersOpen(false)}
        inline={compact}
      />
    ) : commenting.enabled && commenting.panel ? (
      <CommentsPanel
        threads={commenting.threads}
        loading={commenting.loading}
        failed={commenting.failed}
        filter={commenting.filter}
        active={commenting.active}
        where={(thread) => <ThreadInstant thread={thread} outline={outline} />}
        emptyHint={messages.commentsEmptyHint}
        nameOf={commenting.nameOf}
        canManage={commenting.canManage}
        onFilter={commenting.setFilter}
        onActivate={(id) => {
          const thread = commenting.threads.find((each) => each.comment.id === id)
          if (thread) openThread(thread)
        }}
        onReply={commenting.reply}
        onResolve={commenting.resolve}
        onDelete={commenting.remove}
        onSend={commenting.send}
        onClose={() => setCommentsPanel(false)}
        inline={compact}
      />
    ) : null

  return (
    <div
      ref={root}
      data-sixb-artifact=""
      className="@container relative flex min-h-0 flex-1 overflow-hidden bg-background"
      onKeyDown={(event) => {
        if (!event.defaultPrevented) keyAction(event)
      }}
    >
      <div
        className={cn("flex min-w-0 flex-1 flex-col", compact ? null : "bg-muted/30 p-4 sm:p-8")}
      >
        {/* The screen stays one element across both layouts: its frame never loads again. */}
        <div
          className={
            compact
              ? "contents"
              : "flex size-full min-h-0 items-center justify-center [container-type:size]"
          }
        >
          {screenElement}
        </div>
        {compact ? (
          <>
            <CompactBar
              chapter={many && chapter ? chapter : undefined}
              index={chapter ? outline.scenes.indexOf(chapter) + 1 : 0}
              count={outline.scenes.length}
              comments={commenting.enabled ? commenting.open : null}
              placing={commenting.commenting}
              onPlace={placeComments}
              onComments={() => showComments(true)}
              onChapters={many ? () => showChapters(true) : null}
            />
            {panel}
          </>
        ) : null}
      </div>

      {compact ? null : panel}
    </div>
  )
}

/** Under a phone's video: the chapter playing, and what opens beside the video on a wide screen. */
function CompactBar({
  chapter,
  index,
  count,
  comments,
  placing,
  onPlace,
  onComments,
  onChapters,
}: {
  readonly chapter: VideoOutlineScene | undefined
  readonly index: number
  readonly count: number
  readonly comments: number | null
  readonly placing: boolean
  readonly onPlace: () => void
  readonly onComments: () => void
  readonly onChapters: (() => void) | null
}) {
  const messages = useArtifactMessages().video
  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        {chapter ? (
          <>
            <p className="m-0 text-xs text-muted-foreground tabular-nums">
              {messages.chapterOf(index, count)}
            </p>
            <p className="m-0 truncate text-sm font-medium text-foreground">
              {chapterName(chapter)}
            </p>
          </>
        ) : null}
      </div>
      {comments !== null ? (
        <>
          <Button
            variant={placing ? "default" : "outline"}
            size="icon"
            aria-label={messages.comment}
            aria-pressed={placing}
            onClick={onPlace}
            className="size-10 rounded-full"
          >
            <MessageSquarePlus />
          </Button>
          <Button
            variant="outline"
            onClick={onComments}
            aria-label={messages.commentsPanel(comments)}
            className="h-10 gap-1.5 rounded-full px-3.5"
          >
            <MessageSquare />
            {comments > 0 ? <span className="tabular-nums">{comments}</span> : null}
          </Button>
        </>
      ) : null}
      {onChapters ? (
        <Button
          variant="outline"
          onClick={onChapters}
          aria-label={messages.chapters}
          className="h-10 gap-1.5 rounded-full px-3.5"
        >
          <ListVideo />
          <span className="tabular-nums">{count}</span>
        </Button>
      ) : null}
    </div>
  )
}

/** The large play mark before the video first plays, and to play it again at its end. */
function BigPlay({
  label,
  replay,
  onClick,
}: {
  readonly label: string
  readonly replay: boolean
  readonly onClick: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <button
        type="button"
        aria-label={label}
        title={label}
        data-video-big-play=""
        onClick={onClick}
        className="pointer-events-auto grid size-16 place-items-center rounded-full bg-black/55 text-white shadow-[0_8px_32px_-8px_rgb(0_0_0/0.6)] ring-1 ring-white/20 backdrop-blur-md outline-none transition-transform duration-150 hover:scale-105 focus-visible:ring-2 focus-visible:ring-white active:scale-95 motion-reduce:transition-none @max-sm:size-14 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90"
      >
        {replay ? (
          <RotateCcw className="size-6" aria-hidden="true" />
        ) : (
          <Play className="ml-1 size-7 fill-current" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}

function Loading() {
  const messages = useArtifactMessages().video
  return (
    <div
      role="status"
      aria-label={messages.loading}
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      <Spinner className="size-7 text-white/70" />
    </div>
  )
}

/** The video could not start: why, and Retry when trying again may help. */
function Failure({
  unsupported,
  onRetry,
}: {
  readonly unsupported: boolean
  readonly onRetry: (() => void) | null
}) {
  const messages = useArtifactMessages().video
  return (
    <div
      role="alert"
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-neutral-950 px-6 text-center"
    >
      <p className="m-0 text-sm font-medium text-white">
        {unsupported ? messages.unsupported : messages.failed}
      </p>
      <p className="m-0 max-w-xs text-[13px] text-balance text-white/60">
        {unsupported ? messages.unsupportedDetail : messages.failedDetail}
      </p>
      {onRetry ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={onRetry}
          className="mt-1 bg-white text-neutral-950 hover:bg-white/90"
        >
          <RotateCcw />
          {messages.retry}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Whether the controls show: always while the video is paused, and while it plays until the
 * pointer rests a moment, unless it is over the controls or the focus is in them.
 */
function useControlsShown(screen: RefObject<HTMLDivElement | null>, playing: boolean) {
  const [active, setActive] = useState(true)
  const [held, setHeld] = useState(false)
  const [focused, setFocused] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const wake = useCallback(() => {
    setActive(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setActive(false), CONTROLS_IDLE_MS)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])

  // Once it plays, they go after a moment unless the reader moves.
  useEffect(() => {
    if (playing) wake()
  }, [playing, wake])

  // A key moves focus into them, and keeps them.
  useEffect(() => {
    const element = screen.current
    if (!element) return
    const update = () => {
      const inside = element.contains(document.activeElement) && element !== document.activeElement
      setFocused(inside && document.activeElement?.matches(":focus-visible") === true)
    }
    element.addEventListener("focusin", update)
    element.addEventListener("focusout", update)
    return () => {
      element.removeEventListener("focusin", update)
      element.removeEventListener("focusout", update)
    }
  }, [screen])

  return {
    shown: !playing || active || held || focused,
    wake,
    toggle: () => {
      if (active) {
        clearTimeout(timer.current)
        setActive(false)
      } else {
        wake()
      }
    },
    onPointerMove: (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse") wake()
    },
    onPointerLeave: (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse" && playing) setActive(false)
    },
    hold: () => setHeld(true),
    release: () => setHeld(false),
  }
}

/**
 * The page's keys go to the player while the pointer is over it and nothing else has the focus,
 * as they do while the focus is inside it.
 */
function usePageKeys(
  root: RefObject<HTMLDivElement | null>,
  onKey: (event: KeyboardEvent) => void
) {
  const handler = useRef(onKey)
  handler.current = onKey

  useEffect(() => {
    const element = root.current
    if (!element) return
    let pointed = false
    const enter = () => {
      pointed = true
    }
    const leave = () => {
      pointed = false
    }
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !pointed) return
      if (document.activeElement && document.activeElement !== document.body) return
      handler.current(event)
    }
    element.addEventListener("pointerenter", enter)
    element.addEventListener("pointerleave", leave)
    window.addEventListener("keydown", key)
    return () => {
      element.removeEventListener("pointerenter", enter)
      element.removeEventListener("pointerleave", leave)
      window.removeEventListener("keydown", key)
    }
  }, [root])
}

/**
 * Fullscreen for the video's screen. Where the browser has no fullscreen for it, as an iPhone, the
 * screen fills the window instead; turned sideways, it fills the phone.
 */
function useFullscreen(element: RefObject<HTMLDivElement | null>) {
  const [on, setOn] = useState(false)
  const [pseudo, setPseudo] = useState(false)

  useEffect(() => {
    const change = () => setOn(document.fullscreenElement === element.current)
    document.addEventListener("fullscreenchange", change)
    return () => document.removeEventListener("fullscreenchange", change)
  }, [element])

  // Esc leaves the window-filling screen, as it leaves fullscreen.
  useEffect(() => {
    if (!pseudo) return
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPseudo(false)
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [pseudo])

  const toggle = useCallback(() => {
    const target = element.current
    if (!target) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      return
    }
    if (pseudo) {
      setPseudo(false)
      return
    }
    if (!document.fullscreenEnabled || !target.requestFullscreen) {
      setPseudo(true)
      return
    }
    target
      .requestFullscreen()
      .then(() => {
        // A phone turns a wide video sideways, where it may.
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (orientation: string) => Promise<void>
        }
        if (matchMedia("(pointer: coarse)").matches) {
          void orientation.lock?.("landscape").catch(() => {})
        }
      })
      .catch(() => setPseudo(true))
  }, [element, pseudo])

  return { on, pseudo, toggle }
}

/** An element's width, as it changes. */
function useWidth(element: RefObject<HTMLElement | null>): number {
  return useSize(element).width
}

/** An element's size, as it changes. */
function useSize(element: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  // Before the first paint, so a phone never shows the wide layout first.
  useLayoutEffect(() => {
    const target = element.current
    if (!target) return
    const measure = () => setSize({ width: target.clientWidth, height: target.clientHeight })
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    return () => observer.disconnect()
  }, [element])
  return size
}

/** `value`, once it has held for `ms`; false at once. */
function useDelayed(value: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!value) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return shown
}

/** How far into its first scene a video without a poster shows before it plays. */
const POSTER_INTO_FIRST_SCENE = 0.7

/**
 * Where a video shows before it first plays: the instant its root's `data-poster` names, else most
 * of the way into its first scene, where its opening has come in, rather than its first frame,
 * which is often still blank.
 */
function posterAt(outline: VideoOutline): number {
  if (outline.posterMs !== undefined) return outline.posterMs / 1000

  const first = outline.scenes[0]
  return first ? (first.startMs + first.durationMs * POSTER_INTO_FIRST_SCENE) / 1000 : 0
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}
