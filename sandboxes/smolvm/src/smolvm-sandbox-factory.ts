import { existsSync } from "node:fs"
import {
  type CreateSandboxOptions,
  type Sandbox,
  type SandboxFactory,
  SandboxIsolationUnavailableError,
  type SandboxNetworkPolicy,
} from "@sixb/core"
import { defaultAgentImagePath } from "./agent-image"
import { isLocalImageArchive, type SmolvmCliConfig } from "./cli"
import { DOCKER_HUB_REGISTRY_HOSTS } from "./network"
import { probeSmolvm, type SmolvmProbe } from "./preflight"
import { SmolvmSandbox } from "./smolvm-sandbox"

export interface SmolvmSandboxFactoryOptions {
  /**
   * Image the VM boots from. Defaults to the managed agent archive built by
   * `bun run agent:image` (offline, fast, strict egress). Set a different local
   * `.tar` path, or a registry reference (e.g. `node:22`) to pull at boot.
   */
  readonly image?: string
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
  private readonly cli: SmolvmCliConfig
  private probe: SmolvmProbe | undefined

  constructor(private readonly defaults: SmolvmSandboxFactoryOptions = {}) {
    this.cli = {
      bin: defaults.bin ?? DEFAULT_BIN,
      image: defaults.image ?? defaultAgentImagePath(),
      ...(defaults.storageGiB !== undefined ? { storageGiB: defaults.storageGiB } : {}),
      ...(defaults.overlayGiB !== undefined ? { overlayGiB: defaults.overlayGiB } : {}),
    }
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.ensureAvailable()
    this.ensureImage()
    return await SmolvmSandbox.create({
      cli: this.cli,
      registryHosts: this.defaults.registryHosts ?? DOCKER_HUB_REGISTRY_HOSTS,
      timeout: options.timeout ?? this.defaults.timeout,
      network: options.network ?? this.defaults.network,
      env: { ...(this.defaults.env ?? {}), ...(options.env ?? {}) },
      workingDirectory: options.workingDirectory,
    })
  }

  private ensureAvailable(): void {
    if (this.probe === undefined) {
      this.probe = probeSmolvm(this.cli.bin)
    }
    if (!this.probe.ok) {
      throw new SandboxIsolationUnavailableError(`[Sandbox] ${this.probe.message}`)
    }
  }

  private ensureImage(): void {
    const image = this.cli.image
    if (image !== undefined && isLocalImageArchive(image) && !existsSync(image)) {
      throw new SandboxIsolationUnavailableError(
        `[Sandbox] agent image not found at ${image}. Build it once with \`bun run agent:image\` (requires Docker or Podman), or set \`image\` to a prebuilt .tar or a registry reference.`
      )
    }
  }
}
