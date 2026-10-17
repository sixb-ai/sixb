import { posix } from "node:path"
import type { BlobStorage, FileRef } from "@sixb/core"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import type { AgentRunDiagnostic } from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import {
  listSandboxFiles,
  readSandboxFile,
  type SandboxFileEntry,
  SandboxFileError,
  type SandboxFileListing,
} from "./sandbox-files"
import type { AgentSandboxHandle } from "./sandbox-handle"

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

interface CollectionWindow {
  readonly signal: AbortSignal
  readonly deadlineAt: number
}

export async function collectAgentOutputAttachments(input: {
  readonly sandboxReady?: Promise<AgentSandboxHandle>
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

  let handle: AgentSandboxHandle
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

  const listed = await listOutputFiles(handle, outputDir, window)
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

    const bytes = await readOutputFile(handle, outputDir, file, window)
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
        mediaType: inferFileMediaType(outputFileName(file.relativePath), bytes.bytes),
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
  handle: AgentSandboxHandle,
  outputDir: string,
  window: CollectionWindow
): Promise<{
  readonly files: readonly SandboxFileEntry[]
  readonly diagnostics: readonly AgentRunDiagnostic[]
}> {
  let listing: SandboxFileListing
  try {
    listing = await listSandboxFiles(handle, {
      directory: outputDir,
      maxFiles: OUTPUT_SCAN_MAX_FILES,
      signal: window.signal,
      timeoutMs: remainingMs(window),
    })
  } catch (error) {
    window.signal.throwIfAborted()
    logCollectionError("Failed to list generated files", error)
    return {
      files: [],
      diagnostics: [diagnostic("output_collection_failed", "Generated files could not be listed.")],
    }
  }

  const diagnostics: AgentRunDiagnostic[] = []
  if (listing.truncated) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "output_file_limit_exceeded",
        `Only the first ${OUTPUT_SCAN_MAX_FILES} published files were inspected.`
      )
    )
  }
  if (listing.malformed > 0) {
    pushDiagnostic(
      diagnostics,
      diagnostic("output_collection_failed", "A generated-file manifest entry was invalid.")
    )
  }
  return {
    files: listing.files.filter((file) => file.relativePath !== ".keep"),
    diagnostics,
  }
}

async function readOutputFile(
  handle: AgentSandboxHandle,
  outputDir: string,
  file: SandboxFileEntry,
  window: CollectionWindow
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly diagnostic: AgentRunDiagnostic }
> {
  let bytes: Uint8Array
  try {
    bytes = await readSandboxFile(handle, {
      path: posix.join(outputDir, file.relativePath),
      maxBytes: OUTPUT_FILE_MAX_BYTES,
      signal: window.signal,
      timeoutMs: remainingMs(window),
    })
  } catch (error) {
    window.signal.throwIfAborted()
    if (
      error instanceof SandboxFileError &&
      (error.reason === "changed" || error.reason === "too_large")
    ) {
      return { ok: false, diagnostic: fileChangedDiagnostic(file) }
    }
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

  // The listing and the read are two commands; a file rewritten between them is skipped.
  if (bytes.byteLength !== file.sizeBytes) {
    return { ok: false, diagnostic: fileChangedDiagnostic(file) }
  }
  return { ok: true, bytes }
}

function fileChangedDiagnostic(file: SandboxFileEntry): AgentRunDiagnostic {
  return diagnostic(
    "output_file_changed",
    "This generated file changed during collection and was skipped.",
    file.relativePath
  )
}

function outputFileName(relativePath: string): string {
  return posix.basename(relativePath) || "agent-output.bin"
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
