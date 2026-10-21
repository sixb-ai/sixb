/**
 * A file of the Agent's memory, installed under `$SIXB_MEMORY_DIR/<repo>/`
 * (`.sixb/agent/memory/<repo>/`), as the agent names it in a command or a tool call.
 */
const MEMORY_FILE =
  /(?:\$\{?SIXB_MEMORY_DIR\}?|\.sixb\/agent\/memory)\/(?:user|project)(?:\/([^\s"'`;|&<>()]*))?/

/** Whether `text` names a memory file or folder. */
export function mentionsMemory(text: string): boolean {
  return MEMORY_FILE.test(text)
}

/**
 * The first memory file `text` names, as its path inside the repo; the conflict copy names the
 * file it is for. `""` for a repo itself, `null` when `text` names no memory file.
 */
export function memoryFilePath(text: string): string | null {
  const match = text.match(MEMORY_FILE)
  if (!match) return null
  return (match[1] ?? "").replace(/\/$/, "").replace(/\.theirs$/, "")
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
