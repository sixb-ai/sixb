import { Button, Slider } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Download, Pause, Play } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react"
import { useDerivedMedia } from "../derived-media"
import type { FileSource } from "../file-source"
import { useArtifactMessages } from "../messages"
import { useNearScreen } from "../near-screen"
import { formatClock, MEDIA_FRAME, revealDuration } from "../playback"
import { ViewerNotice } from "./notice"

// Video and sound files, played in place. Video keeps the browser's own controls, which already
// know fullscreen, picture in picture, captions, and touch; sound gets a compact player of its own.

/**
 * Where a video sits: `stage` fills a viewer on a neutral surface, `inline` runs in a column of
 * text, as wide as the column, and `fill` takes a box another artifact gave it.
 */
export type VideoLayout = "stage" | "inline" | "fill"

interface MediaProps {
  readonly source: FileSource
  /** The file's name as the reader sees it. */
  readonly name: string
}

/** The shape a video has until its own is read: most are 16:9. */
const DEFAULT_RATIO = 16 / 9

/**
 * The browser's player, at the video's own shape, its poster or its first frame showing until it
 * plays. An artifact's video plays from its proxy once Sixb derived one. A file the browser cannot
 * play says so, with its download; one that turns out to hold sound alone gets the sound player.
 */
export function VideoPlayer({ layout, ...props }: MediaProps & { readonly layout: VideoLayout }) {
  // Another file starts over: its shape, and whether it plays, are its own.
  return <Video key={props.source.id} layout={layout} {...props} />
}

function Video({ source, name, layout }: MediaProps & { readonly layout: VideoLayout }) {
  const [ratio, setRatio] = useState<number | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "soundOnly" | "failed">("loading")
  const derived = useDerivedMedia(source)

  if (state === "failed") return <MediaFailed source={source} name={name} kind="video" />
  if (state === "soundOnly") {
    return <AudioPlayer source={source} name={name} stage={layout === "stage"} />
  }

  const shape = ratio ?? DEFAULT_RATIO
  // Until it is known what plays, the quiet surface it loads on, at the shape most videos have.
  const video = !derived ? (
    <div
      className={cn(
        "bg-muted",
        layout === "fill" ? "size-full" : cn("mx-auto rounded-xl", MEDIA_FRAME)
      )}
      style={layout === "fill" ? undefined : videoSize(layout, shape)}
    />
  ) : (
    <video
      src={derived.proxy ?? firstFrameUrl(source)}
      poster={derived.poster}
      controls
      playsInline
      preload="metadata"
      aria-label={name}
      onLoadedMetadata={(event) => {
        const { videoWidth, videoHeight } = event.currentTarget
        if (videoWidth === 0 || videoHeight === 0) {
          setState("soundOnly")
          return
        }
        setRatio(videoWidth / videoHeight)
        revealDuration(event.currentTarget)
      }}
      onLoadedData={() => setState("ready")}
      onError={() => setState("failed")}
      className={cn(
        "block transition-colors duration-300",
        // A quiet surface until the first frame arrives, then black around the picture.
        state === "loading" ? "bg-muted" : "bg-black",
        layout === "fill" ? "size-full object-contain" : cn("mx-auto rounded-xl", MEDIA_FRAME)
      )}
      style={layout === "fill" ? undefined : videoSize(layout, shape)}
    />
  )

  if (layout !== "stage") return video
  return (
    <div className="flex min-h-0 flex-1 bg-muted/30 p-4 sm:p-8">
      {/* Sized as a container, so the video fits it whole, whichever side is tighter. */}
      <div className="flex size-full min-h-0 items-center justify-center [container-type:size]">
        {video}
      </div>
    </div>
  )
}

/**
 * A video's poster, under a play mark, for a card: once the card nears the screen, the one Sixb
 * derived of an artifact's video, else its first frame, of which the browser reads just enough of
 * the file to draw it. A file it cannot read, or one that holds sound alone, shows `fallback`.
 */
export function VideoPoster(props: PosterProps) {
  // Another file starts over: whether it has a frame to show is its own.
  return <Poster key={props.source.id} {...props} />
}

interface PosterProps {
  readonly source: FileSource
  readonly fallback: ReactNode
}

function Poster({ source, fallback }: PosterProps) {
  const box = useRef<HTMLSpanElement | null>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined")
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading")
  useNearScreen(box, "400px 0px", () => setNear(true), !near)
  const derived = useDerivedMedia(source, near)

  if (state === "fallback") return fallback

  const picture = {
    className: cn("size-full object-cover", state === "ready" ? "sixb-media-in" : "opacity-0"),
    "aria-hidden": true,
    onError: () => setState("fallback"),
  } as const
  return (
    <span
      ref={box}
      className={cn(
        "pointer-events-none absolute inset-0",
        state === "loading" ? "sixb-media-developing" : "bg-black"
      )}
    >
      {/* Until the card nears the screen, and what it shows is known, it keeps the surface the
          picture develops from. */}
      {!near || !derived ? null : derived.poster ? (
        <img src={derived.poster} alt="" onLoad={() => setState("ready")} {...picture} />
      ) : (
        <video
          src={firstFrameUrl(source)}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          onLoadedMetadata={(event) => {
            if (event.currentTarget.videoWidth === 0) setState("fallback")
          }}
          onLoadedData={() => setState("ready")}
          {...picture}
        />
      )}
      {state === "ready" ? (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-9 place-items-center rounded-full bg-black/45 text-white ring-1 ring-white/25 backdrop-blur-md">
            <Play className="ml-0.5 size-4 fill-current" />
          </span>
        </span>
      ) : null}
    </span>
  )
}

/**
 * The file's address with a media fragment, so that browsers that load nothing ahead, as Safari on
 * iOS, still read its first frame to show before it plays.
 */
function firstFrameUrl(source: FileSource): string {
  return `${source.inlineUrl}#t=0.001`
}

/**
 * As large as the space allows at the video's shape: the whole stage, or the column's width, never
 * taller than most of the screen, so a portrait clip in a reply does not run off it.
 */
function videoSize(layout: "stage" | "inline", ratio: number): CSSProperties {
  const width = layout === "stage" ? `min(100cqw, 100cqh * ${ratio})` : `min(100%, 70vh * ${ratio})`
  return { aspectRatio: String(ratio), width }
}

/**
 * A sound file as a compact player: play and pause, where it is, and how long it lasts, under its
 * name. On a stage, it sits in the middle of the viewer. An artifact's sound that browsers cannot
 * play, such as AIFF, plays from the proxy Sixb derived of it.
 */
export function AudioPlayer({
  source,
  name,
  stage = false,
}: MediaProps & { readonly stage?: boolean }) {
  const player = <Audio key={source.id} source={source} name={name} />
  if (!stage) return player
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4 sm:p-8">
      {player}
    </div>
  )
}

function Audio({ source, name }: MediaProps) {
  const messages = useArtifactMessages().files
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const derived = useDerivedMedia(source)

  // The position moves with each frame while it plays, not with the browser's few updates a second.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      setTime(audio.current?.currentTime ?? 0)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  if (failed) return <MediaFailed source={source} name={name} kind="audio" />

  const toggle = () => {
    const element = audio.current
    if (!element) return
    // A play the browser refuses, or a pause that interrupts it, leaves the button as it was.
    if (element.paused) void element.play().catch(() => {})
    else element.pause()
  }

  // How long it lasts, once the browser knows.
  const length = duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null
  const seek = (to: number) => {
    const element = audio.current
    if (!element || length === null) return
    const position = Math.min(Math.max(to, 0), length)
    element.currentTime = position
    setTime(position)
  }

  // The track drags as finely as it is wide; the keys move by whole steps instead of its 0.1 s.
  const seekByKey = (event: KeyboardEvent) => {
    const direction = SEEK_KEYS[event.key]
    if (direction === undefined || length === null) return
    event.preventDefault()
    const leap = event.shiftKey || event.key.startsWith("Page")
    seek(time + direction * (leap ? KEY_LEAP : KEY_STEP))
  }

  return (
    <div
      className={cn(
        "flex w-[min(28rem,100%)] items-center gap-3 rounded-2xl bg-card p-2.5 pr-4",
        MEDIA_FRAME
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? messages.pause(name) : messages.play(name)}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background shadow-sm transition-transform duration-150 outline-none hover:scale-[1.05] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-95"
      >
        {playing ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="ml-0.5 size-4 fill-current" />
        )}
      </button>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="truncate text-sm font-medium text-foreground" title={name}>
          {name}
        </p>
        <div className="flex items-center gap-2.5">
          <span className="w-9 shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatClock(time)}
          </span>
          <Slider
            value={[length === null ? 0 : Math.min(time, length)]}
            max={length ?? 1}
            step={0.1}
            disabled={length === null}
            aria-label={messages.position}
            onValueChange={([value]) => {
              if (value !== undefined) seek(value)
            }}
            onKeyDown={seekByKey}
            // A taller reach than the thin track, for a finger.
            className="-my-2 py-2 [&_[data-slot=slider-range]]:bg-foreground/80 [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-foreground/30 [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-foreground/15"
          />
          <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            {length === null ? "–:––" : formatClock(length)}
          </span>
        </div>
      </div>
      <audio
        ref={audio}
        // Once it is known what plays: the player shows, its length unknown, until then.
        src={derived ? (derived.proxy ?? source.inlineUrl) : undefined}
        preload="metadata"
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration)
          revealDuration(event.currentTarget)
        }}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onSeeked={(event) => setTime(event.currentTarget.currentTime)}
        onEnded={(event) => {
          setPlaying(false)
          setTime(event.currentTarget.duration)
        }}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

/** Seconds a key moves the position by, and with Shift or Page Up and Page Down. */
const KEY_STEP = 5
const KEY_LEAP = 15

/** Which way each key the track answers moves the position. */
const SEEK_KEYS: Readonly<Record<string, -1 | 1>> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  PageDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageUp: 1,
}

/** A file the browser could not play: why, and its download. */
function MediaFailed({ source, name, kind }: MediaProps & { readonly kind: "video" | "audio" }) {
  const messages = useArtifactMessages()
  return (
    <ViewerNotice
      title={kind === "video" ? messages.files.videoUnavailable : messages.files.audioUnavailable}
      description={messages.files.mediaDescription}
      action={
        <Button size="sm" asChild>
          <a href={source.downloadUrl} download={name} aria-label={messages.viewer.download(name)}>
            <Download />
            {messages.viewer.downloadLabel}
          </a>
        </Button>
      }
    />
  )
}
