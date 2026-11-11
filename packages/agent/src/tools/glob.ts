import type { GlobSearchResult } from "@sixb/cli-core"
import type { JsonObject, JsonValue, ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { objectInput } from "./edit"
import { publicError } from "./file-writes"
import {
  INCOMPLETE_SEARCH_FOOTER,
  isRecord,
  optionalPathInput,
  runSandboxSearch,
  searchUnavailable,
} from "./sandbox-search"

export const GLOB_TOOL_SPEC = {
  name: "glob",
  strict: true,
  description:
    "Find files by name. A pattern without / matches at any depth (*.md finds every Markdown file); one with / matches from path (src/**/*.ts). Supports *, **, ?, [abc] and {a,b}. Skips .git and what .gitignore excludes, and hidden files and node_modules unless the pattern names them. Returns at most 100 paths, sorted. Prefer this over bash to find files.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to path." },
      path: {
        type: "string",
        description:
          "Folder to search: relative to the working directory, or an absolute path in the run's context directory. Default: the working directory.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export interface GlobToolInput {
  readonly pattern: string
  readonly path?: string
}

export interface GlobToolOutput {
  readonly pattern: string
  /** As the call named it; `.` for the working directory. */
  readonly path: string
  /** Relative to the working directory when under it, absolute otherwise. */
  readonly files: readonly string[]
  /** More files match than the 100 listed. */
  readonly truncated: boolean
  /** The search stopped at its deadline. */
  readonly incomplete?: true
}

export function createGlobTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>
): ModelTool<GlobToolInput> {
  return {
    ...GLOB_TOOL_SPEC,
    parseInput: parseGlobInput,
    async execute(input, { signal }): Promise<JsonValue> {
      const handle = await resolveSandbox()
      const result = await runSandboxSearch(handle, { tool: "glob", ...input }, signal)
      if (!isGlobResult(result)) {
        throw searchUnavailable(
          "glob",
          "its output could not be read",
          new Error("Invalid sandbox output.")
        )
      }

      return {
        pattern: input.pattern,
        path: input.path ?? ".",
        files: result.files,
        truncated: result.truncated,
        ...(result.incomplete ? { incomplete: true } : {}),
      } satisfies GlobToolOutput
    },
    toModelOutput(output) {
      return { type: "text", value: globModelText(output as unknown as GlobToolOutput) }
    },
    errorText: agentToolErrorText,
  }
}

/** One path per line, then what the list leaves out. */
export function globModelText(output: GlobToolOutput): string {
  const footers = [
    ...(output.truncated
      ? [`(${output.files.length} files shown, more match: narrow the pattern or the path)`]
      : []),
    ...(output.incomplete ? [INCOMPLETE_SEARCH_FOOTER] : []),
  ]
  const list = output.files.length > 0 ? output.files.join("\n") : "No files found"
  return [list, ...footers].join("\n\n")
}

function parseGlobInput(value: unknown): GlobToolInput {
  const input = objectInput(value, "glob", ["pattern", "path"])
  if (typeof input.pattern !== "string" || input.pattern === "") {
    throw publicError("glob", "pattern must be a non-empty glob pattern.")
  }
  // Either would find nothing, and the model would read that nothing matches.
  if (input.pattern.startsWith("/")) {
    throw publicError(
      "glob",
      "pattern is relative to path: pass the folder as path and the rest as pattern."
    )
  }
  if (input.pattern.endsWith("/")) {
    throw publicError("glob", "glob finds files: drop the trailing /, or read the folder.")
  }

  const path = optionalPathInput(input.path, "glob")
  return { pattern: input.pattern, ...(path === undefined ? {} : { path }) }
}

function isGlobResult(value: unknown): value is GlobSearchResult {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.every((file) => typeof file === "string") &&
    typeof value.truncated === "boolean" &&
    (value.incomplete === undefined || value.incomplete === true)
  )
}
