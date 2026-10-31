import { posix } from "node:path"
import type { CommandResult } from "@sixb/core"
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
  const result = await runScript(handle, READ_SANDBOX_FILE_SCRIPT, input, {
    SIXB_READ_PATH_B64: Buffer.from(input.path, "utf-8").toString("base64"),
    SIXB_READ_ROOTS: sandboxRoots(handle).join("\n"),
    SIXB_READ_MAX_BYTES: String(input.maxBytes),
  })

  if (result.exitCode === 2) {
    throw new SandboxFileError(
      "not_found",
      "file does not exist, is not a regular file, or is a symbolic link"
    )
  }
  if (result.exitCode === 3) {
    throw new SandboxFileError("too_large", `file exceeds the ${input.maxBytes}-byte limit`)
  }
  if (result.exitCode === 4) {
    throw new SandboxFileError(
      "outside_root",
      "resolved path escapes the sandbox working directory and the run's context directory"
    )
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
  const result = await handle.sandbox.runCommand("bash", ["-lc", script], {
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
const READ_SANDBOX_FILE_SCRIPT = `# sixb-read-sandbox-file
set -euo pipefail
requested="$(printf '%s' "\${SIXB_READ_PATH_B64:?}" | base64 -d)"
roots="\${SIXB_READ_ROOTS:?}"
max_bytes="\${SIXB_READ_MAX_BYTES:?}"
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
size="$(wc -c < "$resolved" | tr -d ' ')"
if [ "$size" -gt "$max_bytes" ]; then
  exit 3
fi
printf '%s\\n' "$size"
head -c "$max_bytes" "$resolved" | base64 | tr -d '\\n'`
