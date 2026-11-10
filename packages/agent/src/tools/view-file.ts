import { posix } from "node:path"
import type { AgentToolFiles, FileRef, JsonValue } from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import type { PreparedAgentAttachmentContext } from "../attachments"
import type { AgentSandboxFileRegistry } from "../sandbox-file-registry"
import { readSandboxFile, resolveSandboxPath, SandboxFileError } from "../sandbox-files"
import type { AgentSandboxHandle } from "../sandbox-handle"
import type { AgentToolModelOutput } from "./result-output"
import { AGENT_FILE_MAX_BYTES } from "./tool-files"

const VIEW_FILE_TIMEOUT_MS = 30_000

/**
 * What `read` took over: earlier threads hold calls to `view_file`, and their results replay as
 * they were stored, images included.
 */
export const LEGACY_VIEW_FILE_TOOL = "view_file"

/** What `read` needs to show a file as itself, an image or a PDF, rather than as text. */
export interface SandboxFileViewer {
  readonly attachments: PreparedAgentAttachmentContext
  readonly registry: AgentSandboxFileRegistry
  readonly filesForToolCall: (options: {
    readonly toolCallId: string
    readonly signal: AbortSignal
  }) => AgentToolFiles
  readonly toolResultToModelOutput: (input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
    readonly toolCallId: string
  }) => AgentToolModelOutput | Promise<AgentToolModelOutput>
}

/**
 * A sandbox file as a rich result: the file itself, stored with the call, which the run's media
 * bridge shows the model as an image or a document when it can, and as metadata otherwise. An
 * attachment, or a file a tool stored, is the snapshot it already is.
 */
export async function viewSandboxFile(
  viewer: SandboxFileViewer,
  handle: AgentSandboxHandle,
  input: { readonly path: string; readonly toolCallId: string; readonly signal: AbortSignal }
): Promise<JsonValue> {
  input.signal.throwIfAborted()
  let absolutePath: string
  try {
    absolutePath = resolveSandboxPath(handle, input.path)
  } catch (error) {
    throw toViewError(error)
  }
  const knownFileRef =
    viewer.registry.get(absolutePath) ??
    preparedFileRefAtPath(viewer.attachments, handle.sandbox.workingDirectory, absolutePath)

  let fileRef: FileRef
  if (knownFileRef) {
    fileRef = knownFileRef
  } else {
    const bytes = await readSandboxFile(handle, {
      path: absolutePath,
      maxBytes: AGENT_FILE_MAX_BYTES,
      signal: input.signal,
      timeoutMs: VIEW_FILE_TIMEOUT_MS,
    }).catch((error: unknown) => {
      throw toViewError(error)
    })
    const fileName = safePublishedFileName(posix.basename(absolutePath))
    const file = await viewer
      .filesForToolCall({ toolCallId: input.toolCallId, signal: input.signal })
      .put({ body: bytes, fileName, mediaType: inferFileMediaType(fileName, bytes) })
    fileRef = file.fileRef
  }

  // Prepared attachments and files tools stored are immutable snapshots and can be reused.
  // Arbitrary bash paths stay mutable, so do not cache their published snapshot at the source
  // path; a later read must read the path again.
  if (knownFileRef) viewer.registry.register(absolutePath, fileRef)
  return richViewFileResult(fileRef)
}

/** Whether `path` names an attachment or a file a tool stored, which `read` shows as itself. */
export function isKnownSandboxFile(
  viewer: SandboxFileViewer,
  handle: AgentSandboxHandle,
  path: string
): boolean {
  let absolutePath: string
  try {
    absolutePath = resolveSandboxPath(handle, path)
  } catch {
    return false
  }
  const fileRef =
    viewer.registry.get(absolutePath) ??
    preparedFileRefAtPath(viewer.attachments, handle.sandbox.workingDirectory, absolutePath)
  return fileRef !== undefined && !isTextMediaType(fileRef.mediaType)
}

function isTextMediaType(mediaType: string | undefined): boolean {
  return (
    mediaType !== undefined &&
    (mediaType.startsWith("text/") ||
      /^application\/(json|xml|yaml|x-yaml|javascript|typescript|csv|x-sh)\b/.test(mediaType))
  )
}

function preparedFileRefAtPath(
  attachments: PreparedAgentAttachmentContext,
  workingDirectory: string,
  absolutePath: string
): FileRef | undefined {
  for (const file of attachments.sandboxFiles) {
    if (posix.resolve(workingDirectory, file.path) === absolutePath) {
      return file.fileRef
    }
  }
  return undefined
}

function richViewFileResult(fileRef: FileRef): JsonValue {
  const mediaType = fileRef.mediaType ?? "application/octet-stream"
  const fileName = fileRef.fileName ?? "file"
  const description = mediaType.startsWith("image/")
    ? `Prepared image '${fileName}' for inspection.`
    : `Prepared file '${fileName}' (${mediaType}) for inspection.`
  return {
    kind: "agentToolResult",
    content: [
      {
        type: "text",
        text: `${description} Size: ${fileRef.sizeBytes} bytes.`,
      },
      { type: "file", fileRef: { ...fileRef } },
    ],
  }
}

function safePublishedFileName(value: string): string {
  const safe = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/]/g, "_")
    .slice(0, 120)
  return safe && safe !== "." && safe !== ".." ? safe : "viewed-file.bin"
}

/** A sandbox file refusal becomes the message the Agent sees; anything else passes through. */
function toViewError(error: unknown): unknown {
  return error instanceof SandboxFileError
    ? new AgentToolPublicError(`[SixbAgent] read ${error.message}.`)
    : error
}
