import { posix } from "node:path"
import type { JsonObject, JsonValue, ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { editText } from "./edit-text"
import { commitSandboxFile, loadSandboxFile, publicError, type SeenFiles } from "./file-writes"

export const EDIT_TOOL_SPEC = {
  name: "edit",
  strict: true,
  description:
    "Replace text in a file. old_string must match the file as it is now, exactly and once, unless replace_all is true. Returns the change as a diff, so there is no need to read the file again to check it.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path relative to the working directory, or an absolute path in the run's context directory.",
      },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The text to put in its place." },
      replace_all: {
        type: "boolean",
        description: "Replace every match of old_string. Default: false.",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export interface EditToolInput {
  readonly path: string
  readonly old_string: string
  readonly new_string: string
  readonly replace_all?: boolean
}

export interface EditToolOutput {
  readonly path: string
  readonly replaced: number
  /** Unified diff of the change, with line numbers; cut past a few thousand characters. */
  readonly diff: string
  /** Lines the change adds and removes, all of them, however short the diff was cut. */
  readonly added: number
  readonly removed: number
  /** Set when the file was not the version the model last saw: it holds changes it has not seen. */
  readonly note?: string
}

export function createEditTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  seenFiles: SeenFiles
): ModelTool<EditToolInput> {
  return {
    ...EDIT_TOOL_SPEC,
    parseInput: parseEditInput,
    async execute(input, { signal, callId }): Promise<JsonValue> {
      const handle = await resolveSandbox()
      const loaded = await loadSandboxFile(handle, { path: input.path, tool: "edit", signal })
      if (loaded.kind === "missing") {
        throw publicError("edit", `'${input.path}' does not exist. Create it with write.`)
      }
      const seen = seenFiles.get(loaded.realPath, callId)
      const stale = seen !== undefined && seen.fingerprint !== loaded.fingerprint

      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes)
      } catch {
        throw publicError("edit", `'${input.path}' is not UTF-8 text.`)
      }
      const edited = editText(text, {
        old: input.old_string,
        new: input.new_string,
        all: input.replace_all === true,
      })
      if (!edited.ok) throw publicError("edit", edited.reason)

      const written = await commitSandboxFile(handle, {
        path: input.path,
        loaded,
        bytes: new TextEncoder().encode(edited.text),
        tool: "edit",
        signal,
      })
      // The model now knows the file as it saw it plus this diff: all of it only when it saw
      // it whole, as it was.
      seenFiles.recordWrite(written.realPath, written.fingerprint, seen?.whole === true && !stale)
      return {
        path: input.path,
        replaced: edited.replaced,
        diff: edited.diff,
        added: edited.added,
        removed: edited.removed,
        ...(stale ? { note: staleNote(input.path) } : {}),
      } satisfies EditToolOutput
    },
    errorText: agentToolErrorText,
  }
}

function staleNote(path: string): string {
  return `The edit was applied, but '${path}' had changed since you last read or changed it, so it holds changes you have not seen. Read it before an edit that depends on what is around this one.`
}

function parseEditInput(value: unknown): EditToolInput {
  const input = objectInput(value, "edit", ["path", "old_string", "new_string", "replace_all"])
  const path = pathInput(input.path, "edit")
  if (typeof input.old_string !== "string" || input.old_string === "") {
    throw publicError("edit", "old_string must be the non-empty text to replace.")
  }
  if (typeof input.new_string !== "string") {
    throw publicError("edit", "new_string must be a string.")
  }
  if (input.old_string === input.new_string) {
    throw publicError("edit", "new_string is the same as old_string: there is nothing to change.")
  }
  if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") {
    throw publicError("edit", "replace_all must be true or false.")
  }
  return {
    path,
    old_string: input.old_string,
    new_string: input.new_string,
    ...(input.replace_all === undefined ? {} : { replace_all: input.replace_all }),
  }
}

export function objectInput(
  value: unknown,
  tool: string,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw publicError(tool, "input must be an object.")
  }
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) throw publicError(tool, `input has an unknown property '${key}'.`)
  }
  return input
}

export function pathInput(value: unknown, tool: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw publicError(tool, "path must be a non-empty path.")
  }
  return posix.normalize(value)
}
