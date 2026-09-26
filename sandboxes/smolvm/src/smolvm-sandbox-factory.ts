import { existsSync } from "node:fs"
import {
  type CreateSandboxOptions,
  type Sandbox,
  SandboxError,
  type SandboxFactory,
  SandboxIsolationUnavailableError,
  type SandboxNetworkPolicy,
} from "@sixb/core"
import {
  initializeSandboxEnvironment,
  type ParamsConfig,
  type SandboxConfig,
  sandboxConfig,
  sandboxCreationEnvironment,
} from "@sixb/core/sandboxes"
import { isLocalImageArchive, type SmolvmCliConfig } from "./cli"
import { DOCKER_HUB_REGISTRY_HOSTS } from "./network"
import { probeSmolvm, type SmolvmProbe } from "./preflight"
import { SmolvmSandbox } from "./smolvm-sandbox"

export interface SmolvmSandboxFactoryOptions<in out TParams extends ParamsConfig = ParamsConfig>
  extends SandboxConfig<TParams> {
  /**
   * Image the VM boots from: a local `docker save` archive (`.tar`, boots offline), a registry
   * reference (pulled at boot; add its hosts to `registryHosts`), or `null` for a bare machine
   * (built-in busybox rootfs, which cannot run the agent CLI). Agents need Bash, standard file
   * utilities, CA certificates, and Bun 1.3+ or Node 22+ — the Sixb agent image has all of them.
   */
  readonly image: string | null
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
export class SmolvmSandboxFactory<const TParams extends ParamsConfig = Record<never, never>>
  implements SandboxFactory<TParams>
{
  readonly configuration: SandboxConfig<TParams>
  private cli: SmolvmCliConfig | undefined
  private probe: SmolvmProbe | undefined

  constructor(private readonly defaults: SmolvmSandboxFactoryOptions<TParams>) {
    this.configuration = sandboxConfig<TParams>(defaults)
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    if (options.requestCredentials !== undefined) {
      throw new SandboxError("[Sandbox] smolvm does not support secure request credentials.")
    }
    const environment = sandboxCreationEnvironment(this.configuration, options)
    if (options.persistence !== undefined) {
      throw new SandboxError("[Sandbox] smolvm does not support persistent sandboxes.")
    }
    const cli = this.resolveCli()
    this.ensureAvailable(cli)
    this.ensureImage(cli)
    const sandbox = await SmolvmSandbox.create({
      cli,
      registryHosts: this.defaults.registryHosts ?? DOCKER_HUB_REGISTRY_HOSTS,
      timeout: options.timeout ?? this.defaults.timeout,
      network: options.network ?? this.configuration.network,
      env: { ...this.configuration.env, ...options.env },
      workingDirectory: options.workingDirectory,
    })
    try {
      return await initializeSandboxEnvironment(sandbox, environment, options.signal)
    } catch (error) {
      await sandbox.destroy()
      throw error
    }
  }

  private resolveCli(): SmolvmCliConfig {
    if (this.cli === undefined) {
      const image = this.defaults.image ?? undefined
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
      throw new SandboxIsolationUnavailableError(`[Sandbox] ${this.probe.message}`)
    }
  }

  private ensureImage(cli: SmolvmCliConfig): void {
    const image = cli.image
    if (image !== undefined && isLocalImageArchive(image) && !existsSync(image)) {
      throw new SandboxIsolationUnavailableError(
        `[Sandbox] image archive not found at ${image}. Save one with \`docker save <image> -o ${image}\`, or set \`image\` to a registry reference.`
      )
    }
  }
}
