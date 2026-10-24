/**
 * A file of the Agent's memory, installed under `$SIXB_MEMORY_DIR/<repo>/`
 * (`.sixb/agent/memory/<repo>/`), as the agent names it in a command or a tool call.
 */
const MEMORY_FILE =
  /(?:\$\{?SIXB_MEMORY_DIR\}?|\.sixb\/agent\/memory)\/(user|project)(?:\/([^\s"'`;|&<>()]*))?/

/** A memory file: its repo, and its path inside the repo. */
export interface MemoryFile {
  readonly repo: "user" | "project"
  readonly path: string
}

/** Whether `text` names a memory file or folder. */
export function mentionsMemory(text: string): boolean {
  return MEMORY_FILE.test(text)
}

/**
 * The first memory file `text` names; the conflict copy names the file it is for. Its path is `""`
 * for a repo itself. `null` when `text` names no memory file.
 */
export function memoryFile(text: string): MemoryFile | null {
  const match = text.match(MEMORY_FILE)
  if (!match) return null
  return {
    repo: match[1] === "project" ? "project" : "user",
    path: (match[2] ?? "").replace(/\/$/, "").replace(/\.theirs$/, ""),
  }
}

/**
 * A memory file as the chat names it: a note by its name in words, without its folder or `.md`;
 * any other file by its file name. The index, `MEMORY.md`, is the memory itself and has no name.
 */
export function memoryFileLabel(path: string): string | undefined {
  const name = path.split("/").filter(Boolean).at(-1)
  if (!name || path === "MEMORY.md") return undefined
  if (!name.endsWith(".md")) return name
  return name.slice(0, -".md".length).replace(/[_-]+/g, " ").trim() || undefined
}
