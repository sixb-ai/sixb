import type { VideoRange } from "@sixb/core/artifacts/live"
import { Button, Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  ChevronDown,
  ChevronUp,
  Info,
  Scissors,
  Search,
  TextCursorInput,
  WandSparkles,
} from "lucide-react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useArtifactMessages } from "../../../messages"
import { type MediaTarget, useMediaParts, useTranscript } from "./media"
import type { LaidClip } from "./model"
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
  readonly onRemove: (ranges: readonly VideoRange[]) => void
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
  if (parts.transcriptLacks === "transcription_model") {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <span className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">
          <TextCursorInput aria-hidden="true" />
        </span>
        <p className="m-0 text-[13px] font-medium text-foreground">
          {messages.noTranscriptionModel}
        </p>
        <p className="m-0 max-w-64 text-[13px] text-muted-foreground">
          {messages.noTranscriptionModelHint}
        </p>
      </div>
    )
  }
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

function Notice({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="m-0 flex items-center gap-2 p-4 text-[13px] text-muted-foreground">{children}</p>
  )
}

/** What a cleanup would cut, shown before it does. */
interface Proposal {
  readonly kind: "silences" | "fillers"
  readonly ranges: readonly VideoRange[]
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
  readonly onRemove: (ranges: readonly VideoRange[]) => void
}) {
  const messages = useArtifactMessages().videoEditor
  const phrases = timing === "phrases"
  const list = useRef<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<{
    readonly anchor: number
    readonly focus: number
  } | null>(null)
  const pressing = useRef(false)
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
        ) : selection ? (
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-7" onClick={cutSelection}>
              <Scissors />
              {phrases ? messages.cutPhrases(to - from + 1) : messages.cutWords(to - from + 1)}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelection(null)}>
              {messages.cancel}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" className="h-7" onClick={() => propose("silences")}>
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
          pressing.current = true
          setSelection((last) =>
            event.shiftKey && last
              ? { anchor: last.anchor, focus: index }
              : { anchor: index, focus: index }
          )
        }}
        onPointerMove={(event) => {
          if (!pressing.current) return
          const index = wordIndex(document.elementFromPoint(event.clientX, event.clientY))
          if (index !== null)
            setSelection((last) => (last ? { anchor: last.anchor, focus: index } : last))
        }}
        onPointerUp={(event) => {
          if (!pressing.current) return
          pressing.current = false
          const index = wordIndex(event.target)
          // A click on one word goes there, and selects nothing.
          if (
            index !== null &&
            selection &&
            selection.anchor === index &&
            selection.focus === index &&
            !event.shiftKey
          ) {
            setSelection(null)
            const word = words[index]
            const played = word ? playedAt(word.startMs) : undefined
            if (word && played) onSeek(played.laid.startMs + word.startMs - played.range.startMs)
          }
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
