import type { VideoRange } from "@sixb/core/artifacts/live"

// Editing a recording by what is said in it: the stretches of its file that words, pauses and
// fillers take, which the editor cuts out. Times are milliseconds into the recording's file.

/** A word of a transcript, as the project's transcription model timed it. */
export interface TranscriptWord {
  readonly text: string
  readonly startMs: number
  readonly endMs: number
}

/** The air left beside a cut, so a word kept is never clipped. */
export const AIR_MS = 120

/** A pause at least this long is a silence that "Remove silences" shortens. */
export const SILENCE_MS = 700

/** How far a cut moves to land on a cut of the picture, where it hides best. */
export const SNAP_TO_CUT_MS = 150

/** The words people say while they think, in the languages the app speaks. */
const FILLERS: ReadonlySet<string> = new Set([
  "um",
  "umm",
  "uh",
  "uhh",
  "uhm",
  "erm",
  "er",
  "hmm",
  "mm",
  "mhm",
  "euh",
  "heu",
  "hum",
  "bah",
  "ben",
])

/** Whether a word is a filler, its case and punctuation aside. */
export function isFiller(text: string): boolean {
  return FILLERS.has(
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}]/gu, "")
  )
}

/**
 * The stretch to cut to remove the words `from` to `to`, both included: from just after the word
 * before them to just before the word after them, leaving each its air, so the pause before the
 * words goes with them. Within `bounds`, the part of the file the clip plays, and moved onto a
 * cut of the picture when one is that near.
 */
export function wordsCut(
  words: readonly TranscriptWord[],
  from: number,
  to: number,
  bounds: VideoRange,
  cuts: readonly number[] = []
): VideoRange | null {
  const first = words[from]
  const last = words[to]
  if (!first || !last || to < from) return null

  const before = words[from - 1]
  const after = words[to + 1]
  let startMs = before
    ? before.endMs + Math.min(AIR_MS, (first.startMs - before.endMs) / 2)
    : bounds.startMs
  let endMs = after
    ? after.startMs - Math.min(AIR_MS, (after.startMs - last.endMs) / 2)
    : bounds.endMs

  // Never into a word kept.
  startMs = Math.min(startMs, first.startMs)
  endMs = Math.max(endMs, last.endMs)

  startMs = landOnCut(startMs, cuts, before ? before.endMs : bounds.startMs, first.startMs)
  endMs = landOnCut(endMs, cuts, last.endMs, after ? after.startMs : bounds.endMs)

  startMs = Math.max(startMs, bounds.startMs)
  endMs = Math.min(endMs, bounds.endMs)
  return endMs > startMs ? { startMs: Math.round(startMs), endMs: Math.round(endMs) } : null
}

/**
 * The pauses longer than {@link SILENCE_MS}, between words and at either end of `bounds`, each
 * shortened to the air either side of it.
 */
export function silences(words: readonly TranscriptWord[], bounds: VideoRange): VideoRange[] {
  const inside = words.filter((word) => word.endMs > bounds.startMs && word.startMs < bounds.endMs)
  const edges = [
    bounds.startMs - AIR_MS,
    ...inside.flatMap((word) => [word.startMs, word.endMs]),
    bounds.endMs + AIR_MS,
  ]

  const cut: VideoRange[] = []
  for (let index = 0; index + 1 < edges.length; index += 2) {
    const quiet = { startMs: edges[index] ?? 0, endMs: edges[index + 1] ?? 0 }
    if (quiet.endMs - quiet.startMs < SILENCE_MS) continue
    cut.push({
      startMs: Math.max(bounds.startMs, quiet.startMs + AIR_MS),
      endMs: Math.min(bounds.endMs, quiet.endMs - AIR_MS),
    })
  }
  return cut.filter((range) => range.endMs > range.startMs)
}

/** The stretches the fillers take within `bounds`, each with the pause before it. */
export function fillers(
  words: readonly TranscriptWord[],
  bounds: VideoRange,
  cuts: readonly number[] = []
): VideoRange[] {
  return words.flatMap((word, index) => {
    if (!isFiller(word.text) || word.endMs <= bounds.startMs || word.startMs >= bounds.endMs) {
      return []
    }
    const range = wordsCut(words, index, index, bounds, cuts)
    return range ? [range] : []
  })
}

/** How long the ranges last together, once joined where they overlap. */
export function rangesLength(ranges: readonly VideoRange[]): number {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs)
  let total = 0
  let end = Number.NEGATIVE_INFINITY
  for (const range of sorted) {
    const start = Math.max(range.startMs, end)
    if (range.endMs > start) total += range.endMs - start
    end = Math.max(end, range.endMs)
  }
  return total
}

/** The word said at `ms`, or the one before it during a pause; -1 before the first. */
export function wordAt(words: readonly TranscriptWord[], ms: number): number {
  let low = 0
  let high = words.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if ((words[middle]?.startMs ?? 0) <= ms) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/** The words whose text holds `query`, by index, its case and accents aside. */
export function findWords(words: readonly TranscriptWord[], query: string): number[] {
  const wanted = fold(query.trim())
  if (wanted === "") return []

  // A query of several words matches them in a row.
  const parts = wanted.split(/\s+/)
  const folded = words.map((word) => fold(word.text))
  const found: number[] = []
  for (let index = 0; index + parts.length <= folded.length; index += 1) {
    if (parts.every((part, offset) => (folded[index + offset] ?? "").includes(part))) {
      found.push(index)
    }
  }
  return found
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
}

/** `ms` moved onto a cut between `low` and `high` within {@link SNAP_TO_CUT_MS}, if one is. */
function landOnCut(ms: number, cuts: readonly number[], low: number, high: number): number {
  let best = ms
  for (const cut of cuts) {
    if (cut < low || cut > high || Math.abs(cut - ms) > SNAP_TO_CUT_MS) continue
    if (best === ms || Math.abs(cut - ms) < Math.abs(best - ms)) best = cut
  }
  return best
}
