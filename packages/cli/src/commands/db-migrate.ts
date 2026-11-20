import { migrateStorage } from "@sixb/core"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { findPendingMigrations } from "../lib/storage-migration"
import { dbMigrateCheckView, dbMigrateView, renderStatic, withTask } from "../ui"

/**
 * `--check` exits with this code when `sixb db migrate` would change the schema. Not 2, which
 * every command uses for a usage error, such as an option an older `sixb` does not know.
 */
const MIGRATIONS_PENDING_EXIT_CODE = 3
/** …and with this one when a pending migration breaks the release before it. */
const INCOMPATIBLE_MIGRATIONS_EXIT_CODE = 4

export interface DbMigrateOptions {
  entry?: string
  /** Only report whether migrations are pending, without running them. */
  check?: boolean
}

export async function runDbMigrate(options: DbMigrateOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await withTask("db migrate", "Loading project", () => loadSixbFromEntry(entry))

  if (options.check) {
    try {
      const pending = await withTask("db migrate", "Reading the storage schema", () =>
        findPendingMigrations(sixb.storage)
      )
      await renderStatic(dbMigrateCheckView({ projectId: sixb.id, pending }))

      // A deploy reads the code: only an incompatible migration needs the services stopped.
      if (pending.some((status) => status.state !== "current" && status.incompatible)) {
        process.exitCode = INCOMPATIBLE_MIGRATIONS_EXIT_CODE
      } else if (pending.length > 0) {
        process.exitCode = MIGRATIONS_PENDING_EXIT_CODE
      }
    } finally {
      await stopSixbProviders(sixb)
    }
    return
  }

  try {
    const result = await withTask("db migrate", "Migrating storage", () =>
      migrateStorage(sixb.storage, {
        projectId: sixb.id,
        ontology: sixb.definitions.ontology,
        security: sixb.definitions.security,
      })
    )
    await renderStatic(
      dbMigrateView({
        projectId: sixb.id,
        status: result.status,
        applied: result.reports.flatMap((report) => report.applied),
      })
    )
  } finally {
    await stopSixbProviders(sixb)
  }
}
