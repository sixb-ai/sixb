import { createHash } from "node:crypto"
import { posix } from "node:path"
import type {
  AgentToolFile,
  AgentToolFilePutInput,
  AgentToolFiles,
  BlobBody,
  FileRef,
} from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import { ARTIFACT_LIMITS } from "@sixb/core/artifacts"
import type { AgentRunFileStore } from "@sixb/core/internal/agents"
import { sniffFileMediaType } from "@sixb/core/internal/blob-storage"
import type { AgentSandboxHandle } from "../sandbox-handle"

/** The most a file a tool stores, or one `view_file` reads, may hold: an artifact's file limit. */
export const AGENT_FILE_MAX_BYTES = ARTIFACT_LIMITS.maxFileBytes
const DEFAULT_RUN_MAX_BYTES = 100 * 1024 * 1024
const MAX_FILE_NAME_BYTES = 255
const MAX_MEDIA_TYPE_LENGTH = 255
const MEDIA_TYPE_PATTERN = /^[!#$&^_.+A-Za-z0-9-]+\/[!#$&^_.+A-Za-z0-9-]+$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

interface CreateAgentToolFilesInput {
  readonly toolName: string
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly blobStorage: AgentRunFileStore
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
  readonly onPublished?: (file: AgentToolFile) => void
  /** Shared across every tool call in one run so parallel publishers cannot oversubscribe it. */
  readonly budget?: AgentFileBudget
  /** Test seam; production allows {@link AGENT_FILE_MAX_BYTES}. */
  readonly fileMaxBytes?: number
}

/** Atomic byte budget shared by every file publisher in one agent run. */
export class AgentFileBudget {
  #reservedBytes = 0
  /**
   * Content held by reservations, by digest. Blob storage keeps identical bytes once, so content a
   * run stores again, such as the unchanged files of an artifact's next version, counts once.
   */
  readonly #contents = new Map<string, { readonly sizeBytes: number; holders: number }>()

  constructor(readonly maxBytes = DEFAULT_RUN_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error("[SixbAgent] Agent file budget must be a safe non-negative integer.")
    }
  }

  get reservedBytes(): number {
    return this.#reservedBytes
  }

  reserve(bytes: number, toolName: string): AgentFileReservation {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("[SixbAgent] Agent file reservation must be a safe non-negative integer.")
    }
    this.add(bytes, toolName)
    return new AgentFileReservation(this, bytes, toolName)
  }

  add(bytes: number, toolName: string): void {
    if (this.#reservedBytes + bytes > this.maxBytes) {
      throw toolFileError(toolName, `files exceed the ${this.maxBytes}-byte run limit`)
    }
    this.#reservedBytes += bytes
  }

  release(bytes: number): void {
    this.#reservedBytes -= bytes
  }

  /** Counts content's bytes when no reservation holds the same digest yet, and nothing after. */
  holdContent(digest: string, sizeBytes: number, toolName: string): void {
    const held = this.#contents.get(digest)
    if (held) {
      held.holders += 1
      return
    }
    this.add(sizeBytes, toolName)
    this.#contents.set(digest, { sizeBytes, holders: 1 })
  }

  releaseContent(digest: string): void {
    const held = this.#contents.get(digest)
    if (!held) return
    held.holders -= 1
    if (held.holders > 0) return
    this.#contents.delete(digest)
    this.release(held.sizeBytes)
  }
}

class AgentFileReservation {
  #bytes: number
  readonly #contents: string[] = []
  #released = false

  constructor(
    private readonly budget: AgentFileBudget,
    bytes: number,
    private readonly toolName: string
  ) {
    this.#bytes = bytes
  }

  add(bytes: number): void {
    this.budget.add(bytes, this.toolName)
    this.#bytes += bytes
  }

  /** Reserves bytes whose SHA-256 is `digest`, unless the run already counts the same content. */
  addContent(digest: string, sizeBytes: number): void {
    this.budget.holdContent(digest, sizeBytes, this.toolName)
    this.#contents.push(digest)
  }

  release(): void {
    if (this.#released) return
    this.#released = true
    this.budget.release(this.#bytes)
    for (const digest of this.#contents) this.budget.releaseContent(digest)
  }
}

/** Build the file publisher scoped to one tool call. */
export function createAgentToolFiles(input: CreateAgentToolFilesInput): AgentToolFiles {
  const fileMaxBytes = input.fileMaxBytes ?? AGENT_FILE_MAX_BYTES
  const budget = input.budget ?? new AgentFileBudget()

  return Object.freeze({
    async put(fileInput: AgentToolFilePutInput) {
      input.signal.throwIfAborted()
      const fileName = validateFileName(fileInput.fileName, input.toolName)
      const declaredMediaType = normalizeMediaType(
        fileInput.mediaType ?? blobMediaType(fileInput.body),
        input.toolName
      )
      const body = await readFileBody({
        body: fileInput.body,
        budget,
        fileMaxBytes,
        signal: input.signal,
        toolName: input.toolName,
      })
      let published = false
      try {
        const mediaType = validatedMediaType(body.bytes, declaredMediaType, input.toolName)

        input.signal.throwIfAborted()
        const fileRef = await input.blobStorage.put({
          body: body.bytes,
          expectedSizeBytes: body.bytes.byteLength,
          signal: input.signal,
          fileName,
          mediaType,
        })
        input.signal.throwIfAborted()

        const handle = await input.resolveSandbox()
        input.signal.throwIfAborted()
        const path = toolFileSandboxPath(handle, input.toolCallId, fileRef, fileName)
        await handle.sandbox.writeFiles([{ path, contents: body.bytes }])
        input.signal.throwIfAborted()

        const file = {
          fileRef,
          sandboxPath: posix.resolve(handle.sandbox.workingDirectory, path),
        }
        published = true
        input.onPublished?.(file)
        return file
      } finally {
        if (!published) body.reservation.release()
      }
    },
  })
}

async function readFileBody(input: {
  readonly body: BlobBody
  readonly budget: AgentFileBudget
  readonly fileMaxBytes: number
  readonly signal: AbortSignal
  readonly toolName: string
}): Promise<{
  readonly bytes: Uint8Array
  readonly reservation: AgentFileReservation
}> {
  const { body, signal } = input
  const knownSize = knownBodySize(body)
  if (knownSize !== undefined) {
    assertWithinFileLimit(knownSize, input.fileMaxBytes, input.toolName)
  }
  signal.throwIfAborted()

  const reservation = input.budget.reserve(knownSize ?? 0, input.toolName)

  try {
    if (body instanceof Uint8Array) {
      return { bytes: new Uint8Array(body), reservation }
    }
    if (body instanceof ArrayBuffer) {
      return { bytes: new Uint8Array(body.slice(0)), reservation }
    }
    if (body instanceof Blob) {
      const bytes = new Uint8Array(await body.arrayBuffer())
      signal.throwIfAborted()
      return { bytes, reservation }
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
        reservation.add(chunk.byteLength)
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
    return { bytes, reservation }
  } catch (error) {
    reservation.release()
    throw error
  }
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
function toolFileSandboxPath(
  handle: AgentSandboxHandle,
  toolCallId: string,
  fileRef: FileRef,
  fileName: string
): string {
  const callKey = createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)
  const digestKey = fileRef.digest.slice("sha256:".length, "sha256:".length + 12)
  return posix.join(handle.contextDirectory, "tool-files", callKey, `${digestKey}-${fileName}`)
}

function toolFileError(toolName: string, message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] Agent tool '${toolName}' ${message}.`)
}
