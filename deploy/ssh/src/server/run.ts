import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { constants } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import type { ProcessManifest } from "./manifest"
import { isPidRunning } from "./state"

/**
 * `ctl run <staged> <path> [args...]`: puts an uploaded script at `path` in the deployed project and
 * runs `sixb run` on it there, so its imports resolve against the deployed code, with the
 * environment the deployment's services start from. The caller holds the deploy lock shared for
 * the whole run, so no deploy replaces that code or migrates its storage underneath. Resolves with
 * the exit code to end with.
 *
 *   absent      write it, and delete it afterwards
 *   identical   run the deployed file in place
 *   different   refuse: the deployed file is someone's committed work
 *
 * One run per path at a time: a second run of the same new file would find the first one's copy,
 * and the first one's cleanup would delete it underneath the second. Each run marks its path, and
 * whether it wrote the file, so a later run removes what a killed one left in the deployed code.
 */
export async function runScript(input: {
  readonly manifest: ProcessManifest
  readonly staged: string
  readonly path: string
  readonly args: readonly string[]
}): Promise<number> {
  const { manifest, staged, path } = input
  try {
    assertProjectPath(path)
    if (!manifest.env) {
      throw new Error(
        `[SshTarget] ${manifest.name} was deployed before sixb run could run scripts on it. Deploy it again.`
      )
    }
    const project = manifest.cwd
    const marks = join(manifest.runDir, "scripts")
    await removeAbandoned(marks, project)
    const mark = await claimPath(marks, path)
    try {
      const target = resolve(project, path)
      const created = await placeScript(project, target, path, await readFile(staged))
      if (created) await mark.wrote(await stat(target))
      try {
        return await runSixb(project, path, input.args, manifest.env)
      } finally {
        if (created) await removeCreated(target, created)
      }
    } finally {
      await mark.release()
    }
  } finally {
    await rm(staged, { force: true })
  }
}

/** A path relative to the project with forward slashes, which `sixb run` records as given. */
function assertProjectPath(path: string): void {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`[SshTarget] '${path}' is not a path inside the project.`)
  }
}

/** What a run records about its path while it runs. */
interface Mark {
  readonly pid: number
  readonly path: string
  /** The file the run wrote, so it is the run's to remove while it is still that file. */
  readonly wrote?: { readonly ino: number; readonly mtimeMs: number }
}

/**
 * Marks `path` as running under this process's id until `release`. A mark whose process is gone
 * was left by a run that was killed: `removeAbandoned` clears it first.
 */
async function claimPath(
  marks: string,
  path: string
): Promise<{ wrote(file: Mark["wrote"]): Promise<void>; release(): Promise<void> }> {
  const file = join(marks, `${createHash("sha256").update(path).digest("hex")}.json`)
  const record = (wrote?: Mark["wrote"]) =>
    JSON.stringify({ pid: process.pid, path, ...(wrote ? { wrote } : {}) } satisfies Mark)
  try {
    await writeFile(file, record(), { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    throw new Error(`[SshTarget] ${path} is already running on the deployment.`)
  }
  return {
    wrote: (written) =>
      writeFile(file, record(written && { ino: written.ino, mtimeMs: written.mtimeMs })),
    release: () => rm(file, { force: true }),
  }
}

/**
 * Clears the marks of runs whose process is gone, removing each file such a run wrote unless
 * something has replaced it since, such as a deploy of the same path.
 */
async function removeAbandoned(marks: string, project: string): Promise<void> {
  await mkdir(marks, { recursive: true })
  for (const name of await readdir(marks)) {
    const file = join(marks, name)
    const mark = await readMark(file)
    if (mark && isPidRunning(mark.pid)) continue
    if (mark?.wrote) {
      try {
        assertProjectPath(mark.path)
        const target = resolve(project, mark.path)
        const current = await stat(target)
        if (current.ino === mark.wrote.ino && current.mtimeMs === mark.wrote.mtimeMs) {
          await rm(target, { force: true })
        }
      } catch {
        // Gone already, or a mark this code did not write: nothing to remove.
      }
    }
    await rm(file, { force: true })
  }
}

async function readMark(file: string): Promise<Mark | null> {
  try {
    const mark = JSON.parse(await readFile(file, "utf8")) as Partial<Mark>
    if (typeof mark.pid !== "number" || typeof mark.path !== "string") return null
    const wrote = mark.wrote
    return typeof wrote?.ino === "number" && typeof wrote.mtimeMs === "number"
      ? { pid: mark.pid, path: mark.path, wrote: { ino: wrote.ino, mtimeMs: wrote.mtimeMs } }
      : { pid: mark.pid, path: mark.path }
  } catch {
    return null
  }
}

/** Where the script was written, for cleanup: the first directory it had to make. */
interface Created {
  readonly firstDirectory: string | null
}

async function placeScript(
  project: string,
  target: string,
  path: string,
  source: Buffer
): Promise<Created | null> {
  // Checked before anything is made: a symlinked directory in the deployed code must not carry
  // the script, or the directories made for it, out of the project.
  const existing = await nearestExisting(dirname(target))
  if (relative(await realpath(project), await realpath(existing)).startsWith("..")) {
    throw new Error(`[SshTarget] '${path}' leads outside the deployed project.`)
  }
  const firstDirectory = existing === dirname(target) ? null : firstMissing(target, existing)
  await mkdir(dirname(target), { recursive: true })

  try {
    await writeFile(target, source, { flag: "wx", mode: 0o600 })
    return { firstDirectory }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }

  const deployed = await readFile(target)
  if (!deployed.equals(source)) {
    throw new Error(
      `[SshTarget] The deployed ${path} differs from yours. Rename your copy, or deploy it first.`
    )
  }
  return null
}

async function nearestExisting(directory: string): Promise<string> {
  let current = directory
  while (!(await stat(current).catch(() => null)) && dirname(current) !== current) {
    current = dirname(current)
  }
  return current
}

/** The directory just below `existing` on the way to `target`. */
function firstMissing(target: string, existing: string): string {
  let current = dirname(target)
  while (dirname(current) !== existing) current = dirname(current)
  return current
}

async function removeCreated(target: string, created: Created): Promise<void> {
  await rm(target, { force: true })
  if (!created.firstDirectory) return
  // Only directories left empty: whatever the script wrote next to itself stays.
  for (let current = dirname(target); ; current = dirname(current)) {
    const removed = await rmdir(current).then(
      () => true,
      () => false
    )
    if (!removed || current === created.firstDirectory) return
  }
}

/**
 * The project's own `sixb run`, on this Bun, with the environment the release's services start
 * from; the project's `.env` fills in the rest, as it does for them. It shares the terminal, so
 * Ctrl-C reaches it from there. A dropped connection hangs up only the session leader, which is
 * this process, so the hangup is passed on, as is a SIGTERM sent here.
 */
async function runSixb(
  project: string,
  path: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, join(project, "node_modules", ".bin", "sixb"), "run", path, ...args],
    {
      cwd: project,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        ...env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    }
  )
  const ignore = () => {}
  const hangUp = () => child.kill("SIGHUP")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", ignore)
  process.on("SIGHUP", hangUp)
  process.on("SIGTERM", terminate)
  try {
    const exitCode = await child.exited
    const signal = child.signalCode
    if (signal === null) return exitCode
    return 128 + (typeof signal === "number" ? signal : (constants.signals[signal] ?? 0))
  } finally {
    process.off("SIGINT", ignore)
    process.off("SIGHUP", hangUp)
    process.off("SIGTERM", terminate)
  }
}
