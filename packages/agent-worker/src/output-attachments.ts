import { posix } from "node:path"
import type { BlobStorage, CommandResult, FileRef } from "@sixb/core"
import type { BashSandboxHandle } from "./bash-tool"

const OUTPUT_COLLECTION_TIMEOUT_MS = 30_000
const OUTPUT_MAX_FILES = 20
const OUTPUT_FILE_MAX_BYTES = 25 * 1024 * 1024
const OUTPUT_TOTAL_MAX_BYTES = 100 * 1024 * 1024

export interface AgentOutputAttachment {
  readonly fileRef: FileRef
  readonly relativePath: string
  readonly sandboxPath: string
}

export interface AgentOutputAttachmentResult {
  readonly attachments: readonly AgentOutputAttachment[]
  readonly notes: readonly string[]
}

interface ListedOutputFile {
  readonly relativePath: string
  readonly sizeBytes: number
}

export async function collectAgentOutputAttachments(input: {
  readonly sandboxReady?: Promise<BashSandboxHandle>
  readonly sandboxWasUsed?: () => boolean
  readonly blobStorage: BlobStorage
  readonly runId: string
}): Promise<AgentOutputAttachmentResult> {
  if (!input.sandboxReady || input.sandboxWasUsed?.() !== true) {
    return emptyResult()
  }

  let handle: BashSandboxHandle
  try {
    handle = await input.sandboxReady
  } catch (error) {
    return noteResult(
      `Generated files could not be collected because the sandbox was unavailable: ${errorMessage(error)}.`
    )
  }

  const outputDir = handle.env?.SIXB_OUTPUT_DIR
  if (!outputDir) {
    return emptyResult()
  }

  const listed = await listOutputFiles(handle)
  const notes: string[] = [...listed.notes]
  const attachments: AgentOutputAttachment[] = []
  let totalBytes = 0
  let acceptedCount = 0
  let fileLimitNoted = false

  for (const file of listed.files) {
    if (acceptedCount >= OUTPUT_MAX_FILES) {
      if (!fileLimitNoted) {
        notes.push(
          `Only the first ${OUTPUT_MAX_FILES} generated file(s) were attached; the rest were skipped.`
        )
        fileLimitNoted = true
      }
      continue
    }
    if (file.sizeBytes > OUTPUT_FILE_MAX_BYTES) {
      notes.push(
        `Generated file '${file.relativePath}' was not attached because it exceeds the per-file size limit.`
      )
      continue
    }
    if (totalBytes + file.sizeBytes > OUTPUT_TOTAL_MAX_BYTES) {
      notes.push(
        `Generated file '${file.relativePath}' was not attached because the generated-file budget was exhausted.`
      )
      continue
    }

    const bytes = await readOutputFile(handle, file)
    if (!bytes.ok) {
      notes.push(bytes.note)
      continue
    }

    try {
      const fileRef = await input.blobStorage.put({
        body: bytes.bytes,
        fileName: outputFileName(file.relativePath),
        mediaType: inferMediaType(file.relativePath),
        logicalPath: posix.join("agent-outputs", input.runId, file.relativePath),
      })
      attachments.push({
        fileRef,
        relativePath: file.relativePath,
        sandboxPath: posix.join(outputDir, file.relativePath),
      })
      totalBytes += file.sizeBytes
      acceptedCount += 1
    } catch (error) {
      notes.push(
        `Generated file '${file.relativePath}' could not be stored as an attachment: ${errorMessage(error)}.`
      )
    }
  }

  return { attachments, notes }
}

async function listOutputFiles(
  handle: BashSandboxHandle
): Promise<{ readonly files: readonly ListedOutputFile[]; readonly notes: readonly string[] }> {
  let result: CommandResult
  try {
    result = await handle.sandbox.runCommand("bash", ["-lc", LIST_OUTPUT_FILES_SCRIPT], {
      env: handle.env,
      timeout: OUTPUT_COLLECTION_TIMEOUT_MS,
    })
  } catch (error) {
    return {
      files: [],
      notes: [`Generated files could not be listed: ${errorMessage(error)}.`],
    }
  }

  if (result.exitCode !== 0) {
    return {
      files: [],
      notes: [
        `Generated files could not be listed: ${result.stderr.trim() || `exit ${result.exitCode}`}.`,
      ],
    }
  }

  const notes: string[] = []
  const files: ListedOutputFile[] = []
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    const [sizeSource, relativePathBase64] = line.split("\t")
    const sizeBytes = Number(sizeSource)
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || !relativePathBase64) {
      notes.push("A generated file entry was ignored because its manifest row was malformed.")
      continue
    }
    const relativePath = decodeBase64Text(relativePathBase64)
    if (!relativePath || !isSafeRelativePath(relativePath)) {
      notes.push("A generated file entry was ignored because its path was not safe.")
      continue
    }
    if (relativePath === ".keep") {
      continue
    }
    files.push({ relativePath, sizeBytes })
  }

  return { files, notes }
}

async function readOutputFile(
  handle: BashSandboxHandle,
  file: ListedOutputFile
): Promise<
  { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly note: string }
> {
  const relativePathBase64 = Buffer.from(file.relativePath, "utf-8").toString("base64")
  let result: CommandResult
  try {
    result = await handle.sandbox.runCommand("bash", ["-lc", READ_OUTPUT_FILE_SCRIPT], {
      env: {
        ...(handle.env ?? {}),
        SIXB_OUTPUT_REL_B64: relativePathBase64,
      },
      timeout: OUTPUT_COLLECTION_TIMEOUT_MS,
    })
  } catch (error) {
    return {
      ok: false,
      note: `Generated file '${file.relativePath}' could not be read: ${errorMessage(error)}.`,
    }
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      note: `Generated file '${file.relativePath}' could not be read: ${result.stderr.trim() || `exit ${result.exitCode}`}.`,
    }
  }

  const bytes = Buffer.from(result.stdout.trim(), "base64")
  if (bytes.byteLength !== file.sizeBytes) {
    return {
      ok: false,
      note: `Generated file '${file.relativePath}' changed while it was being collected and was not attached.`,
    }
  }

  return { ok: true, bytes: new Uint8Array(bytes) }
}

function outputFileName(relativePath: string): string {
  return posix.basename(relativePath) || "agent-output.bin"
}

function inferMediaType(relativePath: string): string {
  const lower = relativePath.toLowerCase()
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : ""
  return MEDIA_TYPES_BY_EXTENSION[ext] ?? "application/octet-stream"
}

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\0")) return false
  const segments = value.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

function decodeBase64Text(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf-8")
  } catch {
    return null
  }
}

function emptyResult(): AgentOutputAttachmentResult {
  return { attachments: [], notes: [] }
}

function noteResult(note: string): AgentOutputAttachmentResult {
  return { attachments: [], notes: [note] }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

const LIST_OUTPUT_FILES_SCRIPT = `# sixb-list-agent-output-files
set -euo pipefail
dir="\${SIXB_OUTPUT_DIR:-}"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  exit 0
fi
find "$dir" -type f -print0 | sort -z | while IFS= read -r -d '' path; do
  rel="\${path#"$dir"/}"
  if [ "$rel" = ".keep" ]; then
    continue
  fi
  size="$(wc -c < "$path" | tr -d ' ')"
  rel64="$(printf '%s' "$rel" | base64 | tr -d '\\n')"
  printf '%s\\t%s\\n' "$size" "$rel64"
done`

const READ_OUTPUT_FILE_SCRIPT = `# sixb-read-agent-output-file
set -euo pipefail
dir="\${SIXB_OUTPUT_DIR:?}"
rel="$(printf '%s' "\${SIXB_OUTPUT_REL_B64:?}" | base64 -d)"
file="$dir/$rel"
if [ ! -f "$file" ]; then
  echo "output file not found" >&2
  exit 2
fi
base64 < "$file" | tr -d '\\n'`
