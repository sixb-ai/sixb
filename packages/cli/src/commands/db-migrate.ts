import { migrateStorage } from "@sixb/core"
import { checkTypeShapes } from "@sixb/core/internal/storage"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { findPendingMigrations } from "../lib/storage-migration"
import { dbMigrateCheckView, dbMigrateView, renderStatic, withTask } from "../ui"

/**
 * `--check` exits with this code when `sixb db migrate` would change the schema, or record object
 * shapes the old release would write around. Not 2, which every command uses for a usage error,
 * such as an option an older `sixb` does not know.
 */
const MIGRATIONS_PENDING_EXIT_CODE = 3

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

      // Stored shapes are read once the schema holds them. A pending schema migration stops the
      // services anyway, and `sixb check --migrate` checks the shapes after it.
      const shapes =
        pending.length > 0
          ? undefined
          : await withTask("db migrate", "Checking the stored objects", () =>
              checkTypeShapes({
                storage: sixb.storage,
                projectId: sixb.id,
                ontology: sixb.definitions.ontology,
                mode: "check",
              })
            )
      const findings = shapes?.types.flatMap((type) => type.findings) ?? []

      await renderStatic(
        dbMigrateCheckView({
          projectId: sixb.id,
          pending,
          ...(shapes ? { shapes: { findings, narrows: shapes.narrows } } : {}),
        })
      )

      // A deploy reads the code. Data the new code doesn't fit fails it before anything stops;
      // a schema change or a narrowed type needs the services stopped, so the old release
      // doesn't write what the new shape refuses.
      if (findings.length > 0) process.exitCode = 1
      else if (pending.length > 0 || shapes?.narrows) {
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
        ontologyShapes: "deploy",
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
