import { link, readFile, rm, writeFile } from "node:fs/promises"
import { delay } from "./abort"

/** How often a run waiting for a thread's files directory looks again. */
const POLL_MS = 100

/**
 * How long a run waits for a live holder before it takes the directory over. Only one run of a
 * thread is active at a time, so a holder still alive after its run ended is releasing (seconds)
 * or stopping on a lost lease (its next renewal, within seconds); past this, its process id was
 * reused, or it hangs.
 */
const TAKEOVER_MS = 60_000

/** Who holds a thread's files directory, as its lock file says. */
interface Holder {
  readonly pid: number
  readonly runId: string
}

/**
 * Hold a thread's files directory for one run, across every process on the computer: each `sixb`
 * opened in the folder shares the directory, and the next turn of a thread can start in another
 * one while the last turn's release still removes the directory. The lock is a file beside the
 * directory, created exclusively and naming its holder; one whose process is gone is stale, and
 * taken over. Resolves with the release, which removes the lock only while it is still this run's.
 *
 * Only one run of a thread is active at a time, so no two runs take a stale lock over at once.
 */
export async function holdRunFiles(input: {
  /** The thread's files directory. */
  readonly directory: string
  readonly runId: string
  readonly signal: AbortSignal
}): Promise<() => Promise<void>> {
  const lock = `${input.directory}.lock`
  const own = JSON.stringify({ pid: process.pid, runId: input.runId } satisfies Holder)
  const deadline = Date.now() + TAKEOVER_MS

  for (;;) {
    if (await create(lock, own, input.runId)) break

    const holder = await readHolder(lock)
    // Released between the two reads: try again at once.
    if (holder === null) continue

    if (holder === undefined || !alive(holder.pid) || Date.now() >= deadline) {
      if (holder && alive(holder.pid)) {
        console.warn(
          `[SixbAgent] Run '${input.runId}' takes over ${input.directory} from run '${holder.runId}' (process ${holder.pid}), which did not give it back in time.`
        )
      }
      await rm(lock, { force: true })
      continue
    }

    await delay(POLL_MS, input.signal)
  }

  return async () => {
    if ((await readFile(lock, "utf8").catch(() => null)) === own) await rm(lock, { force: true })
  }
}

/**
 * Create the lock file, unless one exists. Linked from a file already written, so no reader ever
 * finds it empty.
 */
async function create(lock: string, contents: string, runId: string): Promise<boolean> {
  const written = `${lock}.${process.pid}.${runId}`
  await writeFile(written, contents)
  try {
    await link(written, lock)
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  } finally {
    await rm(written, { force: true })
  }
}

/** The lock's holder; null once it is gone, undefined when it names none a run can wait for. */
async function readHolder(lock: string): Promise<Holder | null | undefined> {
  let text: string
  try {
    text = await readFile(lock, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }

  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) return undefined

    const { pid, runId } = parsed as Record<string, unknown>
    return Number.isSafeInteger(pid) && typeof runId === "string"
      ? { pid: pid as number, runId }
      : undefined
  } catch {
    return undefined
  }
}

/** Whether a process runs: one owned by another user still does. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined
}
