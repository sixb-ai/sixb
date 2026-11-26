import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * Commands owned by `@sixb/project-cli` (`sixb-project`), pinned to a Sixb project's framework
 * version. `sixb` delegates these in JS rather than maintaining a shell shim allowlist.
 */
export const PROJECT_COMMANDS = new Set([
  "dev",
  "serve",
  "check",
  "typegen",
  "build",
  "run",
  "env",
  "deploy",
  "desktop",
  "db",
  "lake",
  "init",
  "agent",
  "connect",
])

export interface ProjectCliTarget {
  readonly command: string
  readonly prefixArgs: readonly string[]
}

/**
 * Locate the nearest project-local `sixb-project` binary by walking up from `cwd`, falling back to
 * `sixb-project` on PATH. Never looks inside `node_modules/.bin/sixb`, so `sixb` never shadows
 * itself.
 */
export function findProjectCli(
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env
): ProjectCliTarget | null {
  let dir = resolve(cwd)
  for (;;) {
    const localBin = join(dir, "node_modules", ".bin", "sixb-project")
    if (isExecutable(localBin)) {
      return { command: localBin, prefixArgs: [] }
    }
    // Workspace development inside the sixb monorepo itself.
    const workspaceEntry = join(dir, "packages", "project-cli", "src", "index.tsx")
    if (isReadable(workspaceEntry)) {
      return { command: "bun", prefixArgs: [workspaceEntry] }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const entry of (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!entry) continue
    const candidate = join(entry, "sixb-project")
    if (isExecutable(candidate)) {
      return { command: candidate, prefixArgs: [] }
    }
  }
  return null
}

/** Spawn `sixb-project` with inherited stdio and return its exit code. */
export async function runProjectCli(
  target: ProjectCliTarget,
  args: readonly string[]
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(target.command, [...target.prefixArgs, ...args], {
      stdio: "inherit",
    })
    const onSigint = () => child.kill("SIGINT")
    const onSigterm = () => child.kill("SIGTERM")
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)
    child.on("error", (error) => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      reject(error)
    })
    child.on("close", (code, signal) => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      if (signal) resolveExit(128)
      else resolveExit(code ?? 1)
    })
  })
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}
