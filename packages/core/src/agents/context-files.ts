import { posix } from "node:path"
import type { JsonValue } from "../json"
import type { AgentHistoryPartName } from "./message"

/** The tools that read a file whole into the context: the agent package's `read` and `view_file`. */
const CONTEXT_FILE_READERS: ReadonlySet<string> = new Set(["read", "view_file"])

/** The folders of the run's context directory a context meter names, and the variable for each. */
const CONTEXT_FOLDERS = [
  { part: "memory", folder: "memory", variable: "$SIXB_MEMORY_DIR" },
  { part: "skills", folder: "skills", variable: "$SIXB_SKILLS_DIR" },
  { part: "ontology", folder: "ontology", variable: "$SIXB_ONTOLOGY_DIR" },
] as const

/**
 * What a tool call read when it read one of the run's context files: memory, a skill or the
 * ontology, by the path its `read` or `view_file` call named. Anything else is a tool result,
 * including the same file printed by a bash `cat`: a command's output is not a file read.
 */
export function agentContextFileKind(
  call: { readonly toolName: string; readonly input: JsonValue },
  contextDirectory: string | undefined
): Extract<AgentHistoryPartName, "memory" | "skills" | "ontology"> | undefined {
  if (!CONTEXT_FILE_READERS.has(call.toolName)) return undefined

  const input = call.input
  const path =
    typeof input === "object" && input !== null && !Array.isArray(input) ? input.path : undefined
  if (typeof path !== "string") return undefined

  const normalized = posix.normalize(path.trim())
  const root = contextDirectory === undefined ? undefined : posix.normalize(contextDirectory)
  // A relative context directory is named from the working directory, which an absolute path
  // spells out in front of it.
  const under = (folder: string) => {
    if (root === undefined) return false

    const prefix = `${posix.join(root, folder)}/`
    return (
      normalized.startsWith(prefix) ||
      (!posix.isAbsolute(root) && normalized.includes(`/${prefix}`))
    )
  }
  const match = CONTEXT_FOLDERS.find(
    ({ folder, variable }) => normalized.startsWith(`${variable}/`) || under(folder)
  )
  return match?.part
}
