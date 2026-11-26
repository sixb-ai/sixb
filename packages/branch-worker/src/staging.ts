import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Where a worker stages a copy before it reaches a sandbox: the snapshot file and the lake
 * catalog. Production writes the snapshot whole first, so its consistent read never waits on a
 * sandbox's upload; each copy's folder goes once its sandbox has it. A folder is named for its
 * worker's process, so a worker that starts clears what a dead one left, and never a live one's.
 */
const STAGING_ROOT = join(tmpdir(), "sixb-branch-staging")

/** A new folder for one copy, removed by its caller. */
export async function stagingDirectory(): Promise<string> {
  await mkdir(STAGING_ROOT, { recursive: true })
  return mkdtemp(join(STAGING_ROOT, `${process.pid}-`))
}

/** Removes the copies of workers whose process is gone. */
export async function clearStaleStaging(): Promise<void> {
  const entries = await readdir(STAGING_ROOT).catch(() => [] as string[])

  for (const entry of entries) {
    const pid = Number(entry.split("-")[0])
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) continue
    await rm(join(STAGING_ROOT, entry), { recursive: true, force: true })
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process of another user is alive, though this one may not signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
