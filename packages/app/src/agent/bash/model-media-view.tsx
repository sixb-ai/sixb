import { getAiModelCallOptions } from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { ImagePlus, Maximize2, Pause, Play } from "lucide-react"
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { type FileSource, modelCallFileSource } from "../../artifacts/file-source"
import { useArtifactPanel } from "../artifact-panel"
import { useAgentMessages } from "../i18n"
import type { ModelMedia } from "./interpret"

// What a `sixb models` call made, shown as the thing itself: the image, the voice clip, the
// transcript. The model that made it stays out of the way; the request reads as a quiet caption.

const FRAME =
  "overflow-hidden rounded-[14px] ring-1 ring-black/[0.06] shadow-[0_1px_2px_rgb(0_0_0/0.05),0_10px_28px_-12px_rgb(0_0_0/0.22)] dark:ring-white/10 dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_10px_28px_-12px_rgb(0_0_0/0.7)]"

export function ModelMediaView({
  media,
  running,
}: {
  readonly media: Exclude<ModelMedia, { kind: "answer" }>
  readonly running: boolean
}) {
  if (media.kind === "image") return <ImageResult media={media} running={running} />
  if (media.kind === "speech") return <SpeechResult media={media} running={running} />
  return <TranscriptResult media={media} running={running} />
}

/** The files a call made, readable to whoever can see the run that made them. */
function useCallFiles(callId: string | undefined): {
  readonly sources: readonly FileSource[]
  readonly missing: boolean
} {
  const { data, isError } = useQuery({
    ...getAiModelCallOptions({ path: { callId: callId ?? "" } }),
    enabled: callId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const sources = useMemo(
    () =>
      callId && data
        ? data.files.map((fileRef, index) => modelCallFileSource({ callId, index, fileRef }))
        : [],
    [callId, data]
  )
  return { sources, missing: isError }
}

function ImageResult({
  media,
  running,
}: {
  readonly media: Extract<ModelMedia, { kind: "image" }>
  readonly running: boolean
}) {
  const messages = useAgentMessages().modelMedia
  const { sources, missing } = useCallFiles(running ? undefined : media.callId)
  const slots = Math.max(1, Math.min(media.count, 4))
  const several = slots > 1

  return (
    <figure className="min-w-0 space-y-2">
      {missing ? (
        <p className="text-[12.5px] text-muted-foreground/70">{messages.expired}</p>
      ) : (
        <div
          className={cn(several ? "grid w-[min(26rem,100%)] grid-cols-2 gap-1.5" : "max-w-full")}
        >
          {Array.from({ length: slots }, (_, index) => {
            const source = sources[index]
            return source ? (
              <GeneratedImage
                key={source.id}
                source={source}
                cropped={several}
                aspect={media.aspect}
              />
            ) : (
              <div
                key={index}
                className={cn(FRAME, "sixb-media-developing")}
                style={several ? { aspectRatio: "1" } : frameSize(media.aspect)}
              />
            )
          })}
        </div>
      )}
      <Caption text={media.prompt} sources={media.sources} />
    </figure>
  )
}

/**
 * A frame the image fills exactly: 22rem wide, narrower when it is tall so it is never taller than
 * 26rem, and never wider than the column.
 */
function frameSize(aspect: number): CSSProperties {
  return { aspectRatio: String(aspect), width: `min(100%, 22rem, ${26 * aspect}rem)` }
}

/**
 * A generated image: its frame keeps the requested shape until the image arrives and shows its
 * own, so nothing below it moves; it fades in, and opens full size in the file viewer.
 */
function GeneratedImage({
  source,
  cropped,
  aspect: requested,
}: {
  readonly source: FileSource
  readonly cropped: boolean
  readonly aspect: number
}) {
  const panel = useArtifactPanel()
  const messages = useAgentMessages().modelMedia
  const [loaded, setLoaded] = useState(false)
  const [aspect, setAspect] = useState(requested)
  const image = (
    <span
      className={cn(FRAME, "group relative block size-full", !loaded && "sixb-media-developing")}
    >
      <img
        src={source.inlineUrl}
        alt=""
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight)
          setLoaded(true)
        }}
        className={cn(
          "absolute inset-0 size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.012]",
          loaded ? "sixb-media-in" : "opacity-0"
        )}
      />
      <span className="pointer-events-none absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/35 text-white opacity-0 backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
        <Maximize2 className="size-3.5" />
      </span>
    </span>
  )
  // The control carries the size, against the column; the frame fills it.
  const className =
    "block rounded-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
  const style = cropped ? { aspectRatio: "1" } : frameSize(aspect)
  if (panel) {
    return (
      <button
        type="button"
        className={className}
        style={style}
        onClick={() => panel.open({ type: "file", source })}
        aria-label={messages.openImage}
      >
        {image}
      </button>
    )
  }
  return (
    <a
      href={source.inlineUrl}
      target="_blank"
      rel="noreferrer"
      className={className}
      style={style}
      aria-label={messages.openImage}
    >
      {image}
    </a>
  )
}

/** The request, as a quiet line under what it made, and the files it started from. */
function Caption({
  text,
  sources,
}: {
  readonly text: string
  readonly sources?: readonly string[]
}) {
  const messages = useAgentMessages().modelMedia
  if (!text && !sources?.length) return null
  return (
    <figcaption className="max-w-[26rem] space-y-0.5 px-0.5">
      {text ? (
        <ClampedText
          text={text}
          lines={2}
          className="text-[12.5px] leading-snug text-muted-foreground"
        />
      ) : null}
      {sources?.length ? (
        <p className="flex items-center gap-1 text-[11.5px] text-muted-foreground/60">
          <ImagePlus className="size-3 shrink-0" />
          <span className="truncate">{messages.from(sources.join(", "))}</span>
        </p>
      ) : null}
    </figcaption>
  )
}

const BARS = 44

function SpeechResult({
  media,
  running,
}: {
  readonly media: Extract<ModelMedia, { kind: "speech" }>
  readonly running: boolean
}) {
  const messages = useAgentMessages().modelMedia
  const { sources, missing } = useCallFiles(running ? undefined : media.callId)
  const source = sources[0]
  return (
    <figure className="min-w-0 space-y-2">
      {missing ? (
        <p className="text-[12.5px] text-muted-foreground/70">{messages.expired}</p>
      ) : (
        <VoiceClip source={source} />
      )}
      {media.text ? (
        <figcaption className="max-w-[26rem] px-0.5">
          <ClampedText
            text={`“${media.text}”`}
            lines={2}
            className="text-[12.5px] leading-snug text-muted-foreground"
          />
        </figcaption>
      ) : null}
    </figure>
  )
}

/** A voice clip as a player: its own waveform, filling in as it plays. */
function VoiceClip({ source }: { readonly source: FileSource | undefined }) {
  const messages = useAgentMessages().modelMedia
  const audio = useRef<HTMLAudioElement>(null)
  const peaks = useWaveform(source)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)

  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      const element = audio.current
      if (element?.duration) setProgress(element.currentTime / element.duration)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  const toggle = () => {
    const element = audio.current
    if (!element) return
    if (element.paused) void element.play()
    else element.pause()
  }
  const ready = source !== undefined

  return (
    <div className="flex w-[min(22rem,100%)] items-center gap-3 rounded-full bg-muted/70 py-1.5 pr-4 pl-1.5 ring-1 ring-black/[0.04] dark:bg-white/[0.06] dark:ring-white/[0.06]">
      <button
        type="button"
        onClick={toggle}
        disabled={!ready}
        aria-label={playing ? messages.pause : messages.play}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background shadow-sm transition-transform duration-150 outline-none hover:scale-[1.06] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:scale-100"
      >
        {playing ? (
          <Pause className="size-3.5 fill-current" />
        ) : (
          <Play className="ml-0.5 size-3.5 fill-current" />
        )}
      </button>
      <div
        className={cn("flex h-7 min-w-0 flex-1 items-center gap-[2px]", !ready && "animate-pulse")}
        aria-hidden
      >
        {(peaks ?? PLACEHOLDER_PEAKS).map((peak, index) => (
          <span
            key={index}
            className={cn(
              "w-[3px] flex-1 rounded-full transition-colors duration-150",
              index / BARS < progress ? "bg-foreground/80" : "bg-foreground/20"
            )}
            style={{ height: `${Math.max(12, peak * 100)}%` } as CSSProperties}
          />
        ))}
      </div>
      <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
        {formatClock(playing || progress > 0 ? progress * (duration ?? 0) : (duration ?? 0))}
      </span>
      {source ? (
        <audio
          ref={audio}
          src={source.inlineUrl}
          preload="metadata"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setProgress(0)
          }}
        />
      ) : null}
    </div>
  )
}

const PLACEHOLDER_PEAKS = Array.from(
  { length: BARS },
  (_, index) => 0.25 + 0.2 * Math.abs(Math.sin(index * 0.7))
)

/** The clip's loudness in {@link BARS} steps, from its decoded samples. */
function useWaveform(source: FileSource | undefined): readonly number[] | null {
  const [peaks, setPeaks] = useState<readonly number[] | null>(null)
  useEffect(() => {
    if (!source || typeof AudioContext === "undefined") return
    const controller = new AbortController()
    void (async () => {
      try {
        const bytes = await (await source.load(controller.signal)).arrayBuffer()
        const context = new AudioContext()
        const buffer = await context.decodeAudioData(bytes)
        void context.close()
        const samples = buffer.getChannelData(0)
        const step = Math.max(1, Math.floor(samples.length / BARS))
        const levels = Array.from({ length: BARS }, (_, bar) => {
          let sum = 0
          for (
            let index = bar * step;
            index < (bar + 1) * step && index < samples.length;
            index++
          ) {
            sum += (samples[index] ?? 0) ** 2
          }
          return Math.sqrt(sum / step)
        })
        const loudest = Math.max(...levels, 1e-6)
        if (!controller.signal.aborted) setPeaks(levels.map((level) => level / loudest))
      } catch {
        // The bars stay even; the clip still plays.
      }
    })()
    return () => controller.abort()
  }, [source])
  return peaks
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

function TranscriptResult({
  media,
  running,
}: {
  readonly media: Extract<ModelMedia, { kind: "transcript" }>
  readonly running: boolean
}) {
  if (running || media.text === undefined) {
    return (
      <div className="w-[min(26rem,100%)] space-y-2 rounded-xl bg-muted/60 px-3.5 py-3 dark:bg-white/[0.04]">
        <div className="h-2 w-11/12 animate-pulse rounded-full bg-foreground/[0.08]" />
        <div className="h-2 w-3/5 animate-pulse rounded-full bg-foreground/[0.08]" />
      </div>
    )
  }
  return (
    <div className="max-w-[34rem] rounded-xl bg-muted/60 px-3.5 py-2.5 dark:bg-white/[0.04]">
      <ClampedText
        text={media.text}
        lines={5}
        className="text-[13.5px] leading-relaxed whitespace-pre-line text-foreground/85"
      />
    </div>
  )
}

const CLAMP: Readonly<Record<number, string>> = {
  2: "line-clamp-2",
  5: "line-clamp-5",
  8: "line-clamp-8",
}

/**
 * Text held to a few lines, however long the request or answer was. "Show more" appears only when
 * lines are actually hidden, and opens the rest in place.
 */
function ClampedText({
  text,
  lines,
  className,
}: {
  readonly text: string
  readonly lines: 2 | 5 | 8
  readonly className: string
}) {
  const messages = useAgentMessages().modelMedia
  const element = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)

  useLayoutEffect(() => {
    const node = element.current
    // Measured again whenever the text changes, since a new text may fit where the old did not.
    if (!node || open || !text) return
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [open, text])

  return (
    <div>
      <p ref={element} className={cn(className, "break-words", !open && CLAMP[lines])}>
        {text}
      </p>
      {clipped || open ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-0.5 text-[11.5px] font-medium text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
        >
          {open ? messages.less : messages.more}
        </button>
      ) : null}
    </div>
  )
}

/** Another model's answer: the question as a caption, then the answer. */
export function ModelAnswerView({
  media,
}: {
  readonly media: Extract<ModelMedia, { kind: "answer" }>
}) {
  return (
    <div className="max-w-[34rem] space-y-1.5">
      {media.prompt ? (
        <ClampedText
          text={media.prompt}
          lines={2}
          className="text-[12.5px] text-muted-foreground"
        />
      ) : null}
      {media.text ? (
        <ClampedText
          text={media.text}
          lines={8}
          className="text-[13.5px] leading-relaxed whitespace-pre-line text-foreground/85"
        />
      ) : null}
    </div>
  )
}
