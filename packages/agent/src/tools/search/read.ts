import { Buffer } from "node:buffer"
import { type FileHandle, open } from "node:fs/promises"
import { SEARCH_LIMITS } from "./request"

export type FileText =
  | { readonly text: string }
  | { readonly skipped: "binary" | "too_large" | "unreadable" }

/** A read that knows what it will hold before it holds it. */
export interface PendingRead<R> {
  /** The bytes the read holds once started, until its result is taken. */
  readonly bytes: number
  /** Never rejects. */
  read(): Promise<R>
  /** Lets go of a read never started. Never rejects. */
  close(): Promise<void>
}

/**
 * A file opened to be read: one open, and its size from that descriptor. Its text comes from
 * {@link PendingRead.read}, unless it is too large or unreadable, which is known already.
 */
export async function openText(path: string, strict: boolean): Promise<PendingRead<FileText>> {
  let file: FileHandle | undefined

  try {
    file = await open(path, "r")
    const { size } = await file.stat()

    if (size > SEARCH_LIMITS.fileBytes) {
      await closeQuietly(file)
      return settled({ skipped: "too_large" })
    }

    const opened = file
    return {
      bytes: size,
      read: () => readText(opened, size, strict),
      close: () => closeQuietly(opened),
    }
  } catch {
    if (file) await closeQuietly(file)
    return settled({ skipped: "unreadable" })
  }
}

function settled(text: FileText): PendingRead<FileText> {
  return { bytes: 0, read: async () => text, close: async () => {} }
}

/**
 * The text of a file opened at `size` bytes, read through its descriptor and closed. A file
 * over {@link READ_AT_ONCE_BYTES} is read in two: its first {@link SEARCH_LIMITS.binaryProbeBytes},
 * then the rest unless they show it is binary, so a large binary file is never read whole. A file
 * found by the walk is read as UTF-8 leniently, so a mostly ASCII file in another encoding still
 * matches; a file named as the path must be UTF-8 text. A leading byte order mark is dropped, so
 * `^` finds the first line. Never rejects.
 */
async function readText(file: FileHandle, size: number, strict: boolean): Promise<FileText> {
  try {
    const first = size <= READ_AT_ONCE_BYTES ? size : PROBE_BYTES
    let bytes = await readBytes(file, Buffer.allocUnsafe(first), 0)
    if (bytes.subarray(0, PROBE_BYTES).includes(0)) return { skipped: "binary" }

    if (bytes.length === first && first < size) {
      const whole = Buffer.allocUnsafe(size)
      bytes.copy(whole)
      bytes = await readBytes(file, whole, first)
    }

    let text: string
    if (strict) {
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        return { skipped: "binary" }
      }
    } else {
      text = bytes.toString("utf8")
    }

    return { text: text.startsWith("\uFEFF") ? text.slice(1) : text }
  } catch {
    return { skipped: "unreadable" }
  } finally {
    await closeQuietly(file)
  }
}

const PROBE_BYTES = SEARCH_LIMITS.binaryProbeBytes

/** Up to this size, a file is read in one call: most source files, and two calls cost more. */
const READ_AT_ONCE_BYTES = 64 * 1024

/**
 * Fills `bytes` from `from` on, and returns what was read: the file as it was when opened, if it
 * grows meanwhile, or less if it shrank.
 */
async function readBytes(file: FileHandle, bytes: Buffer, from: number): Promise<Buffer> {
  let filled = from

  while (filled < bytes.length) {
    const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }

  return bytes.subarray(0, filled)
}

async function closeQuietly(file: FileHandle): Promise<void> {
  await file.close().catch(() => {})
}

/**
 * How far reads run ahead of the file searched. Reading is most of a search's time, and mostly
 * waiting: reads in flight overlap that wait. At most {@link READ_AHEAD} files are open, and a read
 * starts only while the reads started hold at most {@link READ_AHEAD_BYTES} of file with it, but
 * for the next file in line, which always starts: one file of 10 MiB past the bound at most. A
 * binary file's bytes are let go once its first bytes show it is one.
 *
 * Memory: the texts read ahead take up to twice their bytes once decoded (a string with one
 * character beyond Latin-1 takes two bytes for each): 52 MiB at worst, plus the file searched and
 * the copies its search makes. 16 MiB reads a source tree as fast as 32 did, and holds half as
 * much over a folder of large files.
 */
export const READ_AHEAD = 32
export const READ_AHEAD_BYTES = 16 * 1024 * 1024

interface Slot<T, R> {
  readonly item: T
  /** Its {@link PendingRead}, once opened. */
  pending?: PendingRead<R>
  /** Settles once {@link pending} is known. */
  opening?: Promise<void>
  /** The bytes it holds against {@link READ_AHEAD_BYTES}. */
  holds: number
  result?: Promise<R>
}

/**
 * Files read ahead of the one searched, handed back in the order they come, so a search finds the
 * same lines, in the same order, as reading one file at a time. Files are opened as they come,
 * and read as soon as they are open and their bytes fit. A search that stops reads no further than
 * {@link READ_AHEAD} files past where it stopped.
 */
export class ReadAhead<T, R> {
  readonly #slots: Slot<T, R>[] = []
  #held = 0
  #exhausted = false
  #stopped = false

  constructor(
    private readonly items: Iterator<T>,
    /** Never rejects. */
    private readonly open: (item: T) => Promise<PendingRead<R>>,
    /** What a read that holds nothing once done looks like, a binary file. */
    private readonly holdsNothing: (result: R) => boolean = () => false
  ) {}

  async next(): Promise<{ readonly item: T; readonly read: R } | undefined> {
    this.#fill()
    const slot = this.#slots[0]
    if (!slot) return undefined

    await slot.opening
    this.#start()
    const read = await (slot.result as Promise<R>)

    this.#slots.shift()
    this.#held -= slot.holds
    this.#fill()
    this.#start()

    return { item: slot.item, read }
  }

  /**
   * Starts no other read, waits for those in flight and closes the files never read: no file
   * stays open past the search.
   */
  async stop(): Promise<void> {
    this.#exhausted = true
    this.#stopped = true

    await Promise.all(
      this.#slots.splice(0).map(async (slot) => {
        await slot.opening
        if (slot.result) await slot.result
        else await slot.pending?.close()
      })
    )
  }

  #fill(): void {
    while (!this.#exhausted && this.#slots.length < READ_AHEAD) {
      const step = this.items.next()
      if (step.done) {
        this.#exhausted = true
        return
      }

      const slot: Slot<T, R> = { item: step.value, holds: 0 }
      this.#slots.push(slot)
      slot.opening = this.open(step.value).then((pending) => {
        slot.pending = pending
        this.#start()
      })
    }
  }

  /**
   * Starts the reads of the files opened, as long as their bytes fit. The first file in line always
   * starts: the search waits on it, and no read behind it can make room.
   */
  #start(): void {
    if (this.#stopped) return

    for (let index = 0; index < this.#slots.length; index += 1) {
      const slot = this.#slots[index] as Slot<T, R>
      const pending = slot.pending
      if (slot.result || !pending) continue
      if (index > 0 && this.#held + pending.bytes > READ_AHEAD_BYTES) continue

      slot.holds = pending.bytes
      this.#held += slot.holds
      slot.result = pending.read().then((result) => {
        if (this.holdsNothing(result) && this.#slots.includes(slot)) {
          this.#held -= slot.holds
          slot.holds = 0
          this.#start()
        }
        return result
      })
    }
  }
}
