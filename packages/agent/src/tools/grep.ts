import type { JsonObject, JsonValue, ModelTool } from "@sixb/core/models"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { objectInput } from "./edit"
import { publicError } from "./file-writes"
import {
  INCOMPLETE_SEARCH_FOOTER,
  isLeftOut,
  isRecord,
  optionalPathInput,
  runSandboxSearch,
  searchUnavailable,
} from "./sandbox-search"
import type { GrepMatch, GrepSearchResult } from "./search/request"

export const GREP_TOOL_SPEC = {
  name: "grep",
  strict: true,
  description:
    "Search file contents with a JavaScript regular expression, or with literal text. Case is ignored unless the pattern has an uppercase letter. Searches hidden files, and skips .git, node_modules, what .gitignore excludes, binary files and files over 10 MiB. Matches the first 4,000 characters of a line. Returns matching lines grouped by file, at most 100 in all and 20 per file, with line numbers that read takes as its offset. Prefer this over bash to search text.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression, or the text itself with literal.",
      },
      path: {
        type: "string",
        description:
          "File or folder to search: relative to the working directory, or an absolute path in the run's context directory. Default: the working directory.",
      },
      include: {
        type: "string",
        description: "Glob pattern the files must match, such as *.ts or *.{ts,tsx}.",
      },
      literal: {
        type: "boolean",
        description: "Search the pattern as written, not as a regular expression. Default: false.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export interface GrepToolInput {
  readonly pattern: string
  readonly path?: string
  readonly include?: string
  readonly literal?: boolean
}

export interface GrepToolOutput {
  readonly pattern: string
  /** As the call named it; `.` for the working directory. */
  readonly path: string
  /** Paths relative to the working directory when under it, absolute otherwise. */
  readonly matches: readonly GrepMatch[]
  /** How many files the matches are in. */
  readonly files: number
  /** Matching lines past the 20 a file shows, by path. */
  readonly more?: Readonly<Record<string, number>>
  /** Another file matches past the 100 lines shown. */
  readonly truncated: boolean
  /** The search stopped at its deadline. */
  readonly incomplete?: true
}

export function createGrepTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>
): ModelTool<GrepToolInput> {
  return {
    ...GREP_TOOL_SPEC,
    parseInput: parseGrepInput,
    async execute(input, { signal }): Promise<JsonValue> {
      const handle = await resolveSandbox()
      const result = await runSandboxSearch(handle, { tool: "grep", ...input }, signal)
      if (!isGrepResult(result)) {
        throw searchUnavailable(
          "grep",
          "its output could not be read",
          new Error("Invalid sandbox output.")
        )
      }

      return {
        pattern: input.pattern,
        path: input.path ?? ".",
        matches: result.matches.map(({ path, line, text }) => ({ path, line, text })),
        files: result.files,
        ...(result.more ? { more: result.more } : {}),
        truncated: result.truncated,
        ...(result.incomplete ? { incomplete: true } : {}),
      } satisfies GrepToolOutput
    },
    toModelOutput(output) {
      return { type: "text", value: grepModelText(output as unknown as GrepToolOutput) }
    },
    errorText: agentToolErrorText,
  }
}

/**
 * Matches grouped by file, each line with its number, then how many more the file holds:
 *
 * ```
 * src/config.ts
 *   12: const retries = 3
 *   … 7 more in this file
 * ```
 */
export function grepModelText(output: GrepToolOutput): string {
  const groups: string[] = []
  let group: string[] = []
  let path: string | undefined

  const close = () => {
    if (path === undefined) return
    const more = output.more?.[path]
    if (more) group.push(`  … ${more} more in this file`)
    groups.push(group.join("\n"))
  }

  for (const match of output.matches) {
    if (match.path !== path) {
      close()
      path = match.path
      group = [match.path]
    }
    group.push(`  ${match.line}: ${match.text}`)
  }
  close()

  const footers = [
    ...(output.truncated
      ? [
          `(${output.matches.length} matching lines shown, more match: narrow the pattern, the path or include)`,
        ]
      : []),
    ...(output.incomplete ? [INCOMPLETE_SEARCH_FOOTER] : []),
  ]
  return [groups.length > 0 ? groups.join("\n\n") : "No matches", ...footers].join("\n\n")
}

function parseGrepInput(value: unknown): GrepToolInput {
  const input = objectInput(value, "grep", ["pattern", "path", "include", "literal"])
  if (typeof input.pattern !== "string" || input.pattern === "") {
    throw publicError("grep", "pattern must be a non-empty pattern.")
  }
  if (input.literal !== undefined && input.literal !== null && typeof input.literal !== "boolean") {
    throw publicError("grep", "literal must be true or false.")
  }

  const path = optionalPathInput(input.path, "grep")
  const include = isLeftOut(input.include) ? undefined : input.include
  if (include !== undefined && typeof include !== "string") {
    throw publicError("grep", "include must be a glob pattern.")
  }

  return {
    pattern: input.pattern,
    ...(path === undefined ? {} : { path }),
    ...(include === undefined ? {} : { include }),
    ...(input.literal === true ? { literal: true } : {}),
  }
}

function isGrepResult(value: unknown): value is GrepSearchResult {
  return (
    isRecord(value) &&
    Array.isArray(value.matches) &&
    value.matches.every(isGrepMatch) &&
    typeof value.files === "number" &&
    (value.more === undefined ||
      (isRecord(value.more) &&
        Object.values(value.more).every((count) => typeof count === "number"))) &&
    typeof value.truncated === "boolean" &&
    (value.incomplete === undefined || value.incomplete === true)
  )
}

function isGrepMatch(value: unknown): value is GrepMatch {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.line === "number" &&
    typeof value.text === "string"
  )
}
