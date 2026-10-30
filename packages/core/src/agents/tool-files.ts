import { createHash } from "node:crypto"
import { posix } from "node:path"
import { ARTIFACT_LIMITS } from "../artifacts/limits"
import { sniffFileMediaType } from "../blob-storage/media-type"
import type { BlobBody, FileRef } from "../blob-storage/types"
import { AgentToolPublicError } from "./errors"
import type { AgentRunFileStore } from "./run-session"
import type { AgentToolFilePutInput } from "./types"

// The files a tool stores for its run: checked and stored where the tool runs, then copied into the
// run's sandbox by its runner, at the path the tool was told. A tool that runs on the server and
// one in the runner's process store the same way.

/** Where a run's sandbox keeps its files, relative to its working directory. */
export const SANDBOX_CONTEXT_DIRECTORY = ".sixb/agent"
/** The most a file a tool stores, or one `view_file` reads, may hold: an artifact's file limit. */
export const AGENT_FILE_MAX_BYTES = ARTIFACT_LIMITS.maxFileBytes
const MAX_FILE_NAME_BYTES = 255
const MAX_MEDIA_TYPE_LENGTH = 255
const MEDIA_TYPE_PATTERN = /^[!#$&^_.+A-Za-z0-9-]+\/[!#$&^_.+A-Za-z0-9-]+$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

/** A file a tool stored, and where its runner copies it in the run's sandbox. */
export interface AgentToolCallFile {
  readonly fileRef: FileRef
  /** Relative to the sandbox's context directory, wherever the runner keeps it. */
  readonly path: string
}

/** A file a tool just stored, with its bytes, which its runner copies; the blob holds the same. */
export interface StoredAgentToolFile extends AgentToolCallFile {
  readonly bytes: Uint8Array
}

/**
 * Check one file a tool puts and store it: a single safe name, a media type its bytes match, at most
 * `fileMaxBytes`. Its `path` in the sandbox's context directory is where the runner copies it: one
 * directory per tool call, and the content's digest in its name.
 */
export async function storeAgentToolFile(input: {
  readonly toolName: string
  readonly toolCallId: string
  readonly file: AgentToolFilePutInput
  readonly store: Pick<AgentRunFileStore, "put">
  readonly signal: AbortSignal
  /** Called with each file's size as it is read, before it is stored; throws to refuse it. */
  readonly onBytes?: (sizeBytes: number) => void
  /** Test seam; production allows {@link AGENT_FILE_MAX_BYTES}. */
  readonly fileMaxBytes?: number
}): Promise<StoredAgentToolFile> {
  const { toolName, signal } = input
  signal.throwIfAborted()
  const fileName = validateFileName(input.file.fileName, toolName)
  const declaredMediaType = normalizeMediaType(
    input.file.mediaType ?? blobMediaType(input.file.body),
    toolName
  )
  const bytes = await readFileBody({
    body: input.file.body,
    fileMaxBytes: input.fileMaxBytes ?? AGENT_FILE_MAX_BYTES,
    signal,
    toolName,
    onBytes: input.onBytes ?? (() => {}),
  })
  const mediaType = validatedMediaType(bytes, declaredMediaType, toolName)
  signal.throwIfAborted()
  const fileRef = await input.store.put({
    body: bytes,
    expectedSizeBytes: bytes.byteLength,
    signal,
    fileName,
    mediaType,
  })
  signal.throwIfAborted()
  return { fileRef, path: toolFilePath(input.toolCallId, fileRef, fileName), bytes }
}

async function readFileBody(input: {
  readonly body: BlobBody
  readonly fileMaxBytes: number
  readonly signal: AbortSignal
  readonly toolName: string
  readonly onBytes: (sizeBytes: number) => void
}): Promise<Uint8Array> {
  const { body, signal } = input
  const knownSize = knownBodySize(body)
  if (knownSize !== undefined) {
    assertWithinFileLimit(knownSize, input.fileMaxBytes, input.toolName)
    input.onBytes(knownSize)
  }
  signal.throwIfAborted()

  if (body instanceof Uint8Array) return new Uint8Array(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))
  if (body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer())
    signal.throwIfAborted()
    return bytes
  }
  if (!(body instanceof ReadableStream)) {
    throw toolFileError(input.toolName, "file body must be binary data or a byte stream")
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const cancelOnAbort = () => {
    void reader.cancel(signal.reason)
  }
  signal.addEventListener("abort", cancelOnAbort, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      const chunk = new Uint8Array(value)
      totalBytes += chunk.byteLength
      if (totalBytes > input.fileMaxBytes) {
        await reader.cancel("agent tool file exceeded its file limit").catch(() => {})
        assertWithinFileLimit(totalBytes, input.fileMaxBytes, input.toolName)
      }
      input.onBytes(chunk.byteLength)
      chunks.push(chunk)
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function knownBodySize(body: BlobBody): number | undefined {
  if (body instanceof Uint8Array) return body.byteLength
  if (body instanceof ArrayBuffer) return body.byteLength
  if (body instanceof Blob) return body.size
  return undefined
}

function assertWithinFileLimit(sizeBytes: number, limit: number, toolName: string): void {
  if (sizeBytes <= limit) return
  throw toolFileError(
    toolName,
    `file is ${sizeBytes} bytes and exceeds the ${limit}-byte file limit`
  )
}

function validateFileName(value: string, toolName: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw toolFileError(toolName, "fileName must be a single safe file name")
  }
  const sizeBytes = new TextEncoder().encode(value).byteLength
  if (sizeBytes > MAX_FILE_NAME_BYTES) {
    throw toolFileError(toolName, `fileName exceeds the ${MAX_FILE_NAME_BYTES}-byte limit`)
  }
  return value
}

function blobMediaType(body: BlobBody): string | undefined {
  return body instanceof Blob ? body.type : undefined
}

function normalizeMediaType(value: string | undefined, toolName: string): string | undefined {
  if (value === undefined || value === "") return undefined
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_MEDIA_TYPE_LENGTH ||
    !MEDIA_TYPE_PATTERN.test(normalized)
  ) {
    throw toolFileError(toolName, "mediaType must be a valid type/subtype value")
  }
  return normalized === "image/jpg" ? "image/jpeg" : normalized
}

function validatedMediaType(
  bytes: Uint8Array,
  declared: string | undefined,
  toolName: string
): string {
  const detected = sniffFileMediaType(bytes)
  if (detected && declared && declared !== "application/octet-stream" && detected !== declared) {
    throw toolFileError(
      toolName,
      `file bytes are ${detected}, not the declared media type ${declared}`
    )
  }
  if (declared && SIGNATURE_REQUIRED_MEDIA_TYPES.has(declared) && detected !== declared) {
    throw toolFileError(toolName, `file bytes do not match the declared media type ${declared}`)
  }
  return detected ?? declared ?? "application/octet-stream"
}

const SIGNATURE_REQUIRED_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

/** Where a tool's file goes in the context directory, as the agent names it. */
function toolFilePath(toolCallId: string, fileRef: FileRef, fileName: string): string {
  const callKey = createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)
  const digestKey = fileRef.digest.slice("sha256:".length, "sha256:".length + 12)
  return posix.join("tool-files", callKey, `${digestKey}-${fileName}`)
}

function toolFileError(toolName: string, message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] Agent tool '${toolName}' ${message}.`)
}
