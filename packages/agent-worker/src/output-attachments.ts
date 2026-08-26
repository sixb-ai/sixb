import { posix } from "node:path"
import type { BlobStorage, CommandResult, FileRef } from "@sixb/core"
import type { AgentRunDiagnostic } from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import type { BashSandboxHandle } from "./bash-tool"

const OUTPUT_COLLECTION_TIMEOUT_MS = 30_000
const OUTPUT_SCAN_MAX_FILES = 100
const OUTPUT_MAX_FILES = 20
const OUTPUT_FILE_MAX_BYTES = 25 * 1024 * 1024
const OUTPUT_TOTAL_MAX_BYTES = 100 * 1024 * 1024
const OUTPUT_MAX_DIAGNOSTICS = 20

export interface AgentOutputAttachment {
  readonly fileRef: FileRef
  readonly relativePath: string
  readonly sandboxPath: string
}

export interface AgentOutputAttachmentResult {
  readonly attachments: readonly AgentOutputAttachment[]
  readonly diagnostics: readonly AgentRunDiagnostic[]
}

interface ListedOutputFile {
  readonly relativePath: string
  readonly sizeBytes: number
}

interface CollectionWindow {
  readonly signal: AbortSignal
  readonly deadlineAt: number
}

export async function collectAgentOutputAttachments(input: {
  readonly sandboxReady?: Promise<BashSandboxHandle>
  readonly sandboxWasUsed?: () => boolean
  readonly blobStorage: BlobStorage
  readonly signal: AbortSignal
}): Promise<AgentOutputAttachmentResult> {
  if (!input.sandboxReady || input.sandboxWasUsed?.() !== true) {
    return emptyResult()
  }

  const window: CollectionWindow = {
    signal: input.signal,
    deadlineAt: Date.now() + OUTPUT_COLLECTION_TIMEOUT_MS,
  }
  window.signal.throwIfAborted()

  let handle: BashSandboxHandle
  try {
    handle = await waitForAbort(input.sandboxReady, window.signal)
  } catch (error) {
    window.signal.throwIfAborted()
    logCollectionError("Sandbox unavailable while collecting generated files", error)
    return diagnosticResult(
      diagnostic("output_collection_failed", "Generated files could not be collected.")
    )
  }

  const outputDir = handle.env?.SIXB_OUTPUT_DIR
  if (!outputDir) {
    return emptyResult()
  }

  const listed = await listOutputFiles(handle, window)
  const diagnostics: AgentRunDiagnostic[] = [...listed.diagnostics]
  const attachments: AgentOutputAttachment[] = []
  let totalBytes = 0
  let fileLimitNoted = false

  for (const file of listed.files) {
    window.signal.throwIfAborted()
    if (Date.now() >= window.deadlineAt) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "output_collection_failed",
          "Generated-file collection reached its time limit; some files were not attached."
        )
      )
      break
    }
    if (attachments.length >= OUTPUT_MAX_FILES) {
      if (!fileLimitNoted) {
        pushDiagnostic(
          diagnostics,
          diagnostic(
            "output_file_limit_exceeded",
            `Only the first ${OUTPUT_MAX_FILES} generated files were attached; the rest were skipped.`
          )
        )
        fileLimitNoted = true
      }
      continue
    }
    if (file.sizeBytes > OUTPUT_FILE_MAX_BYTES) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "output_file_too_large",
          "This generated file exceeds the per-file attachment limit and was skipped.",
          file.relativePath
        )
      )
      continue
    }
    if (totalBytes + file.sizeBytes > OUTPUT_TOTAL_MAX_BYTES) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "output_budget_exhausted",
          "This generated file exceeds the remaining attachment budget and was skipped.",
          file.relativePath
        )
      )
      continue
    }

    const bytes = await readOutputFile(handle, file, window)
    if (!bytes.ok) {
      pushDiagnostic(diagnostics, bytes.diagnostic)
      continue
    }

    window.signal.throwIfAborted()
    try {
      const fileRef = await input.blobStorage.put({
        body: bytes.bytes,
        signal: window.signal,
        fileName: outputFileName(file.relativePath),
        mediaType: inferMediaType(file.relativePath),
        // Provenance lives on the run/message relation. The blob's logical path is only the
        // consumer-meaningful path inside the published output tree.
        logicalPath: file.relativePath,
      })
      window.signal.throwIfAborted()
      attachments.push({
        fileRef,
        relativePath: file.relativePath,
        sandboxPath: posix.join(outputDir, file.relativePath),
      })
      totalBytes += bytes.bytes.byteLength
    } catch (error) {
      window.signal.throwIfAborted()
      logCollectionError(`Failed to store generated file '${file.relativePath}'`, error)
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "output_storage_failed",
          "This generated file could not be stored as an attachment.",
          file.relativePath
        )
      )
    }
  }

  return { attachments, diagnostics }
}

async function listOutputFiles(
  handle: BashSandboxHandle,
  window: CollectionWindow
): Promise<{
  readonly files: readonly ListedOutputFile[]
  readonly diagnostics: readonly AgentRunDiagnostic[]
}> {
  let result: CommandResult
  try {
    result = await handle.sandbox.runCommand("bash", ["-lc", LIST_OUTPUT_FILES_SCRIPT], {
      env: {
        ...(handle.env ?? {}),
        SIXB_OUTPUT_SCAN_MAX_FILES: String(OUTPUT_SCAN_MAX_FILES),
      },
      timeout: remainingMs(window),
      signal: window.signal,
    })
    window.signal.throwIfAborted()
  } catch (error) {
    window.signal.throwIfAborted()
    logCollectionError("Failed to list generated files", error)
    return {
      files: [],
      diagnostics: [diagnostic("output_collection_failed", "Generated files could not be listed.")],
    }
  }

  if (result.exitCode !== 0) {
    logCollectionError(
      "Failed to list generated files",
      result.stderr.trim() || `exit ${result.exitCode}`
    )
    return {
      files: [],
      diagnostics: [diagnostic("output_collection_failed", "Generated files could not be listed.")],
    }
  }

  const diagnostics: AgentRunDiagnostic[] = []
  const files: ListedOutputFile[] = []
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    if (line === "LIMIT") {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "output_file_limit_exceeded",
          `Only the first ${OUTPUT_SCAN_MAX_FILES} published files were inspected.`
        )
      )
      continue
    }
    const [sizeSource, relativePathBase64] = line.split("\t")
    const sizeBytes = Number(sizeSource)
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || !relativePathBase64) {
      pushDiagnostic(
        diagnostics,
        diagnostic("output_collection_failed", "A generated-file manifest entry was invalid.")
      )
      continue
    }
    const relativePath = decodeBase64Text(relativePathBase64)
    if (!relativePath || !isSafeRelativePath(relativePath)) {
      pushDiagnostic(
        diagnostics,
        diagnostic("output_collection_failed", "A generated-file path was invalid.")
      )
      continue
    }
    if (relativePath === ".keep") {
      continue
    }
    files.push({ relativePath, sizeBytes })
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { files, diagnostics }
}

async function readOutputFile(
  handle: BashSandboxHandle,
  file: ListedOutputFile,
  window: CollectionWindow
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly diagnostic: AgentRunDiagnostic }
> {
  const relativePathBase64 = Buffer.from(file.relativePath, "utf-8").toString("base64")
  let result: CommandResult
  try {
    result = await handle.sandbox.runCommand("bash", ["-lc", READ_OUTPUT_FILE_SCRIPT], {
      env: {
        ...(handle.env ?? {}),
        SIXB_OUTPUT_REL_B64: relativePathBase64,
        // Read at most one byte beyond the listed size. This detects a concurrent change without
        // allowing an unbounded file to be base64-buffered on the host.
        SIXB_OUTPUT_READ_MAX_BYTES: String(file.sizeBytes + 1),
      },
      timeout: remainingMs(window),
      signal: window.signal,
    })
    window.signal.throwIfAborted()
  } catch (error) {
    window.signal.throwIfAborted()
    logCollectionError(`Failed to read generated file '${file.relativePath}'`, error)
    return {
      ok: false,
      diagnostic: diagnostic(
        "output_collection_failed",
        "This generated file could not be read.",
        file.relativePath
      ),
    }
  }

  if (result.exitCode !== 0) {
    logCollectionError(
      `Failed to read generated file '${file.relativePath}'`,
      result.stderr.trim() || `exit ${result.exitCode}`
    )
    return {
      ok: false,
      diagnostic: diagnostic(
        "output_collection_failed",
        "This generated file could not be read.",
        file.relativePath
      ),
    }
  }

  const bytes = Buffer.from(result.stdout.trim(), "base64")
  if (bytes.byteLength !== file.sizeBytes) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "output_file_changed",
        "This generated file changed during collection and was skipped.",
        file.relativePath
      ),
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

function diagnostic(
  code: AgentRunDiagnostic["code"],
  message: string,
  path?: string
): AgentRunDiagnostic {
  return {
    code,
    severity: "warning",
    scope: "output",
    ...(path === undefined ? {} : { path }),
    message,
  }
}

function pushDiagnostic(diagnostics: AgentRunDiagnostic[], value: AgentRunDiagnostic): void {
  if (
    diagnostics.length < OUTPUT_MAX_DIAGNOSTICS &&
    !diagnostics.some(
      (current) =>
        current.code === value.code &&
        current.path === value.path &&
        current.message === value.message
    )
  ) {
    diagnostics.push(value)
  }
}

function remainingMs(window: CollectionWindow): number {
  return Math.max(1, window.deadlineAt - Date.now())
}

function emptyResult(): AgentOutputAttachmentResult {
  return { attachments: [], diagnostics: [] }
}

function diagnosticResult(value: AgentRunDiagnostic): AgentOutputAttachmentResult {
  return { attachments: [], diagnostics: [value] }
}

function logCollectionError(context: string, error: unknown): void {
  console.error(`[SixbAgentWorker] ${context}.`, error)
}

const LIST_OUTPUT_FILES_SCRIPT = `# sixb-list-agent-output-files
set -eu
dir="\${SIXB_OUTPUT_DIR:-}"
limit="\${SIXB_OUTPUT_SCAN_MAX_FILES:?}"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  exit 0
fi
count=0
find "$dir" -type f -print0 | while IFS= read -r -d '' path; do
  rel="\${path#"$dir"/}"
  if [ "$rel" = ".keep" ]; then
    continue
  fi
  count=$((count + 1))
  if [ "$count" -gt "$limit" ]; then
    printf 'LIMIT\\n'
    break
  fi
  size="$(wc -c < "$path" | tr -d ' ')"
  rel64="$(printf '%s' "$rel" | base64 | tr -d '\\n')"
  printf '%s\\t%s\\n' "$size" "$rel64"
done`

const READ_OUTPUT_FILE_SCRIPT = `# sixb-read-agent-output-file
set -euo pipefail
dir="\${SIXB_OUTPUT_DIR:?}"
rel="$(printf '%s' "\${SIXB_OUTPUT_REL_B64:?}" | base64 -d)"
max_bytes="\${SIXB_OUTPUT_READ_MAX_BYTES:?}"
file="$dir/$rel"
if [ ! -f "$file" ] || [ -L "$file" ]; then
  echo "output file not found or is a symbolic link" >&2
  exit 2
fi
head -c "$max_bytes" "$file" | base64 | tr -d '\\n'`
