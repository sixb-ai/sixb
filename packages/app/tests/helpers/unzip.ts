import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The machine's unzip, which reads an .xlsx as Excel would find it: its parts are deflated, so a
 * test reads none of their XML from the archive's bytes. Tests that read parts skip without it.
 */
export const UNZIP = Bun.which("unzip")

/** Runs unzip with a bound, as a child process: its output, or why it failed. */
export async function unzip(...args: string[]): Promise<string> {
  const child = Bun.spawn([UNZIP ?? "unzip", ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 10_000)

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)

  if (code !== 0) throw new Error(`unzip ${args.join(" ")} exited ${code}: ${err || out}`)
  return out
}

/** One part of an archive built in memory, read through a file that is removed after. */
export async function archivePart(bytes: Uint8Array, part: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sixb-archive-"))
  try {
    const file = join(directory, "archive.zip")
    await writeFile(file, bytes)
    return await unzip("-p", file, part)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
