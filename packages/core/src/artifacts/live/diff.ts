// Diffs and three-way merges of sequences: the lines of a text, then its characters where both
// sides changed the same lines, and the ids of a canvas's order. A merge folds two sides' changes
// to one base together. What only one side changed is taken; what both changed alike, once; what
// both changed differently keeps both, ours first, as a CRDT keeps two concurrent insertions.

/** A run of `a[aStart, aEnd)` replaced by `b[bStart, bEnd)`. Hunks are sorted and apart. */
export interface DiffHunk {
  readonly aStart: number
  readonly aEnd: number
  readonly bStart: number
  readonly bEnd: number
}

/**
 * How many edits a diff looks for before it gives up on finding the shortest one and replaces
 * everything between the common prefix and suffix: its memory grows with their square.
 */
const MAX_EDITS = 1_000

/**
 * The hunks that turn `a` into `b`: a shortest edit script (Myers), its common prefix and suffix
 * trimmed first. Past {@link MAX_EDITS} edits, one hunk covers what lies between them.
 */
export function diffSequences<T>(a: readonly T[], b: readonly T[]): DiffHunk[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1

  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd -= 1
    bEnd -= 1
  }

  if (start === aEnd && start === bEnd) return []
  if (start === aEnd || start === bEnd) return [{ aStart: start, aEnd, bStart: start, bEnd }]

  return (
    shortestEdits(a.slice(start, aEnd), b.slice(start, bEnd), start) ?? [
      { aStart: start, aEnd, bStart: start, bEnd },
    ]
  )
}

/** The furthest `x` reached on each diagonal `k` after `d` edits, for `k` in `[-d, d]`. */
interface Frontier {
  readonly d: number
  readonly x: Int32Array
}

function reached(frontier: Frontier, k: number): number {
  return frontier.x[k + frontier.d] ?? -1
}

/** Whether the path to diagonal `k` after `d` edits comes from `k + 1`: an insertion. */
function fromAbove(previous: Frontier | undefined, k: number, d: number): boolean {
  if (!previous) return true
  return k === -d || (k !== d && reached(previous, k - 1) < reached(previous, k + 1))
}

/** Myers' O((N+M)D) search; null past the bound. Hunks are offset by `shift`. */
function shortestEdits<T>(a: readonly T[], b: readonly T[], shift: number): DiffHunk[] | null {
  const n = a.length
  const m = b.length
  const frontiers: Frontier[] = []

  for (let d = 0; d <= Math.min(n + m, MAX_EDITS); d += 1) {
    const previous = frontiers.at(-1)
    const frontier: Frontier = { d, x: new Int32Array(2 * d + 1) }
    for (let k = -d; k <= d; k += 2) {
      let x = !previous
        ? 0
        : fromAbove(previous, k, d)
          ? reached(previous, k + 1)
          : reached(previous, k - 1) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      frontier.x[k + d] = x
      if (x >= n && y >= m) {
        frontiers.push(frontier)
        return backtrack(frontiers, n, m, shift)
      }
    }
    frontiers.push(frontier)
  }
  return null
}

/** The hunks the search's frontiers lead to, walked back from the end. */
function backtrack(frontiers: readonly Frontier[], n: number, m: number, shift: number) {
  const edits: DiffHunk[] = []
  let x = n
  let y = m
  for (let d = frontiers.length - 1; d > 0; d -= 1) {
    const previous = frontiers[d - 1]
    const k = x - y
    const down = fromAbove(previous, k, d)
    const previousK = down ? k + 1 : k - 1
    const px = previous ? reached(previous, previousK) : 0
    const py = px - previousK

    // Back along the diagonal to just after the edit, then over the edit.
    const ex = down ? px : px + 1
    const ey = down ? py + 1 : py
    edits.push({ aStart: shift + px, aEnd: shift + ex, bStart: shift + py, bEnd: shift + ey })
    x = px
    y = py
  }

  // One element per edit, in reverse: adjacent ones form a hunk.
  const hunks: DiffHunk[] = []
  for (const edit of edits.reverse()) {
    const last = hunks.at(-1)
    if (last && last.aEnd === edit.aStart && last.bEnd === edit.bStart) {
      hunks[hunks.length - 1] = { ...last, aEnd: edit.aEnd, bEnd: edit.bEnd }
    } else {
      hunks.push(edit)
    }
  }
  return hunks
}

/** A text as lines, each with its line break, so joining them gives the text back. */
export function textLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** One replacement in a text: `[start, end)` by `insert`. */
export interface TextEdit {
  readonly start: number
  readonly end: number
  readonly insert: string
}

/**
 * The edits that turn `from` into `to`, in `from`'s coordinates, sorted and apart: a line diff,
 * each changed run of lines narrowed to the characters that changed.
 */
export function diffText(from: string, to: string): TextEdit[] {
  if (from === to) return []

  const a = textLines(from)
  const b = textLines(to)
  const aOffsets = offsetsOf(a)
  const bOffsets = offsetsOf(b)

  return diffSequences(a, b).map((hunk) => {
    let start = aOffsets[hunk.aStart] ?? 0
    let end = aOffsets[hunk.aEnd] ?? from.length
    let insertStart = bOffsets[hunk.bStart] ?? 0
    let insertEnd = bOffsets[hunk.bEnd] ?? to.length

    while (start < end && insertStart < insertEnd && from[start] === to[insertStart]) {
      start += 1
      insertStart += 1
    }
    while (start < end && insertStart < insertEnd && from[end - 1] === to[insertEnd - 1]) {
      end -= 1
      insertEnd -= 1
    }
    return { start, end, insert: to.slice(insertStart, insertEnd) }
  })
}

function offsetsOf(lines: readonly string[]): number[] {
  const offsets = [0]
  for (const line of lines) offsets.push((offsets.at(-1) ?? 0) + line.length)
  return offsets
}

/**
 * Folds `ours` and `theirs`, two changes of `base`, into one text. Lines only one side changed
 * are taken from it; where both changed the same lines differently, their characters are merged
 * the same way, and characters both changed are {@link interleave}d.
 */
export function mergeText(base: string, ours: string, theirs: string): string {
  if (ours === theirs || theirs === base) return ours
  if (ours === base) return theirs

  return mergeSequences(textLines(base), textLines(ours), textLines(theirs), (b, o, t) => [
    mergeSequences([...b.join("")], [...o.join("")], [...t.join("")], interleave).join(""),
  ]).join("")
}

/**
 * Folds two changes of `base` together. Runs only one side changed are taken from it, runs both
 * changed alike once, and `conflict` decides a run both changed differently, given that run of
 * the base and of each side.
 */
export function mergeSequences<T>(
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
  conflict: (base: readonly T[], ours: readonly T[], theirs: readonly T[]) => readonly T[]
): T[] {
  const oursHunks = diffSequences(base, ours)
  const theirsHunks = diffSequences(base, theirs)
  const merged: T[] = []
  let at = 0
  let i = 0
  let j = 0

  while (i < oursHunks.length || j < theirsHunks.length) {
    // A region starts at the earliest hunk and takes in every hunk that overlaps it, or that
    // starts where it starts, such as two insertions at one place.
    const start = Math.min(oursHunks[i]?.aStart ?? Infinity, theirsHunks[j]?.aStart ?? Infinity)
    let end = start
    const regionOurs: DiffHunk[] = []
    const regionTheirs: DiffHunk[] = []
    for (;;) {
      const o = oursHunks[i]
      if (o && (o.aStart < end || o.aStart === start)) {
        regionOurs.push(o)
        end = Math.max(end, o.aEnd)
        i += 1
        continue
      }
      const t = theirsHunks[j]
      if (t && (t.aStart < end || t.aStart === start)) {
        regionTheirs.push(t)
        end = Math.max(end, t.aEnd)
        j += 1
        continue
      }
      break
    }

    merged.push(...base.slice(at, start))
    const oursRun = sideOf(base, ours, regionOurs, start, end)
    const theirsRun = sideOf(base, theirs, regionTheirs, start, end)

    if (regionTheirs.length === 0 || sameRun(oursRun, theirsRun)) merged.push(...oursRun)
    else if (regionOurs.length === 0) merged.push(...theirsRun)
    else merged.push(...conflict(base.slice(start, end), oursRun, theirsRun))
    at = end
  }

  merged.push(...base.slice(at))
  return merged
}

/**
 * Both sides' changes to one run, applied together as concurrent edits are: what either deleted
 * goes, and what each inserted is kept where it inserted it, ours first, once when alike.
 */
export function interleave<T>(base: readonly T[], ours: readonly T[], theirs: readonly T[]): T[] {
  const deleted = new Set<number>()
  const inserted = new Map<number, { ours: T[]; theirs: T[] }>()

  for (const [side, run] of [
    ["ours", ours],
    ["theirs", theirs],
  ] as const) {
    for (const hunk of diffSequences(base, run)) {
      for (let index = hunk.aStart; index < hunk.aEnd; index += 1) deleted.add(index)
      const at = inserted.get(hunk.aStart) ?? { ours: [], theirs: [] }
      at[side].push(...run.slice(hunk.bStart, hunk.bEnd))
      inserted.set(hunk.aStart, at)
    }
  }

  const merged: T[] = []
  for (let index = 0; index <= base.length; index += 1) {
    const at = inserted.get(index)
    if (at) {
      // What both inserted is kept once: where one side's words start or end with the other's, as
      // when one copied what the other typed and typed more, the longer stands for both.
      if (holds(at.theirs, at.ours)) merged.push(...at.theirs)
      else if (holds(at.ours, at.theirs)) merged.push(...at.ours)
      else merged.push(...at.ours, ...at.theirs)
    }
    if (index < base.length && !deleted.has(index)) merged.push(base[index] as T)
  }
  return merged
}

/** Whether `run` starts or ends with all of `part`. */
function holds<T>(run: readonly T[], part: readonly T[]): boolean {
  if (part.length > run.length) return false
  const tail = run.length - part.length
  return (
    part.every((item, index) => run[index] === item) ||
    part.every((item, index) => run[tail + index] === item)
  )
}

/** What one side holds over `base[start, end)`, given its hunks within that region. */
function sideOf<T>(
  base: readonly T[],
  side: readonly T[],
  hunks: readonly DiffHunk[],
  start: number,
  end: number
): T[] {
  const first = hunks[0]
  const last = hunks.at(-1)
  if (!first || !last) return base.slice(start, end)

  // The side's offset from the base is the same before the first hunk and after the last.
  const sideStart = first.bStart - (first.aStart - start)
  const sideEnd = last.bEnd + (end - last.aEnd)
  return side.slice(sideStart, sideEnd)
}

function sameRun<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
