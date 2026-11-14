import { posix } from "node:path"
import type { JsonObject, JsonValue, ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { editText } from "./edit-text"
import {
  commitSandboxFile,
  type FileReadLedger,
  type LoadedSandboxFile,
  loadSandboxFile,
  publicError,
} from "./file-writes"

export const EDIT_TOOL_SPEC = {
  name: "edit",
  strict: true,
  description:
    "Replace text in a file. old_string must match the file exactly, once, unless replace_all is true. Read the file first: an edit refuses a file that changed since you read it. Returns the change as a diff, so there is no need to read the file again to check it.",
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
}

export function createEditTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  ledger: FileReadLedger
): ModelTool<EditToolInput> {
  return {
    ...EDIT_TOOL_SPEC,
    parseInput: parseEditInput,
    async execute(input, { signal }): Promise<JsonValue> {
      const handle = await resolveSandbox()
      const loaded = await loadSandboxFile(handle, { path: input.path, tool: "edit", signal })
      if (loaded.kind === "missing") {
        throw publicError("edit", `'${input.path}' does not exist. Create it with write.`)
      }
      assertReadAsIs(ledger, loaded, input.path, "edit")

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
        path: loaded.realPath,
        expected: loaded.fingerprint,
        bytes: new TextEncoder().encode(edited.text),
        tool: "edit",
        signal,
      })
      ledger.record(written.realPath, written.fingerprint)
      return {
        path: input.path,
        replaced: edited.replaced,
        diff: edited.diff,
        added: edited.added,
        removed: edited.removed,
      } satisfies EditToolOutput
    },
    errorText: agentToolErrorText,
  }
}

/** An existing file is changed only as the run last read or wrote it. */
export function assertReadAsIs(
  ledger: FileReadLedger,
  loaded: Extract<LoadedSandboxFile, { kind: "file" }>,
  path: string,
  tool: string
): void {
  const seen = ledger.get(loaded.realPath)
  if (seen === undefined) {
    throw publicError(tool, `read '${path}' with the read tool before changing it.`)
  }
  if (seen !== loaded.fingerprint) {
    throw publicError(
      tool,
      `'${path}' changed since you read it. Read it again, then make your change.`
    )
  }
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
