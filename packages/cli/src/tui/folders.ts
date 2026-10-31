import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { resolveConfigPath } from "../lib/profiles"

// Which folder each conversation that runs on this computer works in. A conversation's turns run
// only there: opened from another folder, it says where it lives instead of working on the wrong
// files. Kept on this computer, beside the CLI's profiles.

const FOLDERS_FILE = () => join(dirname(resolveConfigPath()), "conversations.json")

type Folders = Record<string, string>

async function load(): Promise<Folders> {
  try {
    const stored = JSON.parse(await readFile(FOLDERS_FILE(), "utf8")) as unknown
    return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Folders) : {}
  } catch {
    return {}
  }
}

/** The folder a conversation works in on this computer; undefined when it started elsewhere. */
export async function folderOf(threadId: string): Promise<string | undefined> {
  return (await load())[threadId]
}

/** Keep `folder` as the one a conversation works in on this computer. */
export async function rememberFolder(threadId: string, folder: string): Promise<void> {
  const folders = await load()
  folders[threadId] = folder
  await writeFile(FOLDERS_FILE(), `${JSON.stringify(folders, null, 2)}\n`, { mode: 0o600 }).catch(
    () => {}
  )
}

/** The conversations that work in `folder` on this computer. */
export async function conversationsIn(folder: string): Promise<readonly string[]> {
  return Object.entries(await load()).flatMap(([threadId, path]) =>
    path === folder ? [threadId] : []
  )
}
