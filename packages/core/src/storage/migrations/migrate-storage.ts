import { applyOntologyMigrations, resumeOntologyMigration, runRenames } from "../../migrations/run"
import {
  isQueryPreparationCapableStorage,
  type ObjectQueryPreparationResult,
  prepareObjectQueries,
} from "../objects/query-preparation"
import type { OntologyMigrationRunRecord } from "../ontology/migrations"
import type { Storage } from "../types"
import {
  checkUniqueProperties,
  clearUniqueProperties,
  madeUnique,
  prepareUniqueProperties,
} from "./prepare-unique-properties"
import {
  checkTypeShapes,
  formatTypeShapeFindings,
  recordTypeShapes,
  type TypeShapeCheck,
  TypeShapeMismatchError,
} from "./type-shapes"
import type {
  MigrationCapableStorage,
  MigrationReport,
  StorageMigrationOptions,
  StorageMigrationResult,
} from "./types"

export function isMigrationCapableStorage(storage: Storage): storage is MigrationCapableStorage {
  return Array.isArray((storage as { migrators?: unknown }).migrators)
}

/**
 * Run schema migrations, then, given the project's ontology and when `ontologyShapes` says so:
 *
 * 1. finish a migration run a crash left open (every mode but `role`: it is past its point of no
 *    return);
 * 2. check the shapes the stored objects fit against the code's;
 * 3. prepare query indexes when the provider supports it;
 * 4. apply the migration steps the check found data for (`deploy`, `dev`), then prepare the
 *    stored values of unique properties, and record the new shapes last ({@link applyTypeShapes}).
 *
 * `check` stops after the query indexes: `sixb check --migrate` calls {@link applyTypeShapes} once
 * its own probes passed.
 */
export async function migrateStorage(
  storage: Storage,
  options?: StorageMigrationOptions
): Promise<StorageMigrationResult> {
  const reports: MigrationReport[] = []
  if (isMigrationCapableStorage(storage)) {
    for (const migrator of storage.migrators) {
      reports.push(await migrator.migrate())
    }
  }

  // After the provider migrators, which create the tables it reads. Before unique preparation:
  // the values of a type whose data the code doesn't fit, rebuilt for the code's shape, would drop
  // what a migration has to move.
  const mode = options?.ontologyShapes
  if (options && mode && mode !== "role") {
    await resumeOntologyMigration({
      storage,
      projectId: options.projectId,
      ...(options.onMigrationRunStarted ? { onStarted: options.onMigrationRunStarted } : {}),
    })
  }

  const shapes = options && mode ? await checkTypeShapes({ storage, ...options, mode }) : undefined
  const unfit = shapes?.types.filter((type) => type.findings.length > 0) ?? []

  if (unfit.length > 0 && mode !== "check") {
    if (mode !== "dev") throw new TypeShapeMismatchError(shapes!)

    console.warn(
      [
        "[Sixb] The stored objects don't fit this code. Their recorded shapes and unique values stay as they were:",
        ...formatTypeShapeFindings(unfit.flatMap((type) => type.findings)),
      ].join("\n")
    )
  }
  for (const objectTypeId of shapes?.unrecorded ?? []) {
    console.info(
      `[Sixb] '${objectTypeId}' has objects and no recorded shape yet: \`sixb db migrate\` records it.`
    )
  }

  // Query indexes only ever add: one for a property the data doesn't hold yet is harmless.
  let queries: ObjectQueryPreparationResult | undefined
  if (options && isQueryPreparationCapableStorage(storage)) {
    queries = await prepareObjectQueries({ ...options, storage })
    for (const warning of queries.warnings) {
      console.warn(`[Sixb] ${warning}`)
    }
  }

  // `check` writes nothing of the shapes or of unique values: `applyTypeShapes` does, once the
  // caller's other checks passed. Without a shapes mode, unique values are prepared as ever.
  let migration: OntologyMigrationRunRecord | null = null
  if (options && shapes && mode !== "check") {
    migration = await applyTypeShapes(storage, options, shapes)
  } else if (options && !shapes) {
    await prepareUniqueProperties({ ...options, storage })
  }

  let status: StorageMigrationResult["status"] = "skipped"
  if (reports.length > 0 || queries) {
    status = "current"
  }
  if (
    reports.some((report) => report.status === "migrated") ||
    queries?.status === "prepared" ||
    migration
  ) {
    status = "migrated"
  }

  return {
    status,
    reports,
    ...(queries ? { queries } : {}),
    ...(shapes ? { shapes } : {}),
  }
}

/**
 * What a deploy writes once every check passed, in an order where nothing written before the
 * point of no return can leave the old release on stale data: a dry run of the unique
 * preparation, so a duplicate fails while nothing is written; the migration run, the point of no
 * return; the unique values, built from what the run left; and the shapes, last. The types whose
 * data the code doesn't fit keep their values, which only `dev` leaves here.
 */
export async function applyTypeShapes(
  storage: Storage,
  options: StorageMigrationOptions,
  shapes: TypeShapeCheck
): Promise<OntologyMigrationRunRecord | null> {
  const unfit = shapes.types.filter((type) => type.findings.length > 0)
  const keepObjectTypeIds = new Set(unfit.map((type) => type.objectTypeId))
  const migrations = options.migrations ?? []
  const rebuild = madeUnique(shapes.types)

  // Everything that can fail runs before the run starts, while the old release can still start
  // again: a preparation left by a failed deploy would be stale under the old release's writes,
  // and trusted by the next deploy. A rename's values are read under its old id, unless the run
  // moves them as they are. A step that computes values plans them here too, before the run,
  // which then applies what it planned.
  const renames = runRenames(shapes, migrations)
  await checkUniqueProperties({ ...options, storage, keepObjectTypeIds, rebuild, renames })

  // A run records the code's shapes as it finishes: a crash before the preparation below leaves
  // them recorded, and the next deploy would trust what a failed one built. Values the recorded
  // shape doesn't keep unique go before the point of no return; the old release never reads them.
  await clearUniqueProperties({
    storage,
    projectId: options.projectId,
    properties: rebuild.filter((property) => !recordedUnique(shapes, property)),
  })

  const migration = await applyOntologyMigrations({
    storage,
    projectId: options.projectId,
    ontology: options.ontology,
    migrations,
    check: shapes,
    ...(options.onMigrationRunStarted ? { onStarted: options.onMigrationRunStarted } : {}),
  })

  // Past the point of no return, or with no run at all: the values a run moved are current, those
  // it dropped are gone, and the others are built from the objects it left. Not part of the status: it only reads and writes
  // rows, and says when it builds values.
  await prepareUniqueProperties({ ...options, storage, keepObjectTypeIds, rebuild })

  // The run dropped the query structures on the keys it removed or renamed: preparation builds
  // what the code needs that went with them.
  if (migration && isQueryPreparationCapableStorage(storage)) {
    await prepareObjectQueries({ ...options, storage })
  }

  await recordTypeShapes(storage, shapes)
  return migration
}

/** Whether the shape the type's stored objects fit already has the property unique. */
function recordedUnique(
  shapes: TypeShapeCheck,
  property: { readonly objectTypeId: string; readonly propertyId: string }
): boolean {
  const type = shapes.types.find((candidate) => candidate.objectTypeId === property.objectTypeId)
  const recorded = type?.stored?.shape ?? type?.baseline
  return recorded?.properties[property.propertyId]?.unique === true
}
