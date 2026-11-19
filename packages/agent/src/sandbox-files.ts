import { posix } from "node:path"
import type { CommandResult, FileRef } from "@sixb/core"
import { isFileRef } from "@sixb/core/blob-storage"
import { loginShellArgs } from "./login-shell"
import { type AgentSandboxHandle, contextPath } from "./sandbox-handle"

// Every read of sandbox files the worker makes goes through these two scripts. A sandbox has no
// file-read API, so a file comes back as base64 on stdout; the scripts refuse symbolic links and
// paths that resolve outside the working directory, and bound how much they print.

/** Why a sandbox file could not be listed or read. The message is safe to show to the Agent. */
export type SandboxFileErrorReason =
  | "invalid_path"
  | "outside_root"
  | "not_found"
  | "too_large"
  | "changed"
  | "failed"

export class SandboxFileError extends Error {
  constructor(
    readonly reason: SandboxFileErrorReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "SandboxFileError"
  }
}

export interface SandboxFileEntry {
  /** Path relative to the listed directory, with `/` separators and no `.` or `..` segments. */
  readonly relativePath: string
  readonly sizeBytes: number
}

export interface SandboxFileListing {
  /** False when nothing is at the path, or it is not a directory: then nothing is listed. */
  readonly directory: boolean
  /** Regular files under the directory, sorted by path. Symbolic links are never listed. */
  readonly files: readonly SandboxFileEntry[]
  /** True when the directory held more than `maxFiles` files; only the first ones are listed. */
  readonly truncated: boolean
}

interface SandboxCommandOptions {
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

/**
 * Where a run reads files: its working directory, and its context directory when that lies
 * elsewhere, as it does in a folder on a computer. Absolute, the working directory first.
 */
export function sandboxRoots(handle: AgentSandboxHandle): readonly string[] {
  const root = posix.resolve(handle.sandbox.workingDirectory)
  const context = contextPath(handle)
  return context === root || context.startsWith(`${root}/`) ? [root] : [root, context]
}

/**
 * Resolve `requestedPath` against the sandbox working directory. Throws when the path is empty or
 * leaves both the working directory and the run's context directory; symbolic links are checked
 * when the file is read.
 */
export function resolveSandboxPath(handle: AgentSandboxHandle, requestedPath: string): string {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw new SandboxFileError("invalid_path", "path must be a non-empty sandbox file path")
  }
  // `resolve`, not `normalize`: it drops a trailing slash, which would break the prefix check.
  const roots = sandboxRoots(handle)
  const absolutePath = posix.resolve(roots[0] ?? "/", requestedPath)
  if (!roots.some((root) => absolutePath.startsWith(`${root}/`))) {
    throw new SandboxFileError(
      "outside_root",
      roots.length > 1
        ? "path must stay inside the working directory or the run's context directory"
        : "path must stay inside the sandbox working directory"
    )
  }
  return absolutePath
}

/**
 * List the regular files under `directory`, up to `maxFiles`. A missing directory lists nothing;
 * output that does not parse throws, since a listing that skips a line drops a file silently.
 */
export async function listSandboxFiles(
  handle: AgentSandboxHandle,
  input: SandboxCommandOptions & {
    readonly directory: string
    readonly maxFiles: number
  }
): Promise<SandboxFileListing> {
  const result = await runScript(handle, LIST_SANDBOX_FILES_SCRIPT, input, {
    SIXB_LIST_DIR: input.directory,
    SIXB_LIST_MAX_FILES: String(input.maxFiles),
  })
  if (result.exitCode !== 0) {
    throw new SandboxFileError(
      "failed",
      `directory could not be listed (${result.stderr.trim() || `exit ${result.exitCode}`})`
    )
  }

  const files: SandboxFileEntry[] = []
  let directory = false
  let truncated = false
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    if (line === "DIRECTORY") {
      directory = true
      continue
    }
    if (line === "LIMIT") {
      truncated = true
      continue
    }
    const [sizeSource = "", relativePathBase64] = line.split("\t")
    const relativePath = relativePathBase64 ? decodeBase64Text(relativePathBase64) : null
    if (!/^\d+$/.test(sizeSource) || !relativePath || !isSafeRelativePath(relativePath)) {
      throw new SandboxFileError(
        "failed",
        `directory could not be listed (an entry did not parse: ${JSON.stringify(line.slice(0, 200))})`
      )
    }
    files.push({ relativePath, sizeBytes: Number(sizeSource) })
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { directory, files, truncated }
}

/**
 * Read one regular file inside the sandbox working directory. Refuses symbolic links, paths whose
 * parent resolves outside the working directory, and files larger than `maxBytes`.
 */
export async function readSandboxFile(
  handle: AgentSandboxHandle,
  input: SandboxCommandOptions & {
    /** An absolute path, as `resolveSandboxPath` returns it. */
    readonly path: string
    readonly maxBytes: number
  }
): Promise<Uint8Array> {
  const result = await runCheckedFileScript(handle, READ_SANDBOX_FILE_SCRIPT, input, {
    SIXB_READ_MAX_BYTES: String(input.maxBytes),
  })
  if (result.exitCode === 3) {
    throw new SandboxFileError("too_large", `file exceeds the ${input.maxBytes}-byte limit`)
  }
  if (result.exitCode !== 0) {
    throw new SandboxFileError(
      "failed",
      `file could not be read (${result.stderr.trim() || `exit ${result.exitCode}`})`
    )
  }

  const separator = result.stdout.indexOf("\n")
  const sizeBytes = Number(result.stdout.slice(0, separator))
  const bytes = Buffer.from(
    separator < 0 ? "" : result.stdout.slice(separator + 1).trim(),
    "base64"
  )
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || bytes.byteLength !== sizeBytes) {
    throw new SandboxFileError("changed", "file changed while it was being read")
  }
  // A view, not a copy: a large file is held once more already, as the base64 it came as.
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** The size of one regular file, checked as {@link readSandboxFile} checks it, without reading it. */
export async function statSandboxFile(
  handle: AgentSandboxHandle,
  input: SandboxCommandOptions & {
    /** An absolute path, as `resolveSandboxPath` returns it. */
    readonly path: string
  }
): Promise<number> {
  const result = await runCheckedFileScript(handle, STAT_SANDBOX_FILE_SCRIPT, input, {})
  const sizeBytes = Number(result.stdout.trim())
  if (result.exitCode !== 0 || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new SandboxFileError(
      "failed",
      `file could not be read (${result.stderr.trim() || `exit ${result.exitCode}`})`
    )
  }
  return sizeBytes
}

/**
 * Upload one regular file, checked as {@link readSandboxFile} checks it, with the run's own `sixb`:
 * it reaches the API as the run, so the bytes go from the sandbox's disk to blob storage, never
 * through a command's output or the worker's memory. Resolves to the reference the API issued,
 * whose digest is the bytes the API received.
 */
export async function uploadSandboxFile(
  handle: AgentSandboxHandle,
  input: SandboxCommandOptions & {
    /** An absolute path, as `resolveSandboxPath` returns it. */
    readonly path: string
    readonly mediaType: string
  }
): Promise<FileRef> {
  const result = await runCheckedFileScript(handle, UPLOAD_SANDBOX_FILE_SCRIPT, input, {
    SIXB_UPLOAD_MEDIA_TYPE: input.mediaType,
  })
  if (result.exitCode !== 0) {
    throw new SandboxFileError(
      "failed",
      `file could not be uploaded (${cliErrorMessage(result.stderr) ?? `exit ${result.exitCode}`})`
    )
  }

  const fileRef = parseJson(result.stdout.trim().split("\n").at(-1) ?? "")
  if (!isFileRef(fileRef)) {
    throw new SandboxFileError("failed", "file was uploaded, but its reference did not parse")
  }
  return fileRef
}

/**
 * Past this, a file moves between the worker and the sandbox through the API, by the sandbox's own
 * `sixb`, never through a command's output or `writeFiles`: either holds it whole in the worker's
 * memory, and a command's output, as base64, must fit what its provider keeps. Below it, a direct
 * read or write is quicker than an upload's or a download's few requests.
 */
export const SANDBOX_INLINE_BYTES = 8 * 1024 * 1024

/**
 * Puts files of artifact versions in the sandbox, each fetched by the run's own `sixb` from the
 * API as the run's requester reads it: the bytes never pass through the worker. A file that does
 * not arrive at its size fails them all.
 */
export async function downloadArtifactFiles(
  handle: AgentSandboxHandle,
  files: readonly {
    readonly artifactId: string
    readonly version: number
    /** The file's path in the version. */
    readonly path: string
    readonly sizeBytes: number
    /** Absolute, in the sandbox. */
    readonly to: string
  }[],
  options: SandboxCommandOptions
): Promise<void> {
  if (files.length === 0) return

  const result = await handle.sandbox.runCommand(
    "bash",
    [
      "-c",
      DOWNLOAD_ARTIFACT_FILES_SCRIPT,
      "download",
      ...files.flatMap((file) => [
        file.artifactId,
        String(file.version),
        file.path,
        file.to,
        String(file.sizeBytes),
      ]),
    ],
    { env: { ...(handle.env ?? {}) }, timeout: options.timeoutMs, signal: options.signal }
  )
  options.signal.throwIfAborted()
  if (result.exitCode !== 0 || result.timedOut) {
    throw new SandboxFileError(
      "failed",
      `artifact files could not be fetched (${cliErrorMessage(result.stderr) ?? `exit ${result.exitCode}`})`
    )
  }
}

/**
 * Runs a script that starts with {@link CHECKED_FILE_PRELUDE} on `input.path`, answering for the
 * prelude's own refusals.
 */
async function runCheckedFileScript(
  handle: AgentSandboxHandle,
  script: string,
  input: SandboxCommandOptions & { readonly path: string },
  env: Readonly<Record<string, string>>
): Promise<CommandResult> {
  const result = await runScript(handle, script, input, {
    SIXB_READ_PATH_B64: Buffer.from(input.path, "utf-8").toString("base64"),
    SIXB_READ_ROOTS: sandboxRoots(handle).join("\n"),
    ...env,
  })
  if (result.exitCode === 2) {
    throw new SandboxFileError(
      "not_found",
      "file does not exist, is not a regular file, or is a symbolic link"
    )
  }
  if (result.exitCode === 4) {
    throw new SandboxFileError(
      "outside_root",
      "resolved path escapes the sandbox working directory and the run's context directory"
    )
  }
  return result
}

/** The message of the JSON error `sixb` prints on stderr, when it printed one. */
function cliErrorMessage(stderr: string): string | undefined {
  const printed = parseJson(stderr.trim().split("\n").at(-1) ?? "")
  const error = (printed as { readonly error?: { readonly message?: unknown } } | null)?.error
  return typeof error?.message === "string" ? error.message : stderr.trim() || undefined
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** One file of {@link readSandboxFiles}: its bytes, or why it could not be read. */
export type SandboxFileRead =
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly error: SandboxFileErrorReason }

/**
 * Read many regular files in one command, with the checks {@link readSandboxFile} makes on each.
 * A file that fails is reported in its place and the others are read: one per path, in order.
 * Everything comes back on one stdout, so keep the files' total to what a command prints.
 */
export async function readSandboxFiles(
  handle: AgentSandboxHandle,
  input: SandboxCommandOptions & {
    /** Absolute paths, as `resolveSandboxPath` returns them. */
    readonly paths: readonly string[]
    /** The most each file may hold. */
    readonly maxBytes: number
  }
): Promise<SandboxFileRead[]> {
  if (input.paths.length === 0) return []

  const result = await runScript(handle, READ_SANDBOX_FILES_SCRIPT, input, {
    SIXB_READ_PATHS: input.paths
      .map((path) => Buffer.from(path, "utf-8").toString("base64"))
      .join("\n"),
    SIXB_READ_ROOTS: sandboxRoots(handle).join("\n"),
    SIXB_READ_MAX_BYTES: String(input.maxBytes),
  })
  if (result.exitCode !== 0) {
    throw new SandboxFileError(
      "failed",
      `files could not be read (${result.stderr.trim() || `exit ${result.exitCode}`})`
    )
  }

  const lines = result.stdout.split("\n")
  return input.paths.map((path, index) => {
    const [status = "", size = "", data = ""] = (lines[index] ?? "").split("\t")
    if (status !== "ok") {
      return { path, error: isReadError(status) ? status : "failed" }
    }

    const bytes = Buffer.from(data, "base64")
    if (bytes.byteLength !== Number(size)) return { path, error: "changed" }
    return { path, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  })
}

function isReadError(status: string): status is SandboxFileErrorReason {
  return status === "not_found" || status === "outside_root" || status === "too_large"
}

/** What a path names once its symbolic links are followed. */
export type SandboxPathEntry =
  | {
      readonly kind: "file" | "directory"
      /** Absolute, every symbolic link along it followed. */
      readonly realPath: string
    }
  | { readonly kind: "missing" }
  | { readonly kind: "link" }

/**
 * Follow the symbolic links along `path`, an absolute path as `resolveSandboxPath` returns it, to
 * where it really is. A path that is itself a link is reported as one, as reads refuse it.
 */
export async function resolveSandboxEntry(
  handle: AgentSandboxHandle,
  input: SandboxCommandOptions & { readonly path: string }
): Promise<SandboxPathEntry> {
  const result = await runScript(handle, RESOLVE_SANDBOX_PATH_SCRIPT, input, {
    SIXB_RESOLVE_PATH_B64: Buffer.from(input.path, "utf-8").toString("base64"),
  })
  if (result.exitCode !== 0) {
    throw new SandboxFileError(
      "failed",
      `path could not be resolved (${result.stderr.trim() || `exit ${result.exitCode}`})`
    )
  }

  const [kind = "", realPathBase64] = result.stdout.trim().split("\n")
  if (kind === "missing") return { kind }
  if (kind === "link") return { kind }
  const realPath = realPathBase64 ? decodeBase64Text(realPathBase64) : null
  if ((kind !== "file" && kind !== "directory") || !realPath?.startsWith("/")) {
    throw new SandboxFileError(
      "failed",
      `path could not be resolved (${result.stdout.slice(0, 200)})`
    )
  }
  return { kind, realPath }
}

async function runScript(
  handle: AgentSandboxHandle,
  script: string,
  options: SandboxCommandOptions,
  env: Readonly<Record<string, string>>
): Promise<CommandResult> {
  const result = await handle.sandbox.runCommand("bash", loginShellArgs(script), {
    env: { ...(handle.env ?? {}), ...env },
    timeout: options.timeoutMs,
    signal: options.signal,
  })
  options.signal.throwIfAborted()
  return result
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\0")) return false
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

function decodeBase64Text(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf-8")
  } catch {
    return null
  }
}

// `find | while` rather than process substitution: some sandbox images (Vercel's stock one) have
// no /dev/fd, so `< <(…)` fails there.
const LIST_SANDBOX_FILES_SCRIPT = `# sixb-list-sandbox-files
set -eu
dir="\${SIXB_LIST_DIR:?}"
limit="\${SIXB_LIST_MAX_FILES:?}"
if [ ! -d "$dir" ]; then
  exit 0
fi
printf 'DIRECTORY\\n'
count=0
find "$dir" -type f -print0 | while IFS= read -r -d '' path; do
  count=$((count + 1))
  if [ "$count" -gt "$limit" ]; then
    printf 'LIMIT\\n'
    break
  fi
  rel="\${path#"$dir"/}"
  size="$(wc -c < "$path" | tr -d ' ')"
  rel64="$(printf '%s' "$rel" | base64 | tr -d '\\n')"
  printf '%s\\t%s\\n' "$size" "$rel64"
done`

// Prints what the path is, then where it really is as base64. `cd -P` follows every link along it.
const RESOLVE_SANDBOX_PATH_SCRIPT = `# sixb-resolve-sandbox-path
set -eu
path="$(printf '%s' "\${SIXB_RESOLVE_PATH_B64:?}" | base64 -d)"
if [ -L "$path" ]; then
  printf 'link\\n'
  exit 0
fi
if [ -d "$path" ]; then
  kind=directory
  real="$(cd -P -- "$path" && pwd -P)"
elif [ -f "$path" ]; then
  kind=file
  real="$(cd -P -- "$(dirname -- "$path")" && pwd -P)/$(basename -- "$path")"
else
  printf 'missing\\n'
  exit 0
fi
printf '%s\\n%s\\n' "$kind" "$(printf '%s' "$real" | base64 | tr -d '\\n')"`

// Prints the file's size on the first line and its bytes as base64 on the second, so the caller
// can tell a file that changed between the two reads.
// One line per path, in order: `ok<TAB>size<TAB>base64`, or the reason it was not read.
const READ_SANDBOX_FILES_SCRIPT = `# sixb-read-sandbox-files
set -uo pipefail
max_bytes="\${SIXB_READ_MAX_BYTES:?}"
real_roots=()
while IFS= read -r root; do
  real_root="$(cd -P -- "$root" 2>/dev/null && pwd)" && real_roots+=("$real_root")
done <<< "\${SIXB_READ_ROOTS:?}"
while IFS= read -r encoded; do
  requested="$(printf '%s' "$encoded" | base64 -d)"
  if [ ! -f "$requested" ] || [ -L "$requested" ]; then
    printf 'not_found\\n'
    continue
  fi
  parent="$(cd -P -- "$(dirname -- "$requested")" && pwd)"
  resolved="$parent/$(basename -- "$requested")"
  inside=0
  for real_root in "\${real_roots[@]}"; do
    case "$resolved" in "$real_root"/*) inside=1 ;; esac
  done
  if [ "$inside" != 1 ]; then
    printf 'outside_root\\n'
    continue
  fi
  size="$(wc -c < "$resolved" | tr -d ' ')"
  if [ "$size" -gt "$max_bytes" ]; then
    printf 'too_large\\n'
    continue
  fi
  printf 'ok\\t%s\\t' "$size"
  head -c "$max_bytes" "$resolved" | base64 | tr -d '\\n'
  printf '\\n'
done <<< "\${SIXB_READ_PATHS:?}"`

// Resolves the requested path to a regular file inside one of the roots, as `$resolved`, and its
// size as `$size`: exits 2 when it is missing, not a regular file, or a link, and 4 when it lies
// outside every root. The read, stat and upload scripts each start with it.
const CHECKED_FILE_PRELUDE = `set -euo pipefail
requested="$(printf '%s' "\${SIXB_READ_PATH_B64:?}" | base64 -d)"
roots="\${SIXB_READ_ROOTS:?}"
if [ ! -f "$requested" ] || [ -L "$requested" ]; then
  exit 2
fi
parent="$(cd -P -- "$(dirname -- "$requested")" && pwd)"
resolved="$parent/$(basename -- "$requested")"
inside=0
while IFS= read -r root; do
  real_root="$(cd -P -- "$root" 2>/dev/null && pwd)" || continue
  case "$resolved" in "$real_root"/*) inside=1 ;; esac
done <<< "$roots"
[ "$inside" = 1 ] || exit 4
size="$(wc -c < "$resolved" | tr -d ' ')"`

const READ_SANDBOX_FILE_SCRIPT = `# sixb-read-sandbox-file
${CHECKED_FILE_PRELUDE}
max_bytes="\${SIXB_READ_MAX_BYTES:?}"
if [ "$size" -gt "$max_bytes" ]; then
  exit 3
fi
printf '%s\\n' "$size"
head -c "$max_bytes" "$resolved" | base64 | tr -d '\\n'`

const STAT_SANDBOX_FILE_SCRIPT = `# sixb-stat-sandbox-file
${CHECKED_FILE_PRELUDE}
printf '%s\\n' "$size"`

// Fetches each \`<artifact> <version> <path> <to> <bytes>\` with the run's own \`sixb\`, which writes
// it whole or not at all, and refuses one that is not as large as its version says.
const DOWNLOAD_ARTIFACT_FILES_SCRIPT = `set -eu
while [ "$#" -gt 0 ]; do
  mkdir -p -- "$(dirname -- "$4")"
  "\${SIXB_BIN_DIR:?}/sixb" files download artifact "$1" "$2" --path "$3" --output "$4" >/dev/null
  [ "$(wc -c < "$4" | tr -d ' ')" = "$5" ] || { echo "$4 did not arrive whole" >&2; exit 1; }
  shift 5
done`

// The run's own \`sixb\`, not whichever one PATH finds first: a project's may shadow it. Its own
// exit codes would read as the prelude's, so a failure exits 5, its error on stderr.
const UPLOAD_SANDBOX_FILE_SCRIPT = `# sixb-upload-sandbox-file
${CHECKED_FILE_PRELUDE}
"\${SIXB_BIN_DIR:?}/sixb" files upload "$resolved" --media-type "\${SIXB_UPLOAD_MEDIA_TYPE:?}" || exit 5`
