import { AgentToolPublicError, type CommandResult } from "@sixb/core"
import { AgentToolExecutionError } from "../errors"
import { type AgentSandboxHandle, contextPath } from "../sandbox-handle"

/** The largest file `edit` changes and `write` writes: a whole file passes through the harness. */
export const MAX_EDITED_FILE_BYTES = 1024 * 1024

const COMMAND_TIMEOUT_MS = 30_000
/**
 * Contents travel as base64 in an environment variable, a few calls for a large file: Linux caps
 * one variable at 128 KiB, and a sandbox has no stdin or file API that reaches every root.
 */
const CHUNK_CHARACTERS = 96 * 1024

/** What the model last saw of a file: one version of it, all of it or the start of it. */
export interface SeenFile {
  readonly fingerprint: string
  /** It saw every line: in one read, or in reads that follow on from line 1 to the last. */
  readonly whole: boolean
  /** While not whole, the last line it saw with no gap from line 1. */
  readonly through: number
}

/**
 * What a run's model has seen of each file, by real path, as `read` showed it or `edit` and
 * `write` left it; and the queue those two take turns in.
 *
 * `write` replaces an existing file only when the model saw all of it as it is now, so it never
 * drops lines the model was not shown. `edit` needs no read, since `old_string` must match the
 * file as it is, but says so when the file is not the version the model last saw.
 */
export class SeenFiles {
  readonly #files = new Map<string, SeenFile>()
  /** Each read by its tool call, for the context guard to say when it cut one. */
  readonly #reads = new Map<string, SeenRead>()
  #queue: Promise<unknown> = Promise.resolve()

  get(realPath: string): SeenFile | undefined {
    return this.#files.get(realPath)
  }

  /** `read` showed lines `from` to `to` of this version, the file's last line among them if `end`. */
  recordRead(
    realPath: string,
    fingerprint: string,
    page: { readonly from: number; readonly to: number; readonly end: boolean },
    toolCallId?: string
  ): void {
    const seen = this.#files.get(realPath)
    const before = seen?.fingerprint === fingerprint ? seen : undefined
    if (toolCallId !== undefined) {
      this.#reads.set(toolCallId, { realPath, fingerprint, from: page.from, before })
    }
    if (before?.whole) return

    this.#files.set(realPath, followOn(fingerprint, before, page))
  }

  /**
   * The context guard cut what a read returned before the model read it: it is shown the file
   * only up to `shownThrough`. What that read recorded becomes what the model really saw, so a
   * `write` still needs the rest read first.
   */
  recordCut(toolCallId: string, shownThrough: number): void {
    const read = this.#reads.get(toolCallId)
    if (read === undefined) return

    // Seen whole before this read, or since replaced by another version: nothing to take back.
    if (read.before?.whole) return
    if (this.#files.get(read.realPath)?.fingerprint !== read.fingerprint) return

    const page = { from: read.from, to: shownThrough, end: false }
    this.#files.set(read.realPath, followOn(read.fingerprint, read.before, page))
  }

  /** `edit` or `write` left this version: the model knows all of it when `whole`. */
  recordWrite(realPath: string, fingerprint: string, whole: boolean): void {
    this.#files.set(realPath, { fingerprint, whole, through: 0 })
  }

  /**
   * Run a change once those queued before it have settled. A step's tool calls run at once, and
   * the commit's check that a file is unchanged is not atomic: two edits of one file both passed
   * it, and the second write lost the first edit or left the file torn. The queue is the run's:
   * a sub-agent working in its parent's workspace has its own.
   */
  change<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task)
    this.#queue = result.catch(() => {})
    return result
  }
}

/** A read as `SeenFiles` recorded it, with what the model had seen of that version before it. */
interface SeenRead {
  readonly realPath: string
  readonly fingerprint: string
  readonly from: number
  readonly before: SeenFile | undefined
}

/** What the model has seen of a version once a page of it follows what it saw `before`. */
function followOn(
  fingerprint: string,
  before: SeenFile | undefined,
  page: { readonly from: number; readonly to: number; readonly end: boolean }
): SeenFile {
  const through = before?.through ?? 0
  const follows = page.from <= through + 1
  return {
    fingerprint,
    whole: follows && page.end,
    through: follows ? Math.max(through, page.to) : through,
  }
}

export type LoadedSandboxFile =
  | { readonly kind: "missing" }
  | {
      readonly kind: "file"
      readonly realPath: string
      readonly fingerprint: string
      readonly bytes: Uint8Array
    }

/** Read a whole file for `edit` or `write`: where it really is, its fingerprint and its bytes. */
export async function loadSandboxFile(
  handle: AgentSandboxHandle,
  input: { readonly path: string; readonly tool: string; readonly signal: AbortSignal }
): Promise<LoadedSandboxFile> {
  const result = await run(handle, input.tool, input.signal, LOAD_SCRIPT, [
    input.path,
    contextPath(handle),
    String(MAX_EDITED_FILE_BYTES),
  ])
  if (result.exitCode === 10) return { kind: "missing" }
  if (result.exitCode !== 0) throw pathError(input.tool, input.path, result)

  const [fingerprint = "", realPath = "", ...contents] = result.stdout.split("\n")
  const bytes = Buffer.from(contents.join(""), "base64")
  if (!isFingerprint(fingerprint) || bytes.byteLength !== Number(fingerprint.split(":")[1])) {
    throw publicError(input.tool, `'${input.path}' changed while it was being read; try again.`)
  }
  return {
    kind: "file",
    realPath: realPath || input.path,
    fingerprint,
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  }
}

/**
 * Write `bytes` over the file `loaded` found when it is still that file (or create it when it was
 * missing), keeping an existing file's mode. Missing parent directories are created inside the
 * run's roots. Errors name `path`, as the model wrote it. Returns where the file is and its new
 * fingerprint.
 */
export async function commitSandboxFile(
  handle: AgentSandboxHandle,
  input: {
    readonly path: string
    readonly loaded: LoadedSandboxFile
    readonly bytes: Uint8Array
    readonly tool: string
    readonly signal: AbortSignal
  }
): Promise<{ readonly realPath: string; readonly fingerprint: string }> {
  const { loaded } = input
  const target = loaded.kind === "file" ? loaded.realPath : input.path
  const expected = loaded.kind === "file" ? loaded.fingerprint : "missing"
  const encoded = Buffer.from(input.bytes).toString("base64")
  let stage = ""
  let offset = 0
  for (; offset + CHUNK_CHARACTERS < encoded.length; offset += CHUNK_CHARACTERS) {
    const result = await run(
      handle,
      input.tool,
      input.signal,
      STAGE_SCRIPT,
      [stage],
      encoded.slice(offset, offset + CHUNK_CHARACTERS)
    )
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new AgentToolExecutionError(input.tool, {
        cause: new Error(result.stderr.trim() || `Staging exited with code ${result.exitCode}.`),
      })
    }
    stage = result.stdout.trim()
  }

  const result = await run(
    handle,
    input.tool,
    input.signal,
    COMMIT_SCRIPT,
    [target, contextPath(handle), expected, stage],
    encoded.slice(offset)
  )
  if (result.exitCode === 15) {
    const now =
      result.stdout.trim() === "missing"
        ? "was deleted"
        : loaded.kind === "missing"
          ? "was created"
          : "changed"
    // A write replaces what is there now, so the model has to see it first.
    const next =
      input.tool === "write" && now !== "was deleted" ? "Read all of it first." : "Try again."
    throw publicError(
      input.tool,
      `'${input.path}' ${now} while your ${input.tool} was being saved, so nothing was written. ${next}`
    )
  }
  if (result.exitCode !== 0) throw pathError(input.tool, input.path, result)

  const [fingerprint = "", realPath = ""] = result.stdout.split("\n")
  if (!isFingerprint(fingerprint)) {
    throw new AgentToolExecutionError(input.tool, {
      cause: new Error(`Unexpected output: ${result.stdout.slice(0, 200)}`),
    })
  }
  return { realPath: realPath || input.path, fingerprint }
}

export function publicError(tool: string, message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] ${tool}: ${message}`)
}

async function run(
  handle: AgentSandboxHandle,
  tool: string,
  signal: AbortSignal,
  script: string,
  args: readonly string[],
  chunk?: string
): Promise<CommandResult> {
  let result: CommandResult
  try {
    result = await handle.sandbox.runCommand("bash", ["-c", script, `sixb-${tool}`, ...args], {
      cwd: handle.sandbox.workingDirectory,
      env: { ...(handle.env ?? {}), ...(chunk === undefined ? {} : { SIXB_CHUNK: chunk }) },
      timeout: COMMAND_TIMEOUT_MS,
      signal,
    })
  } catch (error) {
    signal.throwIfAborted()
    throw new AgentToolExecutionError(tool, { cause: error })
  }
  signal.throwIfAborted()
  return result
}

function pathError(tool: string, path: string, result: CommandResult): Error {
  switch (result.exitCode) {
    case 10:
      return publicError(tool, `'${path}' does not exist.`)
    case 11:
      return publicError(
        tool,
        `'${path}' resolves outside the working directory and the run's context directory.`
      )
    case 12:
      return publicError(tool, `'${path}' is a directory, not a file.`)
    case 13:
      return publicError(tool, `'${path}' is not a regular file.`)
    case 14:
      return publicError(
        tool,
        `'${path}' is larger than ${MAX_EDITED_FILE_BYTES / 1024 / 1024} MiB: change it with bash.`
      )
    default:
      return new AgentToolExecutionError(tool, {
        cause: new Error(
          result.stderr.trim() || `Sandbox command exited with code ${result.exitCode}.`
        ),
      })
  }
}

export function isFingerprint(value: string): boolean {
  return /^\d+:\d+$/.test(value)
}

/**
 * Bash functions shared with `read`: a file's fingerprint as `crc:size` from `cksum`, and a real
 * path on one line (empty when the path holds a newline, which then goes unrecorded). Neither
 * needs `tr` or `awk`, which some sandbox images lack.
 */
export const FINGERPRINT_FUNCTIONS = `fingerprint() {
  local sum rest
  sum="$(cksum < "$1")" || return 1
  rest="\${sum#* }"
  printf '%s:%s\\n' "\${sum%% *}" "\${rest%% *}"
}
print_path() {
  case "$1" in *$'\\n'*) printf '\\n' ;; *) printf '%s\\n' "$1" ;; esac
}`

// The run's roots, and the requested path made absolute.
const ROOTS = `root="$(pwd -P)"
context="$root"
if [ -d "$2" ]; then context="$(cd -P -- "$2" && pwd)"; fi
inside() { case "$1" in "$root"/*|"$context"/*) return 0 ;; esac; return 1; }
case "$1" in /*) requested="$1" ;; *) requested="$root/$1" ;; esac
${FINGERPRINT_FUNCTIONS}`

// Prints the fingerprint, the real path, then the contents as base64 over as many lines as it takes.
const LOAD_SCRIPT = `set -u
${ROOTS}
[ -e "$requested" ] || exit 10
target="$(realpath "$requested")" || exit 10
inside "$target" || exit 11
[ ! -d "$target" ] || exit 12
[ -f "$target" ] || exit 13
sum="$(fingerprint "$target")" || exit 19
[ "\${sum#*:}" -le "$3" ] || exit 14
printf '%s\\n' "$sum"
print_path "$target"
base64 < "$target"`

// Appends one chunk of base64 to a staging file, made on the first call; prints its path.
const STAGE_SCRIPT = `set -eu
stage="\${1:-}"
if [ -z "$stage" ]; then stage="$(mktemp "\${TMPDIR:-/tmp}/sixb-write.XXXXXX")"; fi
printf '%s' "$SIXB_CHUNK" >> "$stage"
printf '%s' "$stage"`

// Writes when the file is still what the run expects; exit 15 prints what it is instead. Decodes
// in full before touching the file, and writes through it (cat >) so its mode and links stay.
const COMMIT_SCRIPT = `set -u
${ROOTS}
if [ -L "$requested" ] && [ ! -e "$requested" ]; then exit 11; fi
if [ -e "$requested" ]; then
  target="$(realpath "$requested")" || exit 19
  inside "$target" || exit 11
  [ ! -d "$target" ] || exit 12
  [ -f "$target" ] || exit 13
  current="$(fingerprint "$target")" || exit 19
else
  dir="$(dirname -- "$requested")"
  while [ ! -d "$dir" ]; do dir="$(dirname -- "$dir")"; done
  inside "$(cd -P -- "$dir" && pwd)/" || exit 11
  mkdir -p -- "$(dirname -- "$requested")" || exit 19
  parent="$(cd -P -- "$(dirname -- "$requested")" && pwd)"
  inside "$parent/" || exit 11
  target="$parent/$(basename -- "$requested")"
  current=missing
fi
stage="\${4:-}"
if [ "$current" != "$3" ]; then
  [ -z "$stage" ] || rm -f "$stage"
  printf '%s' "$current"
  exit 15
fi
decoded="$(mktemp "\${TMPDIR:-/tmp}/sixb-write.XXXXXX")" || exit 19
if [ -n "$stage" ]; then
  printf '%s' "\${SIXB_CHUNK:-}" >> "$stage"
  base64 -d < "$stage" > "$decoded" || { rm -f "$stage" "$decoded"; exit 19; }
  rm -f "$stage"
else
  printf '%s' "\${SIXB_CHUNK:-}" | base64 -d > "$decoded" || { rm -f "$decoded"; exit 19; }
fi
cat "$decoded" > "$target" || { rm -f "$decoded"; exit 19; }
rm -f "$decoded"
fingerprint "$target"
print_path "$target"`
