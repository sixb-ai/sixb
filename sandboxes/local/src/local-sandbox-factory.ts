import type {
  CreateSandboxOptions,
  Sandbox,
  SandboxFactory,
  SandboxNetworkPolicy,
} from "@sixb/core"
import { SandboxError } from "@sixb/core"
import {
  initializeSandboxEnvironment,
  type ParamsConfig,
  type SandboxConfig,
  sandboxConfig,
  sandboxCreationEnvironment,
} from "@sixb/core/sandboxes"
import type { LocalIsolation } from "./isolation/detect"
import { LocalSandbox } from "./local-sandbox"

export interface LocalSandboxFactoryOptions<TParams extends ParamsConfig = ParamsConfig>
  extends SandboxConfig<TParams> {
  readonly isolation?: LocalIsolation
  readonly readOnlyPaths?: readonly string[]
  readonly readWritePaths?: readonly string[]
  /** Default env merged into every sandbox the factory creates. */
  readonly env?: Readonly<Record<string, string>>
  /** Default timeout, in milliseconds, applied when none is specified. */
  readonly timeout?: number
  /** Default network policy. Overridable per-create. */
  readonly network?: SandboxNetworkPolicy
}

/**
 * Pluggable factory for LocalSandbox. Wire once into createSixb({ sandboxes })
 * and call create(options) for each run.
 */
export class LocalSandboxFactory<const TParams extends ParamsConfig = Record<never, never>>
  implements SandboxFactory<TParams>
{
  readonly configuration: SandboxConfig<TParams>
  constructor(private readonly defaults: LocalSandboxFactoryOptions<TParams> = {}) {
    this.configuration = sandboxConfig<TParams>(defaults)
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const environment = sandboxCreationEnvironment(this.configuration, options)
    if (options.persistence !== undefined) {
      throw new SandboxError("[Sandbox] local does not support persistent sandboxes.")
    }
    const sandbox = await LocalSandbox.create({
      isolation: this.defaults.isolation,
      readOnlyPaths: this.defaults.readOnlyPaths,
      readWritePaths: this.defaults.readWritePaths,
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
}
