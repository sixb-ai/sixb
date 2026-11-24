import type { JsonObject, JsonValue, ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { objectInput, pathInput } from "./edit"
import {
  commitSandboxFile,
  loadSandboxFile,
  MAX_EDITED_FILE_BYTES,
  publicError,
  type SeenFile,
  type SeenFiles,
} from "./file-writes"

export const WRITE_TOOL_SPEC = {
  name: "write",
  strict: true,
  description:
    "Create a file, or replace one whole; missing parent directories are created. Replacing an existing file needs all of it read first, as it is now. To change part of a file, use edit.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path relative to the working directory, or an absolute path in the run's context directory.",
      },
      content: { type: "string", description: "The file's whole new contents." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export interface WriteToolInput {
  readonly path: string
  readonly content: string
}

export interface WriteToolOutput {
  readonly path: string
  /** True when the file did not exist before. */
  readonly created: boolean
  readonly lines: number
  readonly bytes: number
}

export function createWriteTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  seenFiles: SeenFiles
): ModelTool<WriteToolInput> {
  return {
    ...WRITE_TOOL_SPEC,
    parseInput: parseWriteInput,
    async execute(input, { signal, callId }): Promise<JsonValue> {
      const bytes = new TextEncoder().encode(input.content)
      if (bytes.byteLength > MAX_EDITED_FILE_BYTES) {
        throw publicError(
          "write",
          `content is larger than ${MAX_EDITED_FILE_BYTES / 1024 / 1024} MiB: write it with bash.`
        )
      }
      const handle = await resolveSandbox()
      const loaded = await loadSandboxFile(handle, { path: input.path, tool: "write", signal })
      if (loaded.kind === "file") {
        assertSeenWhole(seenFiles.get(loaded.realPath, callId), loaded.fingerprint, input.path)
      }

      const written = await commitSandboxFile(handle, {
        path: input.path,
        loaded,
        bytes,
        tool: "write",
        signal,
      })
      seenFiles.recordWrite(written.realPath, written.fingerprint, true)
      return {
        path: input.path,
        created: loaded.kind === "missing",
        lines: lineCount(input.content),
        bytes: bytes.byteLength,
      } satisfies WriteToolOutput
    },
    errorText: agentToolErrorText,
  }
}

/** Replacing a file drops all of it: the model must have seen all of it, as it is now. */
function assertSeenWhole(seen: SeenFile | undefined, fingerprint: string, path: string): void {
  if (seen !== undefined && seen.fingerprint !== fingerprint) {
    throw publicError(
      "write",
      `'${path}' changed since you last read or changed it. Read all of it again first.`
    )
  }
  if (!seen?.whole) {
    throw publicError(
      "write",
      `you have not seen all of '${path}', and write replaces it whole: read the whole file first, or change part of it with edit.`
    )
  }
}

function lineCount(content: string): number {
  if (content === "") return 0
  const newlines = content.split("\n").length - 1
  return content.endsWith("\n") ? newlines : newlines + 1
}

function parseWriteInput(value: unknown): WriteToolInput {
  const input = objectInput(value, "write", ["path", "content"])
  const path = pathInput(input.path, "write")
  if (typeof input.content !== "string") throw publicError("write", "content must be a string.")
  return { path, content: input.content }
}
