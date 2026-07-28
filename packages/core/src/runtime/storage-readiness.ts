import type { SixbReadiness } from "../maintenance"
import { isMigrationCapableStorage, type Storage } from "../storage"

type SchemaReadiness =
  | { readonly status: "unchecked" | "checking" }
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly reason: string }

/** Caches the process schema invariant while keeping each readiness probe lock-free. */
export class StorageReadiness {
  private schema: SchemaReadiness

  constructor(private readonly storage: Storage) {
    this.schema = isMigrationCapableStorage(storage) ? { status: "unchecked" } : { status: "valid" }
  }

  startSchemaValidation(): void {
    if (this.schema.status !== "unchecked") return
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
        : { status: "invalid", reason: "Storage schema has pending migrations." }
    } catch {
      this.schema = { status: "invalid", reason: "Storage schema could not be verified." }
    }
  }
}
