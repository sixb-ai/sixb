import type { SixbReadiness } from "../maintenance"
import { isMigrationCapableStorage, type Storage } from "../storage"

const DEFAULT_SCHEMA_RETRY_DELAY_MS = 60_000

type SchemaReadiness =
  | { readonly status: "unchecked" | "checking" }
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly reason: string; readonly retryAt: number }

interface StorageReadinessOptions {
  readonly schemaRetryDelayMs?: number
  readonly now?: () => Date
}

/** Caches the process schema invariant while keeping each readiness probe lock-free. */
export class StorageReadiness {
  private schema: SchemaReadiness
  private readonly schemaRetryDelayMs: number
  private readonly now: () => Date

  constructor(
    private readonly storage: Storage,
    options: StorageReadinessOptions = {}
  ) {
    this.schemaRetryDelayMs = positiveInteger(
      options.schemaRetryDelayMs ?? DEFAULT_SCHEMA_RETRY_DELAY_MS,
      "schemaRetryDelayMs"
    )
    this.now = options.now ?? (() => new Date())
    this.schema = isMigrationCapableStorage(storage) ? { status: "unchecked" } : { status: "valid" }
  }

  startSchemaValidation(): void {
    if (this.schema.status === "checking" || this.schema.status === "valid") return
    if (this.schema.status === "invalid" && this.now().getTime() < this.schema.retryAt) return
    this.schema = { status: "checking" }
    void this.validateSchema()
  }

  async check(): Promise<SixbReadiness> {
    try {
      await this.storage.ping()
    } catch {
      return {
        status: "unready",
        storage: { reachable: false, schemaValid: false },
        reason: "Storage is unreachable.",
      }
    }

    this.startSchemaValidation()
    if (this.schema.status === "valid") {
      return { status: "ready", storage: { reachable: true, schemaValid: true } }
    }

    return {
      status: "unready",
      storage: { reachable: true, schemaValid: false },
      reason:
        this.schema.status === "invalid"
          ? this.schema.reason
          : "Storage schema validation is in progress.",
    }
  }

  private async validateSchema(): Promise<void> {
    if (!isMigrationCapableStorage(this.storage)) {
      this.schema = { status: "valid" }
      return
    }

    try {
      const plans = await Promise.all(this.storage.migrators.map((migrator) => migrator.plan()))
      this.schema = plans.every((plan) => plan.pending.length === 0)
        ? { status: "valid" }
        : this.invalidSchema("Storage schema has pending migrations.")
    } catch {
      this.schema = this.invalidSchema("Storage schema could not be verified.")
    }
  }

  private invalidSchema(reason: string): SchemaReadiness {
    return {
      status: "invalid",
      reason,
      retryAt: this.now().getTime() + this.schemaRetryDelayMs,
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[Sixb] Storage readiness ${name} must be a positive integer.`)
  }
  return value
}
