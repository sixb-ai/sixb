import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The agent run's working directory, bridged between host and guest.
 *
 * The agent worker (sandbox-api-context.ts) writes skills and run context to
 * sandbox.workingDirectory using host fs, and injects env vars (SIXB_CONTEXT_DIR,
 * SIXB_SKILLS_DIR, SIXB_RUN_CONTEXT) built from that same absolute path into the
 * guest. For both to resolve, the host directory must be bind-mounted into the
 * guest at the *identical* absolute path — the same trick the bwrap backend uses
 * (`--bind workingDirectory workingDirectory`). So guest path == host path, and
 * the volume maps a path to itself.
 */
export interface ResolvedWorkdir {
  /** Absolute path, valid on both host (fs writes) and guest (cwd + env paths). */
  readonly dir: string
  /** "<dir>:<dir>" bind mount for `smolvm machine create --volume`. */
  readonly volume: string
  /** True when we created a temp dir and own its removal. */
  readonly cleanup: boolean
}

export async function resolveWorkdir(configured?: string): Promise<ResolvedWorkdir> {
  if (configured) {
    await mkdir(configured, { recursive: true })
    const dir = await realpath(configured)
    return { dir, volume: `${dir}:${dir}`, cleanup: false }
  }
  const made = await mkdtemp(join(tmpdir(), "sixb-smolvm-"))
  const dir = await realpath(made)
  return { dir, volume: `${dir}:${dir}`, cleanup: true }
}

export async function cleanupWorkdir(workdir: ResolvedWorkdir): Promise<void> {
  if (workdir.cleanup) {
    await rm(workdir.dir, { recursive: true, force: true })
  }
}
