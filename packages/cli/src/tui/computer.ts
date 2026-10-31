import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { hostname, type as osType } from "node:os"
import { dirname, join } from "node:path"
import { resolveConfigPath } from "../lib/profiles"

// This computer's id, which every claim of a turn names: a conversation that runs on its owner's
// computer runs on one of them, and only that one claims its turns. Kept beside the CLI's sign-in,
// which the agent's commands never read. Not a secret: it tells your own computers apart.

const COMPUTER_FILE = () => join(dirname(resolveConfigPath()), "computer.json")

const named = new Map<string, Promise<string>>()

/** This computer's id: named once, the first time `sixb` runs here, and kept. */
export function thisComputerId(): Promise<string> {
  const path = COMPUTER_FILE()
  let id = named.get(path)
  if (!id) {
    id = readOrName(path)
    named.set(path, id)
    // A failure is not kept: the next call tries again.
    id.catch(() => named.delete(path))
  }
  return id
}

/** This computer: its id, and what its owner calls it, as the web shows where a thread runs. */
export async function thisComputer(): Promise<{ readonly id: string; readonly name: string }> {
  const [id, name] = await Promise.all([thisComputerId(), thisComputerName()])
  return { id, name }
}

let computerName: Promise<string> | undefined

/** The name its owner gave the computer: its Mac name, else its host name. */
function thisComputerName(): Promise<string> {
  computerName ??= readComputerName().then((name) =>
    // Shown back as written: no control characters, and short.
    (
      name
        .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
        .trim() || "This computer"
    ).slice(0, 120)
  )
  return computerName
}

async function readComputerName(): Promise<string> {
  if (osType() === "Darwin") {
    try {
      const scutil = Bun.spawn(["scutil", "--get", "ComputerName"], {
        stdout: "pipe",
        stderr: "ignore",
      })
      const timer = setTimeout(() => scutil.kill(), 2_000)
      const name = await new Response(scutil.stdout).text()
      clearTimeout(timer)
      if ((await scutil.exited) === 0 && name.trim()) return name
    } catch {
      // Not every Mac answers: its host name stands in.
    }
  }
  return hostname().replace(/\.local$/, "")
}

async function readOrName(path: string): Promise<string> {
  const stored = await read(path)
  if (stored) return stored

  const id = `cmp_${randomUUID()}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    return id
  } catch (error) {
    // Another sixb named this computer first: its name is the one.
    const raced = await read(path)
    if (raced) return raced
    throw new Error(
      `[SixbCLI] Could not keep this computer's id in ${path}: remove the file, and sixb names the computer again.`,
      { cause: error }
    )
  }
}

async function read(path: string): Promise<string | undefined> {
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as { readonly id?: unknown }
    return typeof stored.id === "string" && stored.id.trim() ? stored.id : undefined
  } catch {
    return undefined
  }
}
