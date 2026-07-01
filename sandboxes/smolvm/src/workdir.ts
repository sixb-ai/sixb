import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The agent run's working directory.
 *
 * `dir` is used two ways: as the cwd for the host smolvm CLI process, and as the guest
 * `--workdir` / base path for files materialized via {@link SmolvmSandbox.writeFiles}. Files reach
 * the guest through in-guest writes (writeFiles execs base64 decodes inside the VM), NOT a host
 * bind mount — the guest filesystem is fully isolated from the host.
 */
export interface ResolvedWorkdir {
  /** Absolute path used as the host CLI cwd and the guest working directory. */
  readonly dir: string
  /** True when we created a temp dir and own its removal. */
  readonly cleanup: boolean
}

export async function resolveWorkdir(configured?: string): Promise<ResolvedWorkdir> {
  if (configured) {
    await mkdir(configured, { recursive: true })
    const dir = await realpath(configured)
    return { dir, cleanup: false }
  }
  const made = await mkdtemp(join(tmpdir(), "sixb-smolvm-"))
  const dir = await realpath(made)
  return { dir, cleanup: true }
}

export async function cleanupWorkdir(workdir: ResolvedWorkdir): Promise<void> {
  if (workdir.cleanup) {
    await rm(workdir.dir, { recursive: true, force: true })
  }
}
