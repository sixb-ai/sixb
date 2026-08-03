import { existsSync } from "node:fs"
import type {
  CreateSandboxOptions,
  Sandbox,
  SandboxFactory,
  SandboxNetworkPolicy,
} from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import { defaultAgentImageCandidates, defaultAgentImagePath } from "./agent-image"
import { isLocalImageArchive, type SmolvmCliConfig } from "./cli"
import { DOCKER_HUB_REGISTRY_HOSTS } from "./network"
import { probeSmolvm, type SmolvmProbe } from "./preflight"
import { SmolvmSandbox } from "./smolvm-sandbox"

export interface SmolvmSandboxFactoryOptions {
  /**
   * Image the VM boots from. Defaults to the managed agent archive built by
   * `bun run agent:image` (offline, fast, strict egress); a cross-built
   * `sixb-agent-<arch>.tar` in the cache is picked up automatically. Set a
   * different local `.tar` path, or a registry reference (e.g. `node:22`) to pull
   * at boot. Pass `null` for a bare machine (built-in busybox rootfs, fully
   * offline, no image).
   */
  readonly image?: string | null
  /** smolvm binary name or absolute path. Defaults to "smolvm" (resolved on PATH). */
  readonly bin?: string
  /** `--storage` GiB: OCI layers + container data (smolvm default 20). */
  readonly storageGiB?: number
  /** `--overlay` GiB: persistent rootfs changes (smolvm default 2). Raise to avoid "no space left". */
  readonly overlayGiB?: number
  /**
   * Registry hosts added to a restricted network policy so an image machine can
   * pull at start. Defaults to Docker Hub. Set this for other registries (e.g.
   * `["ghcr.io", "pkg-containers.githubusercontent.com"]`). Unused for bare
   * machines (no `image`).
   */
  readonly registryHosts?: readonly string[]
  /** Default env merged into every sandbox the factory creates. */
  readonly env?: Readonly<Record<string, string>>
  /** Default per-command timeout, in milliseconds, applied when none is specified. */
  readonly timeout?: number
  /** Default network policy. Overridable per-create. */
  readonly network?: SandboxNetworkPolicy
}

const DEFAULT_BIN = "smolvm"

/**
 * Pluggable factory for SmolvmSandbox. Wire once into createSixb({ sandboxes })
 * and call create(options) for each run. Host availability is probed once,
 * lazily, on the first create.
 */
export class SmolvmSandboxFactory implements SandboxFactory {
  private cli: SmolvmCliConfig | undefined
  private probe: SmolvmProbe | undefined

  constructor(private readonly defaults: SmolvmSandboxFactoryOptions = {}) {}

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const cli = this.resolveCli()
    this.ensureAvailable(cli)
    this.ensureImage(cli)
    return await SmolvmSandbox.create({
      cli,
      registryHosts: this.defaults.registryHosts ?? DOCKER_HUB_REGISTRY_HOSTS,
      timeout: options.timeout ?? this.defaults.timeout,
      network: options.network ?? this.defaults.network,
      env: { ...(this.defaults.env ?? {}), ...(options.env ?? {}) },
      workingDirectory: options.workingDirectory,
    })
  }

  /** Resolve the smolvm CLI config once, picking the default image archive lazily. */
  private resolveCli(): SmolvmCliConfig {
    if (this.cli === undefined) {
      const image = resolveImage(this.defaults.image)
      this.cli = {
        bin: this.defaults.bin ?? DEFAULT_BIN,
        ...(image !== undefined ? { image } : {}),
        ...(this.defaults.storageGiB !== undefined ? { storageGiB: this.defaults.storageGiB } : {}),
        ...(this.defaults.overlayGiB !== undefined ? { overlayGiB: this.defaults.overlayGiB } : {}),
      }
    }
    return this.cli
  }

  private ensureAvailable(cli: SmolvmCliConfig): void {
    if (this.probe === undefined) {
      this.probe = probeSmolvm(cli.bin)
    }
    if (!this.probe.ok) {
      throw new SixbError("sandbox.isolation_unavailable", `[Sandbox] ${this.probe.message}`)
    }
  }

  private ensureImage(cli: SmolvmCliConfig): void {
    const image = cli.image
    if (image !== undefined && isLocalImageArchive(image) && !existsSync(image)) {
      throw new SixbError(
        "sandbox.isolation_unavailable",
        `[Sandbox] agent image not found at ${image}. Build it once with \`bun run agent:image\` (requires Docker or Podman), or set \`image\` to a prebuilt .tar or a registry reference.`
      )
    }
  }
}

/**
 * Resolve the configured image option into a CLI image:
 * - `undefined` -> the managed agent archive (prefers an existing `sixb-agent.tar`,
 *   else a cross-built `sixb-agent-<arch>.tar`; falls back to the canonical path).
 * - `null`      -> bare machine (no image; built-in busybox rootfs, fully offline).
 * - string      -> used as-is (a local `.tar` path or a registry reference).
 */
function resolveImage(image: string | null | undefined): string | undefined {
  if (image === null) {
    return undefined
  }
  if (image !== undefined) {
    return image
  }
  return defaultAgentImageCandidates().find((path) => existsSync(path)) ?? defaultAgentImagePath()
}
