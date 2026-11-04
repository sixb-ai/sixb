import type { CommandResult, Sandbox } from "@sixb/core"
import type { WorkspaceInstructionsFile } from "./agent-prompt"

/** Past this many UTF-8 bytes in all, the files are cut: the root's come first, so they are kept. */
export const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 32 * 1024

const READ_TIMEOUT_MS = 5_000

/**
 * Read the instruction files a workspace carries: in each folder from its repository's root down
 * to the working directory, `AGENTS.md`, else `CLAUDE.md`; outside a repository, the working
 * directory's alone. One command, so it costs one round trip on every provider, and on a computer
 * it reads the user's folder as the user.
 *
 * Never fails the run: a command that fails, times out or prints what cannot be parsed is warned
 * about and reads as no files.
 */
export async function readWorkspaceInstructions(
  sandbox: Sandbox,
  workingDirectory: string,
  signal?: AbortSignal
): Promise<readonly WorkspaceInstructionsFile[]> {
  let result: CommandResult
  try {
    result = await sandbox.runCommand("bash", ["-c", READ_INSTRUCTIONS_SCRIPT], {
      cwd: workingDirectory,
      timeout: READ_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    // A run that ends while it reads has nothing to warn about.
    if (!signal?.aborted) warn(error)
    return []
  }
  if (signal?.aborted) return []

  if (result.timedOut || result.exitCode !== 0) {
    warn(
      result.timedOut
        ? `timed out after ${READ_TIMEOUT_MS} ms`
        : result.stderr.trim() || `exited with code ${result.exitCode}`
    )
    return []
  }

  try {
    return boundedFiles(parseRecords(result.stdout))
  } catch (error) {
    warn(error)
    return []
  }
}

/** One file as the script printed it: its path from the working directory, and its first bytes. */
interface InstructionsRecord {
  readonly path: string
  readonly bytes: Uint8Array
}

/** The script prints the working directory's file first: the root's comes first in the prompt. */
function parseRecords(stdout: string): InstructionsRecord[] {
  const lines = stdout.split("\n").filter((line) => line !== "")

  const records = lines.map((line) => {
    const match = /^(\d+) (AGENTS\.md|CLAUDE\.md) ([A-Za-z0-9+/]*={0,2})$/.exec(line)
    if (!match || match[3] === undefined || match[3].length % 4 !== 0) {
      throw new Error("Invalid sandbox output.")
    }

    const up = Number(match[1])
    return {
      path: `${"../".repeat(up)}${match[2]}`,
      bytes: new Uint8Array(Buffer.from(match[3], "base64")),
    }
  })

  return records.reverse()
}

/**
 * The files within the byte budget, in order. A file that crosses it is cut at its last whole line
 * within what is left, and says where it goes on. A cut at a line leaves a few bytes: a later file
 * that fits in them still comes whole, and one that does not is cut the same way.
 */
function boundedFiles(records: readonly InstructionsRecord[]): WorkspaceInstructionsFile[] {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const files: WorkspaceInstructionsFile[] = []
  let remaining = WORKSPACE_INSTRUCTIONS_MAX_BYTES

  for (const { path, bytes } of records) {
    if (bytes.includes(0)) {
      warn(`'${path}' is binary, not UTF-8 text.`)
      continue
    }

    const cut = bytes.byteLength > remaining ? cutPoint(bytes, remaining) : bytes.byteLength
    const kept = bytes.subarray(0, cut)
    let text: string
    try {
      text = decoder.decode(kept)
    } catch {
      warn(`'${path}' is not UTF-8 text.`)
      continue
    }
    remaining -= cut

    if (cut < bytes.byteLength) {
      files.push({ path, text, continuesAtLine: kept.filter((byte) => byte === 10).length + 1 })
    } else if (text.trim()) {
      files.push({ path, text })
    }
  }

  return files
}

/** After the last newline within `limit` bytes, else at the last character boundary. */
function cutPoint(bytes: Uint8Array, limit: number): number {
  const newline = bytes.subarray(0, limit).lastIndexOf(10)
  if (newline !== -1) return newline + 1

  let cut = limit
  // A UTF-8 continuation byte is 10xxxxxx: never cut before one.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1
  return cut
}

function warn(reason: unknown): void {
  console.warn("[SixbAgent] Could not read the workspace's instruction files:", reason)
}

/**
 * Finds the repository's root (the nearest folder with `.git`, a directory or a worktree's file),
 * then prints one line per file from the working directory up to it: how many folders up, the
 * name, and at most one byte past the budget in base64, so a cut is seen.
 */
const READ_INSTRUCTIONS_SCRIPT = `# sixb-read-workspace-instructions
set -u -o pipefail
for tool in head base64 tr dirname; do command -v "$tool" >/dev/null || exit 20; done
here="$(pwd -P)" || exit 21
root="$here"
dir="$here"
while :; do
  if [ -e "$dir/.git" ]; then root="$dir"; break; fi
  [ "$dir" = / ] && break
  dir="$(dirname -- "$dir")"
done
up=0
dir="$here"
while :; do
  for name in AGENTS.md CLAUDE.md; do
    file="$dir/$name"
    if [ -f "$file" ] && [ -r "$file" ]; then
      printf '%s %s ' "$up" "$name"
      head -c ${WORKSPACE_INSTRUCTIONS_MAX_BYTES + 1} -- "$file" | base64 | tr -d '\\n' || exit 22
      printf '\\n'
      break
    fi
  done
  [ "$dir" = "$root" ] && break
  dir="$(dirname -- "$dir")"
  up=$((up + 1))
done`
