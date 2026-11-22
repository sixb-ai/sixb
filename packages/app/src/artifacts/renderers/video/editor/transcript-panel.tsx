import { VIDEO_ENTRY, type VideoCut, type VideoRange } from "@sixb/core/artifacts/live"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Info,
  MicOff,
  Scissors,
  Search,
  TextCursorInput,
  Video,
  WandSparkles,
} from "lucide-react"
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useArtifactMessages } from "../../../messages"
import { formatClock } from "../../../playback"
import {
  type MediaTarget,
  useMediaParts,
  useMediaPartsOf,
  useTranscript,
  useTranscriptsOf,
} from "./media"
import type { LaidClip } from "./model"
import { clipName, type SpokenRecording } from "./selection"
import {
  fillers,
  findWords,
  rangesLength,
  silences,
  type TranscriptTiming,
  type TranscriptWord,
  wordAt,
  wordsCut,
} from "./transcript"

// Editing a recording by what is said in it. Its transcript reads as text, the word being said
// lit as it plays, and what the video no longer plays struck through. Selecting words and pressing
// Delete cuts them; "Remove silences" and "Remove filler words" show what they would cut first,
// and cut it all at once, a single step to undo. A transcript timed only by sentence is cut by
// sentence, and says so: it cannot say where a word inside one starts.
//
// The tab opens on what is said in the open scene without anything selected: the recording heard
// there that has words, the one under the playhead first, else the one heard longest, and the
// video's own, such as a voice-over, when the scene's have none. A clip selected on the timeline
// shows its recording instead, and a menu switches between those that speak.

/** What the tab knows of what a recording says. */
type Speech = "words" | "transcribing" | "no_model" | "none"

export function TranscriptTab({
  target,
  scene,
  recordings,
  selected,
  timeMs,
  onSeek,
  onRemove,
}: {
  readonly target: MediaTarget
  /** The open scene, by its id. */
  readonly scene: string | undefined
  /** The recordings heard in the open scene, best first, as `heardRecordings` ranks them. */
  readonly recordings: readonly SpokenRecording[]
  /** The recording of the clip selected on the timeline, when one is. */
  readonly selected: SpokenRecording | undefined
  readonly timeMs: number
  readonly onSeek: (ms: number) => void
  readonly onRemove: (recording: SpokenRecording, ranges: readonly VideoCut[]) => void
}) {
  const messages = useArtifactMessages().videoEditor
  const parts = useMediaPartsOf(
    target,
    recordings.map((recording) => recording.src)
  )
  const transcripts = useTranscriptsOf(parts.map((part) => part.transcriptUrl))
  const speech = parts.map((part, index): Speech => {
    const read = transcripts[index]
    if (read?.transcript && read.transcript.words.length > 0) return "words"
    if (part.transcript === "processing") return "transcribing"
    if (part.transcriptUrl && !read?.transcript && !read?.failed) return "transcribing"
    return part.transcriptLacks === "transcription_model" ? "no_model" : "none"
  })
  const speaking = recordings.filter((_, index) => speech[index] === "words")

  // A clip selected on the timeline shows its recording, until another is chosen in the menu. The
  // choice lasts until the reader opens another scene or selects another clip.
  const [chosen, setChosen] = useState<string | null>(null)
  const following = `${scene ?? ""}\n${selected ? keyOf(selected) : ""}`
  const [followed, setFollowed] = useState(following)
  if (followed !== following) {
    setFollowed(following)
    setChosen(null)
  }

  const shown =
    recordings.find((recording) => keyOf(recording) === chosen) ?? selected ?? speaking[0]

  if (!shown) {
    if (recordings.length === 0) {
      return (
        <Empty icon={<AudioLines aria-hidden="true" />} title={messages.noRecording}>
          {messages.noRecordingHint}
        </Empty>
      )
    }
    if (speech.includes("transcribing")) {
      return (
        <Notice>
          <Spinner className="size-4" />
          {messages.transcribing}
        </Notice>
      )
    }
    if (speech.includes("no_model")) return <NoTranscriptionModel />
    return (
      <Empty icon={<MicOff aria-hidden="true" />} title={messages.noSpeech}>
        {messages.noSpeechHint}
      </Empty>
    )
  }

  const choices = speaking.some((recording) => keyOf(recording) === keyOf(shown))
    ? speaking
    : [shown, ...speaking]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border/70 px-2">
        {choices.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={messages.chooseRecording(recordingName(shown))}
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
              >
                <RecordingLabel recording={shown} />
                <ChevronsUpDown
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
            >
              {choices.map((recording) => (
                <DropdownMenuItem
                  key={keyOf(recording)}
                  onSelect={() => setChosen(keyOf(recording))}
                >
                  <RecordingLabel recording={recording} />
                  {keyOf(recording) === keyOf(shown) ? (
                    <Check className="ml-auto" aria-hidden="true" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2">
            <RecordingLabel recording={shown} />
          </div>
        )}
      </div>

      <TranscriptPanel
        key={keyOf(shown)}
        target={target}
        src={shown.src}
        clips={shown.clips}
        timeMs={timeMs}
        onSeek={onSeek}
        onRemove={(ranges) => onRemove(shown, ranges)}
      />
    </div>
  )
}

function keyOf(recording: SpokenRecording): string {
  return `${recording.chain ?? recording.file}\n${recording.src}`
}

function recordingName(recording: SpokenRecording): string {
  const first = recording.clips[0]
  return first ? clipName(first.clip) : recording.src.replace(/^.*\//, "")
}

/** A recording by its name, what it is and when it is first heard. */
function RecordingLabel({ recording }: { readonly recording: SpokenRecording }) {
  const messages = useArtifactMessages().videoEditor
  const first = recording.clips[0]
  const sound = first?.clip.kind === "audio"
  const what =
    recording.file === VIDEO_ENTRY
      ? messages.tracks.soundtrack
      : messages.clipKinds[sound ? "audio" : "video"]

  return (
    <>
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
        {sound ? <AudioLines aria-hidden="true" /> : <Video aria-hidden="true" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium text-foreground">
          {recordingName(recording)}
        </span>
        <span className="truncate text-[11px] text-muted-foreground tabular-nums">
          {what}
          {first ? ` · ${formatClock(first.startMs / 1000)}` : null}
        </span>
      </span>
    </>
  )
}

export function TranscriptPanel({
  target,
  src,
  clips,
  timeMs,
  onSeek,
  onRemove,
}: {
  readonly target: MediaTarget
  /** The recording, by its path. */
  readonly src: string
  /** The clips of the open scene that play it, laid out in the video's time. */
  readonly clips: readonly LaidClip[]
  readonly timeMs: number
  readonly onSeek: (ms: number) => void
  /** Cuts these stretches of the recording, in milliseconds into its file. */
  readonly onRemove: (ranges: readonly VideoCut[]) => void
}) {
  const messages = useArtifactMessages().videoEditor
  const parts = useMediaParts(target, src)
  const { transcript, failed } = useTranscript(parts.transcriptUrl)
  const words = transcript?.words

  if (parts.transcript === "processing" || (parts.transcriptUrl && !transcript && !failed)) {
    return (
      <Notice>
        <Spinner className="size-4" />
        {messages.transcribing}
      </Notice>
    )
  }
  if (failed) return <Notice>{messages.transcriptFailed}</Notice>
  // Nothing the reader can do here: what to set up for it, rather than a dead end.
  if (parts.transcriptLacks === "transcription_model") return <NoTranscriptionModel />
  if (!transcript || !words || words.length === 0) {
    return <Notice>{parts.transcriptReason ?? messages.noTranscript}</Notice>
  }

  return (
    <Words
      words={words}
      timing={transcript.timing}
      cuts={parts.cuts}
      clips={clips}
      timeMs={timeMs}
      onSeek={onSeek}
      onRemove={onRemove}
    />
  )
}

function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 flex items-center gap-2 p-4 text-[13px] text-muted-foreground">{children}</p>
  )
}

/** Why there is nothing to read, and what would change that. */
function Empty({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <p className="m-0 text-[13px] font-medium text-foreground">{title}</p>
      <p className="m-0 max-w-64 text-[13px] text-muted-foreground">{children}</p>
    </div>
  )
}

function NoTranscriptionModel() {
  const messages = useArtifactMessages().videoEditor
  return (
    <Empty icon={<TextCursorInput aria-hidden="true" />} title={messages.noTranscriptionModel}>
      {messages.noTranscriptionModelHint}
    </Empty>
  )
}

/** What a cleanup would cut, shown before it does. */
interface Proposal {
  readonly kind: "silences" | "fillers"
  readonly ranges: readonly VideoCut[]
}

function Words({
  words,
  timing,
  cuts,
  clips,
  timeMs,
  onSeek,
  onRemove,
}: {
  readonly words: readonly TranscriptWord[]
  readonly timing: TranscriptTiming
  readonly cuts: readonly number[]
  readonly clips: readonly LaidClip[]
  readonly timeMs: number
  readonly onSeek: (ms: number) => void
  readonly onRemove: (ranges: readonly VideoCut[]) => void
}) {
  const messages = useArtifactMessages().videoEditor
  const phrases = timing === "phrases"
  const list = useRef<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<{
    readonly anchor: number
    readonly focus: number
  } | null>(null)
  // The word a press started on, and the anchor of what it selects once it drags to another:
  // none while it stays on its word, which is then a click. Never the word under its release,
  // which the text may have moved under the pointer since.
  const press = useRef<{ readonly word: number; anchor: number | null } | null>(null)
  const [query, setQuery] = useState("")
  const [match, setMatch] = useState(0)
  const [proposal, setProposal] = useState<Proposal | null>(null)

  // The stretches of the file the video plays, each with where it plays.
  const kept = useMemo(
    () =>
      clips
        .map((laid) => ({
          laid,
          range: {
            startMs: laid.clip.mediaStartMs,
            endMs: laid.clip.mediaStartMs + (laid.endMs - laid.startMs),
          },
        }))
        .sort((a, b) => a.range.startMs - b.range.startMs),
    [clips]
  )
  const playedAt = (ms: number) => kept.find(({ range }) => range.startMs <= ms && ms < range.endMs)

  // The word being said: where the playhead is in the file, through the clip playing it.
  const playing = clips.find((laid) => laid.startMs <= timeMs && timeMs < laid.endMs)
  const nowMs = playing ? playing.clip.mediaStartMs + timeMs - playing.startMs : undefined
  const current = nowMs === undefined ? -1 : wordAt(words, nowMs)

  const found = useMemo(() => findWords(words, query, timing), [words, query, timing])
  // How many entries a match spans: its words, or the one phrase that holds it.
  const queryWords = phrases ? 1 : query.trim().split(/\s+/).length
  // A new search starts at its first match.
  const [searched, setSearched] = useState(query)
  if (searched !== query) {
    setSearched(query)
    setMatch(0)
  }
  useEffect(() => {
    const index = found[match]
    if (index === undefined) return
    list.current
      ?.querySelector(`[data-word="${index}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [found, match])

  // The word being said stays in sight as it plays.
  useEffect(() => {
    if (current < 0 || selection) return
    list.current?.querySelector(`[data-word="${current}"]`)?.scrollIntoView({ block: "nearest" })
  }, [current, selection])

  const from = selection ? Math.min(selection.anchor, selection.focus) : -1
  const to = selection ? Math.max(selection.anchor, selection.focus) : -1

  const cutSelection = () => {
    if (!selection) return
    const first = words[from]
    const within = first ? (playedAt(first.startMs) ?? playedAt(first.endMs - 1)) : undefined
    if (!within) return
    const range = wordsCut(words, from, to, within.range, cuts)
    setSelection(null)
    if (range) onRemove([range])
  }

  const propose = (kind: Proposal["kind"]) => {
    const ranges = kept.flatMap(({ range }) =>
      kind === "silences" ? silences(words, range) : fillers(words, range, cuts)
    )
    setProposal({ kind, ranges })
  }

  const inProposal = (word: TranscriptWord) =>
    proposal?.ranges.some((range) => word.startMs >= range.startMs && word.endMs <= range.endMs)

  const wordIndex = (target: EventTarget | null) => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-word]") : null
    const index = Number(element?.dataset.word)
    return Number.isInteger(index) ? index : null
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/70 p-3">
        <div className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring/50">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={messages.search}
            aria-label={messages.search}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter" && found.length > 0) {
                event.preventDefault()
                setMatch((match + (event.shiftKey ? found.length - 1 : 1)) % found.length)
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
          {query.trim() ? (
            <>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {found.length > 0 ? messages.matches(match + 1, found.length) : messages.noMatch}
              </span>
              <button
                type="button"
                aria-label={messages.previousMatch}
                disabled={found.length === 0}
                onClick={() => setMatch((match + found.length - 1) % found.length)}
                className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40"
              >
                <ChevronUp className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={messages.nextMatch}
                disabled={found.length === 0}
                onClick={() => setMatch((match + 1) % found.length)}
                className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40"
              >
                <ChevronDown className="size-3.5" />
              </button>
            </>
          ) : null}
        </div>

        {proposal ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[13px] text-foreground ring-1 ring-amber-500/30"
          >
            <span className="min-w-0 flex-1 truncate">
              {proposal.ranges.length === 0
                ? messages.nothingToRemove
                : proposal.kind === "silences"
                  ? messages.foundSilences(
                      proposal.ranges.length,
                      seconds(rangesLength(proposal.ranges))
                    )
                  : messages.foundFillers(
                      proposal.ranges.length,
                      seconds(rangesLength(proposal.ranges))
                    )}
            </span>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setProposal(null)}>
              {messages.cancel}
            </Button>
            {proposal.ranges.length > 0 ? (
              <Button
                size="sm"
                className="h-7"
                onClick={() => {
                  onRemove(proposal.ranges)
                  setProposal(null)
                }}
              >
                {messages.remove}
              </Button>
            ) : null}
          </div>
        ) : (
          // A selection's actions take the cleanups' place, which keeps its height while hidden:
          // the words below never move under a pointer selecting them.
          <div className="grid">
            <div
              className={cn(
                "col-start-1 row-start-1 flex flex-wrap gap-1.5",
                selection && "invisible"
              )}
            >
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => propose("silences")}
              >
                <WandSparkles />
                {messages.removeSilences}
              </Button>
              {/* A filler is a word: a phrase cannot say where one is inside it. */}
              {phrases ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => propose("fillers")}
                >
                  <WandSparkles />
                  {messages.removeFillers}
                </Button>
              )}
            </div>
            {selection ? (
              <div className="col-start-1 row-start-1 flex items-start gap-2">
                <Button size="sm" className="h-7" onClick={cutSelection}>
                  <Scissors />
                  {phrases ? messages.cutPhrases(to - from + 1) : messages.cutWords(to - from + 1)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => setSelection(null)}
                >
                  {messages.cancel}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {phrases ? (
          <div className="flex gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-[12px] leading-snug text-muted-foreground">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="m-0 text-foreground">{messages.phrasesNote}</p>
              <p className="m-0">{messages.phrasesHint}</p>
            </div>
          </div>
        ) : null}
      </div>

      <div
        ref={list}
        tabIndex={0}
        aria-label={messages.transcript}
        aria-describedby="sixb-transcript-hint"
        className={cn(
          "min-h-0 flex-1 touch-pan-y overflow-y-auto p-4 text-[15px] outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
          phrases ? "flex flex-col gap-1 leading-6" : "leading-8"
        )}
        onKeyDown={(event) => {
          if ((event.key === "Delete" || event.key === "Backspace") && selection) {
            event.preventDefault()
            event.stopPropagation()
            cutSelection()
          } else if (event.key === "Escape") {
            setSelection(null)
            setProposal(null)
          }
        }}
        onPointerDown={(event) => {
          const index = wordIndex(event.target)
          if (index === null || event.button !== 0) return
          event.currentTarget.setPointerCapture?.(event.pointerId)

          // Shift extends the selection to the word; a press alone selects once it drags.
          const anchor = event.shiftKey ? (selection?.anchor ?? index) : null
          press.current = { word: index, anchor }
          if (anchor !== null) setSelection({ anchor, focus: index })
        }}
        onPointerMove={(event) => {
          const pressed = press.current
          if (!pressed) return
          const index = wordIndex(document.elementFromPoint(event.clientX, event.clientY))
          if (index === null || (pressed.anchor === null && index === pressed.word)) return

          pressed.anchor ??= pressed.word
          setSelection({ anchor: pressed.anchor, focus: index })
        }}
        onPointerUp={() => {
          const pressed = press.current
          press.current = null
          if (!pressed || pressed.anchor !== null) return

          // A click on one word goes there, and selects nothing.
          setSelection(null)
          const word = words[pressed.word]
          const played = word ? playedAt(word.startMs) : undefined
          if (word && played) onSeek(played.laid.startMs + word.startMs - played.range.startMs)
        }}
        onPointerCancel={() => {
          press.current = null
        }}
      >
        <p id="sixb-transcript-hint" className="sr-only">
          {phrases ? messages.phrasesHintShort : messages.wordsHint}
        </p>
        {words.map((word, index) => {
          const cutAway = !playedAt(word.startMs + Math.min(40, (word.endMs - word.startMs) / 2))
          const selected = index >= from && index <= to
          const matched = found.some((start) => index >= start && index < start + queryWords)
          const proposed = inProposal(word)
          const pause =
            proposal?.kind === "silences" ? pauseBefore(words, index, proposal.ranges) : 0
          return (
            <Fragment key={`${word.startMs}-${index}`}>
              {pause > 0 ? (
                <span className="mx-0.5 inline-flex h-5 items-center rounded bg-amber-500/20 px-1 align-middle text-[11px] leading-none text-amber-700 dark:text-amber-300">
                  {seconds(pause)}
                </span>
              ) : null}
              <span
                data-word={index}
                className={cn(
                  "cursor-text rounded-[3px] transition-colors",
                  phrases
                    ? "-mx-1.5 block rounded-md px-1.5 py-1 hover:bg-muted/70"
                    : "px-[1px] py-0.5",
                  cutAway && "text-muted-foreground/60 line-through decoration-muted-foreground/50",
                  index === current && !selected && "bg-primary/15 text-foreground",
                  matched && !selected && "bg-amber-300/40 dark:bg-amber-400/30",
                  proposed && "bg-amber-500/25 line-through",
                  selected && "bg-primary text-primary-foreground hover:bg-primary"
                )}
              >
                {word.text}
              </span>
              {/* The space between two words selected is selected too: one stretch, not islands. */}
              {phrases ? null : (
                <span className={cn(selected && index < to && "bg-primary")}> </span>
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/** How much of the pause before a word a cleanup would cut. */
function pauseBefore(
  words: readonly TranscriptWord[],
  index: number,
  ranges: readonly VideoRange[]
): number {
  const before = words[index - 1]
  const word = words[index]
  if (!word) return 0
  const start = before ? before.endMs : Number.NEGATIVE_INFINITY
  return ranges
    .filter((range) => range.startMs >= start && range.endMs <= word.startMs)
    .reduce((sum, range) => sum + range.endMs - range.startMs, 0)
}

function seconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toLocaleString()} s`
}
