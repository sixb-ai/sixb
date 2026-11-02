import { watch } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { resolveConfigPath } from "../lib/profiles"

// The folders chosen on this computer. A conversation's folder is only text on the server, so a
// stolen web sign-in could name any folder: nothing sent from elsewhere runs in one that isn't
// listed here. Kept beside the CLI's sign-in, where the agent's own commands can't reach it.

const ALLOWED_FOLDERS_FILE = () => join(dirname(resolveConfigPath()), "allowed-folders.json")

/** The folders chosen on this computer. Throws when the list can't be read. */
export async function readAllowedFolders(): Promise<readonly string[]> {
  const text = await readFile(ALLOWED_FOLDERS_FILE(), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]"
    throw error
  })
  const stored: unknown = JSON.parse(text)
  if (!Array.isArray(stored)) throw new Error("[SixbCLI] allowed-folders.json is not a list.")
  return stored.filter((folder): folder is string => typeof folder === "string")
}

/** Whether `folder` was chosen here. A list that can't be read allows nothing. */
export async function isFolderAllowed(folder: string): Promise<boolean> {
  return readAllowedFolders().then(
    (folders) => folders.includes(folder),
    () => false
  )
}

/**
 * Allow or forget folders. Reads the file first, as another `sixb` may have written it, and refuses
 * one it can't read rather than lose the choices in it. Written whole, so no reader finds half.
 */
export async function setFoldersAllowed(
  changed: readonly string[],
  allowed: boolean
): Promise<void> {
  const others = (await readAllowedFolders()).filter((folder) => !changed.includes(folder))
  const path = ALLOWED_FOLDERS_FILE()
  const written = `${path}.${process.pid}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(
    written,
    `${JSON.stringify(allowed ? [...others, ...changed] : others, null, 2)}\n`,
    {
      mode: 0o600,
    }
  )
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
