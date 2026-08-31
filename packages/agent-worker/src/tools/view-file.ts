import { posix } from "node:path"
import type { AgentToolArtifacts, FileRef, JsonValue } from "@sixb/core"
import { AgentToolPublicError } from "@sixb/core"
import { type JSONSchema7, jsonSchema, type Tool, tool } from "ai"
import { NEVER_ABORTED_SIGNAL } from "../abort"
import type { PreparedAgentAttachmentContext } from "../attachments"
import type { AgentSandboxFileRegistry } from "../sandbox-file-registry"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { inferAgentFileMediaType } from "./artifacts"
import type { AgentToolModelOutput } from "./result-output"

const VIEW_FILE_MAX_BYTES = 25 * 1024 * 1024
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
  } satisfies JSONSchema7,
} as const

interface ViewFileInput {
  readonly path: string
}

export function createViewFileTool(input: {
  readonly resolveSandbox: () => Promise<AgentSandboxHandle>
  readonly attachments: PreparedAgentAttachmentContext
  readonly registry: AgentSandboxFileRegistry
  readonly artifactsForToolCall: (options: {
    readonly toolCallId: string
    readonly signal: AbortSignal
  }) => AgentToolArtifacts
  readonly toolResultToModelOutput: (input: {
    readonly output: JsonValue
    readonly signal: AbortSignal
    readonly toolCallId: string
  }) => AgentToolModelOutput | PromiseLike<AgentToolModelOutput>
}): Tool<ViewFileInput, JsonValue> {
  const signalsByToolCallId = new Map<string, AbortSignal>()
  return tool({
    description: VIEW_FILE_TOOL_SPEC.description,
    inputSchema: jsonSchema<ViewFileInput>(VIEW_FILE_TOOL_SPEC.inputSchema),
    async execute({ path }, { abortSignal, toolCallId }): Promise<JsonValue> {
      const signal = abortSignal ?? NEVER_ABORTED_SIGNAL
      signalsByToolCallId.set(toolCallId, signal)
      try {
        signal.throwIfAborted()
        const handle = await input.resolveSandbox()
        const absolutePath = resolveSafeSandboxPath(handle.sandbox.workingDirectory, path)
        const knownFileRef =
          input.registry.get(absolutePath) ??
          preparedFileRefAtPath(input.attachments, handle.sandbox.workingDirectory, absolutePath)

        let fileRef: FileRef
        if (knownFileRef) {
          fileRef = knownFileRef
        } else {
          const bytes = await readSandboxFile({ handle, absolutePath, signal })
          const fileName = safePublishedFileName(posix.basename(absolutePath))
          const artifact = await input.artifactsForToolCall({ toolCallId, signal }).put({
            body: bytes,
            fileName,
            mediaType: inferAgentFileMediaType(bytes, fileName),
          })
          fileRef = artifact.fileRef
        }

        // Prepared attachments and framework artifacts are immutable snapshots and can be reused.
        // Arbitrary bash paths stay mutable, so do not cache their published snapshot at the source
        // path; a later view_file call must read the path again.
        if (knownFileRef) input.registry.register(absolutePath, fileRef)
        return richViewFileResult(fileRef)
      } catch (error) {
        signalsByToolCallId.delete(toolCallId)
        throw error
      }
    },
    async toModelOutput({ output, toolCallId }) {
      const signal = signalsByToolCallId.get(toolCallId) ?? NEVER_ABORTED_SIGNAL
      try {
        return await input.toolResultToModelOutput({ output, toolCallId, signal })
      } finally {
        signalsByToolCallId.delete(toolCallId)
      }
    },
  })
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

function resolveSafeSandboxPath(workingDirectory: string, requestedPath: string): string {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw viewFileError("path must be a non-empty sandbox file path")
  }
  const root = posix.normalize(workingDirectory)
  const absolutePath = posix.resolve(root, requestedPath)
  if (absolutePath === root || !absolutePath.startsWith(`${root}/`)) {
    throw viewFileError("path must stay inside the sandbox working directory")
  }
  return absolutePath
}

async function readSandboxFile(input: {
  readonly handle: AgentSandboxHandle
  readonly absolutePath: string
  readonly signal: AbortSignal
}): Promise<Uint8Array> {
  const result = await input.handle.sandbox.runCommand("bash", ["-lc", READ_VIEW_FILE_SCRIPT], {
    env: {
      ...(input.handle.env ?? {}),
      SIXB_VIEW_FILE_PATH_B64: Buffer.from(input.absolutePath, "utf-8").toString("base64"),
      SIXB_VIEW_FILE_ROOT: input.handle.sandbox.workingDirectory,
      SIXB_VIEW_FILE_MAX_BYTES: String(VIEW_FILE_MAX_BYTES),
    },
    timeout: VIEW_FILE_TIMEOUT_MS,
    signal: input.signal,
  })
  input.signal.throwIfAborted()

  if (result.exitCode === 2) {
    throw viewFileError("file does not exist, is not a regular file, or is a symbolic link")
  }
  if (result.exitCode === 3) {
    throw viewFileError(`file exceeds the ${VIEW_FILE_MAX_BYTES}-byte inspection limit`)
  }
  if (result.exitCode === 4) {
    throw viewFileError("resolved path escapes the sandbox working directory")
  }
  if (result.exitCode !== 0) {
    throw viewFileError("file could not be read")
  }

  const separator = result.stdout.indexOf("\n")
  const sizeBytes = Number(result.stdout.slice(0, separator))
  const bytes = Buffer.from(
    separator < 0 ? "" : result.stdout.slice(separator + 1).trim(),
    "base64"
  )
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || bytes.byteLength !== sizeBytes) {
    throw viewFileError("file changed while it was being read")
  }
  return new Uint8Array(bytes)
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

function viewFileError(message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgentWorker] view_file ${message}.`)
}

const READ_VIEW_FILE_SCRIPT = `# sixb-read-view-file
set -euo pipefail
requested="$(printf '%s' "\${SIXB_VIEW_FILE_PATH_B64:?}" | base64 -d)"
root="\${SIXB_VIEW_FILE_ROOT:?}"
max_bytes="\${SIXB_VIEW_FILE_MAX_BYTES:?}"
if [ ! -f "$requested" ] || [ -L "$requested" ]; then
  exit 2
fi
parent="$(cd -P -- "$(dirname -- "$requested")" && pwd)"
resolved="$parent/$(basename -- "$requested")"
case "$resolved" in
  "$root"/*) ;;
  *) exit 4 ;;
esac
size="$(wc -c < "$resolved" | tr -d ' ')"
if [ "$size" -gt "$max_bytes" ]; then
  exit 3
fi
printf '%s\n' "$size"
head -c "$max_bytes" "$resolved" | base64 | tr -d '\n'`
