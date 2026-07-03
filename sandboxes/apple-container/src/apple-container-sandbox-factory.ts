import type {
  CreateSandboxOptions,
  Sandbox,
  SandboxFactory,
  SandboxNetworkPolicy,
} from "@sixb/core"
import { SandboxIsolationUnavailableError } from "@sixb/core"
import { AppleContainerSandbox } from "./apple-container-sandbox"
import {
  type AppleContainerCliConfig,
  type AppleContainerMount,
  normalizeDnsServers,
  normalizeMounts,
  normalizePorts,
} from "./cli"
import { type AppleContainerProbe, probeAppleContainer } from "./preflight"

export interface AppleContainerSandboxFactoryOptions {
  /** OCI image used for each sandbox. Must include bash and curl for Sixb agents. */
  readonly image?: string
  /** Apple Container CLI binary name or absolute path. Defaults to "container". */
  readonly bin?: string
  readonly cpus?: number | string
  readonly memory?: string
  readonly platform?: string
  readonly arch?: string
  readonly os?: string
  readonly rosetta?: boolean
  readonly readOnlyRootfs?: boolean
  readonly mounts?: readonly AppleContainerMount[]
  readonly ports?: readonly number[]
  /** DNS servers passed to `container create --dns`. Useful when Apple Container's DNS proxy hangs. */
  readonly dns?: readonly string[]
  /** Extra `container create` args passed before the image name. */
  readonly createArgs?: readonly string[]
  /** Network attached for mode=all and downgraded mode=restricted. Defaults to "default". */
  readonly defaultNetworkName?: string
  /** Prefix for per-sandbox internal networks used by mode=none. */
  readonly internalNetworkPrefix?: string
  /** Timeout for provider bootstrap/cleanup commands, in milliseconds. */
  readonly setupTimeoutMs?: number
  /** Seconds passed to `container stop --time`. */
  readonly stopTimeoutSeconds?: number
  /** Default env merged into every sandbox the factory creates. */
  readonly env?: Readonly<Record<string, string>>
  /** Default per-command timeout, in milliseconds, applied when none is specified. */
  readonly timeout?: number
  /** Default network policy. Overridable per-create. */
  readonly network?: SandboxNetworkPolicy
}

export const DEFAULT_APPLE_CONTAINER_IMAGE = "node:22-bookworm"
const DEFAULT_BIN = "container"

/**
 * Pluggable factory for Apple Container-backed Sixb sandboxes. Host availability is probed once,
 * lazily, on first create.
 */
export class AppleContainerSandboxFactory implements SandboxFactory {
  private cli: AppleContainerCliConfig | undefined
  private probe: AppleContainerProbe | undefined

  constructor(private readonly defaults: AppleContainerSandboxFactoryOptions = {}) {}

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const cli = this.resolveCli()
    this.ensureAvailable(cli)
    return await AppleContainerSandbox.create({
      cli,
      defaultNetworkName: this.defaults.defaultNetworkName,
      internalNetworkPrefix: this.defaults.internalNetworkPrefix,
      setupTimeoutMs: this.defaults.setupTimeoutMs,
      timeout: options.timeout ?? this.defaults.timeout,
      network: options.network ?? this.defaults.network,
      env: { ...(this.defaults.env ?? {}), ...(options.env ?? {}) },
      workingDirectory: options.workingDirectory,
    })
  }

  private resolveCli(): AppleContainerCliConfig {
    if (this.cli === undefined) {
      this.cli = {
        bin: this.defaults.bin ?? DEFAULT_BIN,
        image: this.defaults.image ?? DEFAULT_APPLE_CONTAINER_IMAGE,
        ...(this.defaults.cpus !== undefined ? { cpus: String(this.defaults.cpus) } : {}),
        ...(this.defaults.memory !== undefined ? { memory: this.defaults.memory } : {}),
        ...(this.defaults.platform !== undefined ? { platform: this.defaults.platform } : {}),
        ...(this.defaults.arch !== undefined ? { arch: this.defaults.arch } : {}),
        ...(this.defaults.os !== undefined ? { os: this.defaults.os } : {}),
        ...(this.defaults.rosetta !== undefined ? { rosetta: this.defaults.rosetta } : {}),
        ...(this.defaults.readOnlyRootfs !== undefined
          ? { readOnlyRootfs: this.defaults.readOnlyRootfs }
          : {}),
        mounts: normalizeMounts(this.defaults.mounts ?? []),
        ports: normalizePorts(this.defaults.ports ?? []),
        dns: normalizeDnsServers(this.defaults.dns ?? []),
        createArgs: this.defaults.createArgs ?? [],
        ...(this.defaults.stopTimeoutSeconds !== undefined
          ? { stopTimeoutSeconds: this.defaults.stopTimeoutSeconds }
          : {}),
      }
    }
    return this.cli
  }

  private ensureAvailable(cli: AppleContainerCliConfig): void {
    if (this.probe === undefined) {
      this.probe = probeAppleContainer(cli.bin)
    }
    if (!this.probe.ok) {
      throw new SandboxIsolationUnavailableError(`[Sandbox] ${this.probe.message}`)
    }
  }
}
