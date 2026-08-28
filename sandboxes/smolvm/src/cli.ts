/**
 * Pure argv builders for the smolvm CLI (verified against smolvm 1.3.0).
 *
 * All smolvm-specific invocation knowledge lives here so it is unit-testable
 * without a running VM and adjustable in one place if the CLI changes. No
 * spawning happens in this module.
 */

export interface SmolvmCliConfig {
  /** Resolved smolvm binary name or absolute path. */
  readonly bin: string
  /**
   * OCI image the VM boots from. Sixb agent images need Bash, realpath, tail, head, base64, CA
   * certificates, and Bun 1.3+ or Node 22+.
   *
   * IMPORTANT: smolvm pulls the image at `start` from inside the guest, so an
   * image machine needs guest network reachability to its registry. With a
   * restricted/none network policy the pull fails. Omit `image` for a bare
   * machine (built-in busybox rootfs) that boots fully offline.
   */
  readonly image?: string
  /** `--storage` GiB: OCI layers + container data (smolvm default 20). */
  readonly storageGiB?: number
  /** `--overlay` GiB: persistent rootfs changes (smolvm default 2). */
  readonly overlayGiB?: number
}

const LOCAL_IMAGE_ARCHIVE_SUFFIXES = [".tar", ".tar.gz", ".tgz"]

/**
 * True when `image` is a local OCI/docker `save` archive (a file path ending in
 * .tar/.tar.gz/.tgz) rather than a registry reference. smolvm loads such an
 * archive at start with no network, so the machine boots fully offline — no
 * registry egress is needed (or added). Build one with `docker save IMG -o x.tar`.
 */
export function isLocalImageArchive(image: string): boolean {
  const lower = image.toLowerCase()
  return LOCAL_IMAGE_ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/**
 * `smolvm machine create --name <id> [--image <img>] [--storage N] [--overlay N] [<net>...]`
 *
 * No host volume is mounted: the guest filesystem is fully isolated and files are materialized
 * in-guest via {@link SmolvmSandbox.writeFiles}.
 */
export function buildCreateArgv(
  config: SmolvmCliConfig,
  params: {
    readonly id: string
    /** Network flags from buildNetworkFlags. */
    readonly network: readonly string[]
  }
): string[] {
  const argv = [config.bin, "machine", "create", "--name", params.id]
  if (config.image !== undefined) {
    argv.push("--image", config.image)
  }
  if (config.storageGiB !== undefined) {
    argv.push("--storage", String(config.storageGiB))
  }
  if (config.overlayGiB !== undefined) {
    argv.push("--overlay", String(config.overlayGiB))
  }
  argv.push(...params.network)
  return argv
}

/** `smolvm machine start --name <id>` */
export function buildStartArgv(config: SmolvmCliConfig, id: string): string[] {
  return [config.bin, "machine", "start", "--name", id]
}

/**
 * `smolvm machine exec --name <id> --workdir <cwd> [--env KEY=VAL...] -- <command> [args...]`
 *
 * The bash tool always calls runCommand("bash", ["-lc", script]), so command
 * and args are forwarded verbatim after `--`. Working directory and environment
 * use smolvm's native `--workdir` / `--env` flags.
 */
export function buildExecArgv(
  config: SmolvmCliConfig,
  params: {
    readonly id: string
    readonly cwd: string
    readonly command: string
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
  }
): string[] {
  const argv = [config.bin, "machine", "exec", "--name", params.id, "--workdir", params.cwd]
  for (const [key, value] of Object.entries(params.env)) {
    argv.push("--env", `${key}=${value}`)
  }
  argv.push("--", params.command, ...params.args)
  return argv
}

/** `smolvm machine stop --name <id>` */
export function buildStopArgv(config: SmolvmCliConfig, id: string): string[] {
  return [config.bin, "machine", "stop", "--name", id]
}

/** `smolvm machine delete --name <id> --force` (--force skips the confirmation prompt). */
export function buildRemoveArgv(config: SmolvmCliConfig, id: string): string[] {
  return [config.bin, "machine", "delete", "--name", id, "--force"]
}
