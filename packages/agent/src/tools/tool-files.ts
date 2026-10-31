import { posix } from "node:path"
import type { AgentToolFile, AgentToolFilePutInput, AgentToolFiles } from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import {
  AGENT_FILE_MAX_BYTES,
  type AgentRunFileStore,
  type AgentToolCallFile,
  storeAgentToolFile,
} from "@sixb/core/internal/agents"
import type { AgentSandboxHandle } from "../sandbox-handle"

export { AGENT_FILE_MAX_BYTES }
const DEFAULT_RUN_MAX_BYTES = 100 * 1024 * 1024

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

/**
 * The file publisher of one of the harness's own tool calls: each file is stored as a project
 * tool's is, counted against the run's budget, and copied into the sandbox at its path.
 */
export function createAgentToolFiles(input: CreateAgentToolFilesInput): AgentToolFiles {
  const budget = input.budget ?? new AgentFileBudget()

  return Object.freeze({
    async put(fileInput: AgentToolFilePutInput) {
      const reservation = budget.reserve(0, input.toolName)
      let published = false
      try {
        const stored = await storeAgentToolFile({
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          file: fileInput,
          store: input.blobStorage,
          signal: input.signal,
          onBytes: (sizeBytes) => reservation.add(sizeBytes),
          ...(input.fileMaxBytes === undefined ? {} : { fileMaxBytes: input.fileMaxBytes }),
        })
        const file = await copyToSandbox(input, stored, stored.bytes)
        published = true
        return file
      } finally {
        if (!published) reservation.release()
      }
    },
  })
}

/**
 * Copy the files a project tool stored into the sandbox, at the paths it was told, each counted
 * against the run's budget as the harness's own tools' files are. The call stored no more than the
 * budget had left when it started.
 */
export async function installAgentToolFiles(input: {
  readonly toolName: string
  readonly files: readonly AgentToolCallFile[]
  readonly blobStorage: AgentRunFileStore
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
  readonly budget: AgentFileBudget
  readonly signal: AbortSignal
  readonly onPublished?: (file: AgentToolFile) => void
}): Promise<void> {
  for (const file of input.files) {
    input.signal.throwIfAborted()
    const reservation = input.budget.reserve(0, input.toolName)
    try {
      reservation.add(file.fileRef.sizeBytes)
      const bytes = new Uint8Array(
        await new Response(await input.blobStorage.open(file.fileRef.blobId)).arrayBuffer()
      )
      await copyToSandbox(input, file, bytes)
    } catch (error) {
      reservation.release()
      throw error
    }
  }
}

async function copyToSandbox(
  input: {
    readonly resolveSandbox: () => Promise<AgentSandboxHandle>
    readonly signal: AbortSignal
    readonly onPublished?: (file: AgentToolFile) => void
  },
  stored: AgentToolCallFile,
  bytes: Uint8Array
): Promise<AgentToolFile> {
  const handle = await input.resolveSandbox()
  input.signal.throwIfAborted()
  const path = posix.join(handle.contextDirectory, stored.path)
  await handle.sandbox.writeFiles([{ path, contents: bytes }])
  input.signal.throwIfAborted()
  const file = {
    fileRef: stored.fileRef,
    sandboxPath: posix.resolve(handle.sandbox.workingDirectory, path),
  }
  input.onPublished?.(file)
  return file
}

function toolFileError(toolName: string, message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] Agent tool '${toolName}' ${message}.`)
}
