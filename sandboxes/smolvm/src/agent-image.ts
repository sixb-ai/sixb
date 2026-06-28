import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * Building and locating the canonical agent image archive.
 *
 * The sandbox boots from a local OCI archive (offline, fast, strict egress). The
 * archive is built once from the Dockerfile shipped with this package and cached
 * for reuse across projects — no registry, no release pipeline, no checksums to
 * maintain. The Dockerfile in git is the single source of truth: edit it and
 * rebuild.
 */

/** Shared cache directory for built agent image archives. */
function agentImageCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
  return join(base, "sixb", "smolvm")
}

/** Canonical agent image archive path (the host-arch build target). */
export function defaultAgentImagePath(): string {
  return join(agentImageCacheDir(), "sixb-agent.tar")
}

/** Filename for an explicitly-targeted build, e.g. `sixb-agent-amd64.tar`. */
export function agentImageName(platform: string): string {
  const arch = platform.includes("/") ? platform.split("/").pop() : platform
  return `sixb-agent-${arch}.tar`
}

/** Map the host's Node arch onto the OCI/Docker arch used in cross-build filenames. */
function hostImageArch(): string {
  switch (process.arch) {
    case "x64":
      return "amd64"
    case "arm64":
      return "arm64"
    default:
      return process.arch
  }
}

/**
 * Cached agent image archives to look for, in preference order: the canonical
 * host build (`sixb-agent.tar`), then the arch-suffixed archive a cross-build
 * writes (`sixb-agent-<arch>.tar`). The latter lets a cross-built archive copied
 * to its target host be found by a default-configured factory without extra config.
 */
export function defaultAgentImageCandidates(): string[] {
  return [defaultAgentImagePath(), join(agentImageCacheDir(), agentImageName(hostImageArch()))]
}

/** Absolute path to the canonical agent Dockerfile shipped with this package. */
export function agentDockerfilePath(): string {
  return resolve(import.meta.dir, "..", "agent-image", "Dockerfile")
}

export interface BuildAgentImageOptions {
  /** Where to write the archive. Defaults to the host-arch shared cache path. */
  readonly output?: string
  /**
   * Target platform, e.g. "linux/amd64". Omit to build for the host. Set this to
   * cross-build for a different host (e.g. an x86_64 droplet from an arm64 Mac);
   * the default `output` then becomes `sixb-agent-<arch>.tar` to avoid clobbering
   * the host-arch build.
   */
  readonly platform?: string
  /** Container builder to use. Auto-detected (docker, then podman) if omitted. */
  readonly builder?: string
  /** Image tag used during the build. */
  readonly tag?: string
}

/**
 * Build the agent image archive with Docker/Podman. Returns the output path.
 * Requires a builder on PATH — this is the one-time setup step; every run after
 * reads the cached archive offline. The droplet/host that runs it needs only
 * smolvm + this file, never a builder.
 */
export async function buildAgentImage(options: BuildAgentImageOptions = {}): Promise<string> {
  const output =
    options.output ??
    (options.platform
      ? join(dirname(defaultAgentImagePath()), agentImageName(options.platform))
      : defaultAgentImagePath())
  const builder = options.builder ?? detectBuilder()
  const tag = options.tag ?? "sixb-agent"

  if (!builder) {
    throw new Error(
      "[Sandbox] Building the agent image requires Docker or Podman on PATH. Install one, or point `image` at a prebuilt .tar / registry reference."
    )
  }

  const dockerfile = agentDockerfilePath()
  const platformArgs = options.platform ? ["--platform", options.platform] : []
  await mkdir(dirname(output), { recursive: true })
  await run([builder, "build", ...platformArgs, "-t", tag, "-f", dockerfile, dirname(dockerfile)])
  await run([builder, "save", tag, "-o", output])
  return output
}

function detectBuilder(): string | undefined {
  if (Bun.which("docker")) return "docker"
  if (Bun.which("podman")) return "podman"
  return undefined
}

async function run(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`[Sandbox] \`${argv[0]} ${argv[1]}\` failed (exit ${code})`)
  }
}
