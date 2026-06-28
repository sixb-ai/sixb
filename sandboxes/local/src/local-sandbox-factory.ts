import type {
  CreateSandboxOptions,
  Sandbox,
  SandboxFactory,
  SandboxNetworkPolicy,
} from "@sixb/core"
import type { LocalIsolation } from "./isolation/detect"
import { LocalSandbox } from "./local-sandbox"

export interface LocalSandboxFactoryOptions {
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
export class LocalSandboxFactory implements SandboxFactory {
  constructor(private readonly defaults: LocalSandboxFactoryOptions = {}) {}

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    return await LocalSandbox.create({
      isolation: this.defaults.isolation,
      readOnlyPaths: this.defaults.readOnlyPaths,
      readWritePaths: this.defaults.readWritePaths,
      timeout: options.timeout ?? this.defaults.timeout,
      network: options.network ?? this.defaults.network,
      env: { ...(this.defaults.env ?? {}), ...(options.env ?? {}) },
      workingDirectory: options.workingDirectory,
    })
  }
}
