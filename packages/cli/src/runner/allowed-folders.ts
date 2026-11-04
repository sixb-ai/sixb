import { randomUUID } from "node:crypto"
import { watch } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { Connection } from "../lib/connection"
import { resolveConfigPath } from "../lib/profiles"

// The folders chosen on this computer, for each project. A conversation's folder is only text on
// the server, so a stolen web sign-in could name any folder: nothing sent from elsewhere runs in one
// that isn't listed here for that project, and choosing a folder for one project says nothing about
// another. Kept beside the CLI's sign-in, where the agent's own commands can't reach it.

const ALLOWED_FOLDERS_FILE = () => join(dirname(resolveConfigPath()), "allowed-folders.json")

/** The project a list is for: `connect` names it. */
export type AllowedFor = Pick<Connection, "apiUrl" | "project">

/** Its address as well as its id: a project reports its own id, and two can share one. */
function keyOf({ apiUrl, project }: AllowedFor): string {
  return `${project.id} at ${apiUrl}`
}

type StoredFolders = Readonly<Record<string, readonly string[]>>

async function readStored(): Promise<StoredFolders> {
  const text = await readFile(ALLOWED_FOLDERS_FILE(), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}"
    throw error
  })
  const stored: unknown = JSON.parse(text)
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    throw new Error("[SixbCLI] allowed-folders.json doesn't list folders by project.")
  }
  return Object.fromEntries(
    Object.entries(stored).map(([key, folders]) => [
      key,
      Array.isArray(folders)
        ? folders.filter((folder): folder is string => typeof folder === "string")
        : [],
    ])
  )
}

/** The folders chosen on this computer for `project`. Throws when the list can't be read. */
export async function readAllowedFolders(project: AllowedFor): Promise<readonly string[]> {
  return (await readStored())[keyOf(project)] ?? []
}

/** Whether `folder` was chosen here for `project`. A list that can't be read allows nothing. */
export async function isFolderAllowed(project: AllowedFor, folder: string): Promise<boolean> {
  return readAllowedFolders(project).then(
    (folders) => folders.includes(folder),
    () => false
  )
}

let lastChange: Promise<unknown> = Promise.resolve()

/**
 * Allow or forget folders for `project`. One at a time here, so that a quick off and on can't undo
 * each other: a folder forgotten stays forgotten.
 */
export function setFoldersAllowed(
  project: AllowedFor,
  changed: readonly string[],
  allowed: boolean
): Promise<void> {
  const change = lastChange.then(() => writeChange(project, changed, allowed))
  lastChange = change.catch(() => {})
  return change
}

/**
 * Reads the file first, as another `sixb` may have written it, and refuses one it can't read rather
 * than lose the choices in it. Written whole, so no reader finds half.
 */
async function writeChange(
  project: AllowedFor,
  changed: readonly string[],
  allowed: boolean
): Promise<void> {
  const stored = await readStored()
  const key = keyOf(project)
  const others = (stored[key] ?? []).filter((folder) => !changed.includes(folder))
  const folders = allowed ? [...others, ...changed] : others
  const path = ALLOWED_FOLDERS_FILE()
  const written = `${path}.${randomUUID()}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(written, `${JSON.stringify({ ...stored, [key]: folders }, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(written, path)
}

/** Call `changed` whenever the list may have changed. Returns the way to stop. */
export async function watchAllowedFolders(changed: () => void): Promise<() => void> {
  const path = ALLOWED_FOLDERS_FILE()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // The directory: a write replaces the file, which a watch on the file itself would lose.
  const watcher = watch(dirname(path), (_event, name) => {
    if (name === basename(path)) changed()
  })
  return () => watcher.close()
}
