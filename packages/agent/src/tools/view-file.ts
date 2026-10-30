import { posix } from "node:path"
import type { AgentToolFiles, FileRef, JsonValue } from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import { inferFileMediaType } from "@sixb/core/internal/blob-storage"
import type { JsonObject, ModelTool } from "@sixb/core/models"
import type { PreparedAgentAttachmentContext } from "../attachments"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxFileRegistry } from "../sandbox-file-registry"
import { readSandboxFile, resolveSandboxPath, SandboxFileError } from "../sandbox-files"
import type { AgentSandboxHandle } from "../sandbox-handle"
import type { AgentToolModelOutput } from "./result-output"
import { AGENT_FILE_MAX_BYTES } from "./tool-files"

const VIEW_FILE_TIMEOUT_MS = 30_000

export const VIEW_FILE_TOOL_SPEC = {
  name: "view_file",
  description:
    "Inspect a file in the current run sandbox. Use this for historical attachments and files created by bash. Paths must stay inside the sandbox working directory. Images are prepared for visual input when supported; other formats return bounded text or metadata.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: 1 } },
    required: ["path"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

interface ViewFileInput {
  readonly path: string
}

export function createViewFileTool(input: {
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
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
}): ModelTool<ViewFileInput> {
  return {
    ...VIEW_FILE_TOOL_SPEC,
    parseInput: parseViewFileInput,
    async execute({ path }, { signal, toolCallId }): Promise<JsonValue> {
      signal.throwIfAborted()
      const handle = await input.resolveSandbox()
      let absolutePath: string
      try {
        absolutePath = resolveSandboxPath(handle.sandbox.workingDirectory, path)
      } catch (error) {
        throw toViewFileError(error)
      }
      const knownFileRef =
        input.registry.get(absolutePath) ??
        preparedFileRefAtPath(input.attachments, handle.sandbox.workingDirectory, absolutePath)

      let fileRef: FileRef
      if (knownFileRef) {
        fileRef = knownFileRef
      } else {
        const bytes = await readSandboxFile(handle, {
          path: absolutePath,
          maxBytes: AGENT_FILE_MAX_BYTES,
          signal,
          timeoutMs: VIEW_FILE_TIMEOUT_MS,
        }).catch((error: unknown) => {
          throw toViewFileError(error)
        })
        const fileName = safePublishedFileName(posix.basename(absolutePath))
        const file = await input.filesForToolCall({ toolCallId, signal }).put({
          body: bytes,
          fileName,
          mediaType: inferFileMediaType(fileName, bytes),
        })
        fileRef = file.fileRef
      }

      // Prepared attachments and files tools stored are immutable snapshots and can be reused.
      // Arbitrary bash paths stay mutable, so do not cache their published snapshot at the source
      // path; a later view_file call must read the path again.
      if (knownFileRef) input.registry.register(absolutePath, fileRef)
      return richViewFileResult(fileRef)
    },
    toModelOutput(output, { toolCallId, signal }) {
      return input.toolResultToModelOutput({ output, toolCallId, signal })
    },
    errorText: agentToolErrorText,
  }
}

function parseViewFileInput(value: unknown): ViewFileInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw viewFileError("input must be an object")
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => key !== "path")) {
    throw viewFileError("input contains an unknown property")
  }
  if (typeof input.path !== "string") throw viewFileError("path must be a string")
  return { path: input.path }
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
function toViewFileError(error: unknown): unknown {
  return error instanceof SandboxFileError ? viewFileError(error.message) : error
}

function viewFileError(message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgentWorker] view_file ${message}.`)
}
