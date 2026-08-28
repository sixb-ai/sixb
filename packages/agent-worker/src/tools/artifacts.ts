import { createHash } from "node:crypto"
import { posix } from "node:path"
import type {
  AgentToolArtifact,
  AgentToolArtifactPutInput,
  AgentToolArtifacts,
  BlobBody,
  BlobStorage,
  FileRef,
} from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import type { AgentSandboxHandle } from "../sandbox-handle"

const DEFAULT_ARTIFACT_FILE_MAX_BYTES = 25 * 1024 * 1024
const DEFAULT_ARTIFACT_TOTAL_MAX_BYTES = 100 * 1024 * 1024
const MAX_FILE_NAME_BYTES = 255
const MAX_MEDIA_TYPE_LENGTH = 255
const MEDIA_TYPE_PATTERN = /^[!#$&^_.+A-Za-z0-9-]+\/[!#$&^_.+A-Za-z0-9-]+$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

interface CreateAgentToolArtifactsInput {
  readonly toolName: string
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly blobStorage: BlobStorage
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
  readonly onPublished?: (artifact: AgentToolArtifact) => void
  /** Shared across every tool call in one run so parallel publishers cannot oversubscribe it. */
  readonly budget?: AgentToolArtifactBudget
  /** Test seam; production uses the same 25 MB limit as generated output attachments. */
  readonly fileMaxBytes?: number
}

/** Atomic byte budget shared by all artifact publishers in one agent run. */
export class AgentToolArtifactBudget {
  #reservedBytes = 0

  constructor(readonly maxBytes = DEFAULT_ARTIFACT_TOTAL_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error(
        "[SixbAgentWorker] Agent tool artifact budget must be a safe non-negative integer."
      )
    }
  }

  get reservedBytes(): number {
    return this.#reservedBytes
  }

  reserve(bytes: number, toolName: string): AgentToolArtifactReservation {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(
        "[SixbAgentWorker] Agent tool artifact reservation must be a safe non-negative integer."
      )
    }
    this.add(bytes, toolName)
    return new AgentToolArtifactReservation(this, bytes, toolName)
  }

  add(bytes: number, toolName: string): void {
    if (this.#reservedBytes + bytes > this.maxBytes) {
      throw artifactError(toolName, `artifacts exceed the ${this.maxBytes}-byte run limit`)
    }
    this.#reservedBytes += bytes
  }

  release(bytes: number): void {
    this.#reservedBytes -= bytes
  }
}

class AgentToolArtifactReservation {
  #bytes: number
  #released = false

  constructor(
    private readonly budget: AgentToolArtifactBudget,
    bytes: number,
    private readonly toolName: string
  ) {
    this.#bytes = bytes
  }

  add(bytes: number): void {
    this.budget.add(bytes, this.toolName)
    this.#bytes += bytes
  }

  release(): void {
    if (this.#released) return
    this.#released = true
    this.budget.release(this.#bytes)
  }
}

/** Build the artifact publisher scoped to one tool call. */
export function createAgentToolArtifacts(input: CreateAgentToolArtifactsInput): AgentToolArtifacts {
  const fileMaxBytes = input.fileMaxBytes ?? DEFAULT_ARTIFACT_FILE_MAX_BYTES
  const budget = input.budget ?? new AgentToolArtifactBudget()

  return Object.freeze({
    async put(artifactInput: AgentToolArtifactPutInput) {
      input.signal.throwIfAborted()
      const fileName = validateFileName(artifactInput.fileName, input.toolName)
      const declaredMediaType = normalizeMediaType(
        artifactInput.mediaType ?? blobMediaType(artifactInput.body),
        input.toolName
      )
      const body = await readArtifactBody({
        body: artifactInput.body,
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
        const relativePath = artifactSandboxRelativePath(input.toolCallId, fileRef, fileName)
        await handle.sandbox.writeFiles([{ path: relativePath, contents: body.bytes }])
        input.signal.throwIfAborted()

        const artifact = {
          fileRef,
          sandboxPath: posix.join(handle.sandbox.workingDirectory, relativePath),
        }
        published = true
        input.onPublished?.(artifact)
        return artifact
      } finally {
        if (!published) body.reservation.release()
      }
    },
  })
}

async function readArtifactBody(input: {
  readonly body: BlobBody
  readonly budget: AgentToolArtifactBudget
  readonly fileMaxBytes: number
  readonly signal: AbortSignal
  readonly toolName: string
}): Promise<{
  readonly bytes: Uint8Array
  readonly reservation: AgentToolArtifactReservation
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
      throw artifactError(input.toolName, "artifact body must be binary data or a byte stream")
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
          await reader.cancel("agent tool artifact exceeded its file limit").catch(() => {})
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
  throw artifactError(
    toolName,
    `artifact is ${sizeBytes} bytes and exceeds the ${limit}-byte file limit`
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
    throw artifactError(toolName, "artifact fileName must be a single safe file name")
  }
  const sizeBytes = new TextEncoder().encode(value).byteLength
  if (sizeBytes > MAX_FILE_NAME_BYTES) {
    throw artifactError(toolName, `artifact fileName exceeds the ${MAX_FILE_NAME_BYTES}-byte limit`)
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
    throw artifactError(toolName, "artifact mediaType must be a valid type/subtype value")
  }
  return normalized === "image/jpg" ? "image/jpeg" : normalized
}

function validatedMediaType(
  bytes: Uint8Array,
  declared: string | undefined,
  toolName: string
): string {
  const detected = detectKnownMediaType(bytes)
  if (detected && declared && declared !== "application/octet-stream" && detected !== declared) {
    throw artifactError(
      toolName,
      `artifact bytes are ${detected}, not the declared media type ${declared}`
    )
  }
  if (declared && SIGNATURE_REQUIRED_MEDIA_TYPES.has(declared) && detected !== declared) {
    throw artifactError(toolName, `artifact bytes do not match the declared media type ${declared}`)
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

function detectKnownMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png"
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg"
  }
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) {
    return "image/gif"
  }
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return "image/webp"
  }
  if (asciiAt(bytes, 0, "%PDF-")) {
    return "application/pdf"
  }
  return undefined
}

/** Infer a stable media type for a sandbox file before publishing it as a tool artifact. */
export function inferAgentFileMediaType(bytes: Uint8Array, fileName: string): string {
  return (
    detectKnownMediaType(bytes) ??
    MEDIA_TYPES_BY_EXTENSION[posix.extname(fileName).toLowerCase()] ??
    "application/octet-stream"
  )
}

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function artifactSandboxRelativePath(
  toolCallId: string,
  fileRef: FileRef,
  fileName: string
): string {
  const callKey = createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)
  const digestKey = fileRef.digest.slice("sha256:".length, "sha256:".length + 12)
  return posix.join(".sixb", "agent", "artifacts", callKey, `${digestKey}-${fileName}`)
}

function artifactError(toolName: string, message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgentWorker] Agent tool '${toolName}' ${message}.`)
}
