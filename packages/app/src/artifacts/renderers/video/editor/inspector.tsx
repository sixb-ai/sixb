import {
  VIDEO_ENTRY,
  type VideoClip,
  type VideoComposition,
  type VideoFileTimeline,
  type VideoScene,
  type VideoTarget,
  type VideoText,
  videoSceneLength,
  videoTarget,
} from "@sixb/core/artifacts/live"
import { Button, Slider } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  AudioLines,
  Copy,
  Image as ImageIcon,
  Scissors,
  Trash2,
  TriangleAlert,
  Type,
  Video,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { useArtifactMessages } from "../../../messages"
import { formatClock } from "../../../playback"
import { type MediaTarget, useMediaParts } from "./media"
import { clipName, sceneName, typedText } from "./selection"
import { TRACK_TONE } from "./timeline"

// What the selection is, and its settings: a scene's name, length and words on screen; a clip's
// timing, sound and words. Each field changes the video once the reader commits it, with Enter or
// by leaving it: a step of its own for undo. The arrows nudge a time by a tenth of a second, and a
// whole one with Shift.

export interface InspectorActions {
  readonly renameScene: (scene: VideoScene, label: string) => void
  readonly sceneLength: (scene: VideoScene, ms: number) => void
  readonly duplicateScene: (scene: VideoScene) => void
  readonly removeScene: (scene: VideoScene) => void
  readonly clipTiming: (
    file: string,
    clip: VideoClip,
    timing: {
      readonly startMs?: number
      readonly durationMs?: number
      readonly mediaStartMs?: number
    }
  ) => void
  readonly clipSound: (
    file: string,
    clip: VideoClip,
    sound: { readonly volume?: number; readonly fadeInMs?: number; readonly fadeOutMs?: number }
  ) => void
  readonly text: (file: string, text: VideoTarget, words: string) => void
  readonly clipText: (file: string, clip: VideoClip, text: string) => void
  readonly removeClip: (file: string, clip: VideoClip) => void
  readonly splitClip: (file: string, clip: VideoClip) => void
}

export function Inspector({
  composition,
  timelines,
  scene,
  clip,
  splittable,
  target,
  actions,
}: {
  readonly composition: VideoComposition
  readonly timelines: ReadonlyMap<string, VideoFileTimeline>
  /** The scene selected, or the clip's. */
  readonly scene: VideoScene | undefined
  /** The clip selected, in its file. */
  readonly clip: { readonly file: string; readonly clip: VideoClip } | undefined
  /** Whether the playhead is inside the selected clip, where it splits. */
  readonly splittable: boolean
  /** Where its recordings' parts are read from. */
  readonly target: MediaTarget
  readonly actions: InspectorActions
}) {
  const messages = useArtifactMessages().videoEditor

  if (clip) {
    return (
      <ClipInspector
        file={clip.file}
        clip={clip.clip}
        typed={typedText(timelines.get(clip.file), clip.clip) !== undefined}
        splittable={splittable}
        target={target}
        actions={actions}
      />
    )
  }

  if (scene) {
    return (
      <SceneInspector
        composition={composition}
        scene={scene}
        texts={timelines.get(scene.src)?.texts ?? []}
        actions={actions}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Section title={messages.videoSettings}>
        <Fact label={messages.frame} value={`${composition.width} × ${composition.height}`} />
        <Fact label={messages.frameRate} value={messages.fps(composition.fps)} />
        <Fact label={messages.length} value={clock(composition.durationMs)} />
      </Section>
      <p className="m-0 text-[13px] text-muted-foreground">{messages.nothingSelected}</p>
    </div>
  )
}

function SceneInspector({
  composition,
  scene,
  texts,
  actions,
}: {
  readonly composition: VideoComposition
  readonly scene: VideoScene
  readonly texts: readonly VideoText[]
  readonly actions: InspectorActions
}) {
  const messages = useArtifactMessages().videoEditor
  const index = composition.scenes.findIndex((each) => each.id === scene.id)
  const only = composition.scenes.length === 1

  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-md bg-muted text-xs font-semibold tabular-nums">
          {index + 1}
        </span>
        <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">{sceneName(scene)}</h3>
      </header>

      <Section title={messages.scene}>
        <TextField
          label={messages.name}
          value={scene.label ?? ""}
          placeholder={scene.id}
          onCommit={(label) => actions.renameScene(scene, label)}
        />
        <SecondsField
          label={messages.length}
          ms={scene.durationMs}
          min={100}
          round={(ms) => videoSceneLength(ms, composition.fps)}
          onCommit={(ms) => actions.sceneLength(scene, ms)}
        />
        <Fact label={messages.starts} value={startsText(scene, composition, messages)} />
      </Section>

      {texts.length > 0 ? (
        <Section title={messages.words}>
          {texts.map((text) => (
            <TextField
              key={text.ref}
              label={textKind(text, messages)}
              value={text.text}
              multiline
              onCommit={(value) => actions.text(scene.src, videoTarget(text), value)}
            />
          ))}
        </Section>
      ) : null}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => actions.duplicateScene(scene)}>
          <Copy />
          {messages.duplicate}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={only}
          onClick={() => actions.removeScene(scene)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 />
          {messages.delete}
        </Button>
      </div>
    </div>
  )
}

function ClipInspector({
  file,
  clip,
  typed,
  splittable,
  target,
  actions,
}: {
  readonly file: string
  readonly clip: VideoClip
  /** Whether its words can be typed over: it holds text alone. */
  readonly typed: boolean
  readonly splittable: boolean
  readonly target: MediaTarget
  readonly actions: InspectorActions
}) {
  const messages = useArtifactMessages().videoEditor
  const plays = clip.kind === "video" || clip.kind === "audio"
  const { failed } = useMediaParts(plays ? target : null, clip.src)
  const sounds = clip.kind === "audio" || (clip.kind === "video" && !clip.silent)
  const kind = clip.caption ? messages.clipKinds.caption : messages.clipKinds[clip.kind]

  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="flex items-center gap-2">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-3.5",
            TRACK_TONE[clip.track]
          )}
        >
          {clip.kind === "audio" ? (
            <AudioLines aria-hidden="true" />
          ) : clip.kind === "image" ? (
            <ImageIcon aria-hidden="true" />
          ) : clip.kind === "video" ? (
            <Video aria-hidden="true" />
          ) : (
            <Type aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[11px] text-muted-foreground">{kind}</p>
          <h3 className="m-0 truncate text-sm font-semibold" title={clipName(clip)}>
            {clipName(clip)}
          </h3>
        </div>
      </header>

      {failed ? (
        <div
          role="alert"
          className="-mt-1 flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px]"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0">
            <p className="m-0 font-medium text-destructive">{messages.unreadableTitle}</p>
            <p className="m-0 mt-0.5 text-muted-foreground">
              {failed} {messages.unreadableHint}
            </p>
          </div>
        </div>
      ) : null}

      <Section title={messages.timing}>
        <SecondsField
          label={messages.start}
          hint={file === VIDEO_ENTRY ? messages.startIn.video : messages.startIn.scene}
          ms={clip.startMs}
          min={0}
          onCommit={(ms) => actions.clipTiming(file, clip, { startMs: ms })}
        />
        <SecondsField
          label={messages.length}
          ms={clip.durationMs}
          min={100}
          onCommit={(ms) => actions.clipTiming(file, clip, { durationMs: ms })}
        />
        {plays ? (
          <SecondsField
            label={messages.from}
            hint={messages.fromHint}
            ms={clip.mediaStartMs}
            min={0}
            onCommit={(ms) => actions.clipTiming(file, clip, { mediaStartMs: ms })}
          />
        ) : null}
      </Section>

      {sounds ? (
        <Section title={messages.tracks.sound}>
          <VolumeField
            volume={clip.volume ?? 1}
            onCommit={(volume) => actions.clipSound(file, clip, { volume })}
          />
          <SecondsField
            label={messages.fadeIn}
            ms={clip.fadeInMs ?? 0}
            min={0}
            onCommit={(ms) => actions.clipSound(file, clip, { fadeInMs: ms })}
          />
          <SecondsField
            label={messages.fadeOut}
            ms={clip.fadeOutMs ?? 0}
            min={0}
            onCommit={(ms) => actions.clipSound(file, clip, { fadeOutMs: ms })}
          />
        </Section>
      ) : null}

      {typed && clip.text !== undefined ? (
        <Section title={messages.text}>
          <TextField
            label={messages.text}
            value={clip.text}
            multiline
            hideLabel
            onCommit={(value) => actions.clipText(file, clip, value)}
          />
        </Section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!splittable}
          title={messages.splitHint}
          onClick={() => actions.splitClip(file, clip)}
        >
          <Scissors />
          {messages.split}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => actions.removeClip(file, clip)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 />
          {messages.delete}
        </Button>
      </div>
    </div>
  )
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h4 className="m-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </section>
  )
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground tabular-nums">{value}</span>
    </div>
  )
}

/** A time in seconds, typed or nudged with the arrows, committed with Enter or by leaving it. */
export function SecondsField({
  label,
  hint,
  ms,
  min,
  round = Math.round,
  onCommit,
  compact = false,
}: {
  readonly label: string
  readonly hint?: string
  /** Undefined for a time not written, as a clip that plays to its end. */
  readonly ms: number | undefined
  readonly min: number
  /** The time an edit makes of the one typed, which the field shows once committed. */
  readonly round?: (ms: number) => number
  readonly onCommit: (ms: number) => void
  readonly compact?: boolean
}) {
  const messages = useArtifactMessages().videoEditor
  const id = useId()
  const shown = ms === undefined ? "" : formatSeconds(ms)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  // Escape leaves the field as it was: the blur it causes still holds the typed text.
  const cancelled = useRef(false)

  const commit = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) {
      setText(shown)
      return
    }
    const next = Math.max(min, round(value))
    setText(formatSeconds(next))
    if (next !== ms) onCommit(next)
  }

  return (
    <div className={cn("flex items-center justify-between gap-3", compact && "gap-2")}>
      <label htmlFor={id} className="flex min-w-0 flex-col text-[13px] text-muted-foreground">
        {label}
        {hint ? <span className="text-[11px] text-muted-foreground/75">{hint}</span> : null}
      </label>
      <div className="flex h-8 w-24 items-center rounded-md border border-input bg-background pr-2 focus-within:ring-2 focus-within:ring-ring/50">
        <input
          id={id}
          value={text}
          inputMode="decimal"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit(parseSeconds(text))
              event.currentTarget.blur()
            } else if (event.key === "Escape") {
              cancelled.current = true
              setText(shown)
              event.currentTarget.blur()
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault()
              const step = (event.shiftKey ? 1000 : 100) * (event.key === "ArrowUp" ? 1 : -1)
              commit((parseSeconds(text) ?? ms ?? 0) + step)
            }
            event.stopPropagation()
          }}
          onBlur={() => {
            if (cancelled.current) cancelled.current = false
            else commit(parseSeconds(text))
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-right text-[13px] tabular-nums outline-none"
        />
        <span className="text-[13px] text-muted-foreground">{messages.seconds}</span>
      </div>
    </div>
  )
}

/** What a reader typed in a {@link TextField}, over the words it showed then. */
interface Draft {
  readonly text: string
  readonly from: string
}

/** Words, typed over and committed with Enter, or by leaving; Shift and Enter breaks a line. */
export function TextField({
  label,
  value,
  placeholder,
  multiline = false,
  hideLabel = false,
  onCommit,
}: {
  readonly label: string
  readonly value: string
  readonly placeholder?: string
  readonly multiline?: boolean
  readonly hideLabel?: boolean
  readonly onCommit: (value: string) => void
}) {
  const id = useId()

  // What the reader typed, and the words they typed over. Until they type, the field shows the
  // words as they are now, someone else's change included; leaving it writes only what they
  // changed, never words it showed before over another's. Held in a ref too, for the blur that
  // Escape or Enter starts before the field renders again.
  const [draft, setDraft] = useState<Draft | null>(null)
  const typed = useRef<Draft | null>(null)
  const change = (next: Draft | null) => {
    typed.current = next
    setDraft(next)
  }
  const text = draft?.text ?? value

  const commit = () => {
    const made = typed.current
    change(null)
    if (!made || made.text.trim() === made.from.trim()) return
    if (multiline && made.text.trim() === "") return
    onCommit(made.text)
  }

  const shared = {
    id,
    value: text,
    placeholder,
    onChange: (event: { currentTarget: { value: string } }) =>
      change({ text: event.currentTarget.value, from: typed.current?.from ?? value }),
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === "Escape") {
        change(null)
        ;(event.currentTarget as HTMLElement).blur()
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        ;(event.currentTarget as HTMLElement).blur()
      }
    },
    className:
      "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={cn("text-[13px] text-muted-foreground", hideLabel && "sr-only")}
      >
        {label}
      </label>
      {multiline ? (
        <textarea
          rows={Math.min(4, Math.max(1, Math.ceil(text.length / 32)))}
          {...shared}
          className={cn(shared.className, "resize-none leading-snug")}
        />
      ) : (
        <input {...shared} />
      )}
    </div>
  )
}

function VolumeField({
  volume,
  onCommit,
}: {
  readonly volume: number
  readonly onCommit: (volume: number) => void
}) {
  const messages = useArtifactMessages().videoEditor
  const [level, setLevel] = useState(volume)
  useEffect(() => setLevel(volume), [volume])

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-muted-foreground">{messages.volume}</span>
      <div className="flex w-40 items-center gap-2">
        <Slider
          aria-label={messages.volume}
          value={[Math.round(level * 100)]}
          min={0}
          max={100}
          step={1}
          onValueChange={([value]) => setLevel((value ?? 0) / 100)}
          onValueCommit={([value]) => onCommit((value ?? 0) / 100)}
        />
        <span className="w-9 text-right text-[13px] tabular-nums">{Math.round(level * 100)}%</span>
      </div>
    </div>
  )
}

/** A scene's start, as the reader thinks of it: when another ends, or at a time. */
function startsText(
  scene: VideoScene,
  composition: VideoComposition,
  messages: ReturnType<typeof useArtifactMessages>["videoEditor"]
): string {
  if (scene.start.type === "at") return messages.startsAt(clock(scene.startMs))
  const { scene: name, offset } = scene.start
  const after = composition.scenes.find((each) => each.id === name || each.hostId === name)
  const shown = after ? sceneName(after) : name
  if (offset === 0) return messages.startsAfter(shown)
  const seconds = `${formatSeconds(Math.abs(offset) * 1000)} ${messages.seconds}`
  return offset < 0
    ? messages.startsOverlapping(shown, seconds)
    : messages.startsGap(shown, seconds)
}

/** What a text is to the reader, by its tag: a title, a subtitle, or words. */
export function textKind(
  text: Pick<VideoText, "tag">,
  messages: ReturnType<typeof useArtifactMessages>["videoEditor"]
): string {
  if (/^h[1-2]$/.test(text.tag)) return messages.textKinds.title
  if (/^h[3-6]$/.test(text.tag)) return messages.textKinds.subtitle
  return messages.textKinds.words
}

/** Milliseconds as seconds to a tenth, or a hundredth where it matters: `4500` as `4.5`. */
export function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 10) / 100
  return String(seconds)
}

/** Seconds as typed: `4.5`, `4,5`, `1:04.5`; null for anything else. */
export function parseSeconds(text: string): number | null {
  const written = text.trim().replace(",", ".")
  if (written === "") return null
  const parts = written.split(":")
  if (parts.length > 2) return null
  const [first = "", second] = parts
  const value = second === undefined ? Number(first) : Number(first) * 60 + Number(second)
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null
}

function clock(ms: number): string {
  const tenths = Math.round(ms / 100) % 10
  return `${formatClock(ms / 1000)}.${tenths}`
}
