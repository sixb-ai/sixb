import {
  isQueryPreparationCapableStorage,
  type ObjectQueryPreparationResult,
  prepareObjectQueries,
} from "../objects/query-preparation"
import type { Storage } from "../types"
import {
  checkUniqueProperties,
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
 * Run schema migrations, then, given the project's ontology: check the shapes the stored objects
 * fit against the code's when `ontologyShapes` says so, prepare query indexes when the provider
 * supports it, then the stored values of unique properties and the new shapes last
 * ({@link applyTypeShapes}), so nothing that can fail runs after them. `check` stops before the
 * unique values: `sixb check --migrate` applies them once its own probes passed.
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

  // After the provider migrators, which create the table it reads. Before unique preparation:
  // the values of a type whose data the code doesn't fit, rebuilt for the code's shape, would drop
  // what a migration has to move.
  const mode = options?.ontologyShapes
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
  if (options && shapes && mode !== "check") await applyTypeShapes(storage, options, shapes)
  else if (options && !shapes) await prepareUniqueProperties({ ...options, storage })

  let status: StorageMigrationResult["status"] = "skipped"
  if (reports.length > 0 || queries) {
    status = "current"
  }
  if (reports.some((report) => report.status === "migrated") || queries?.status === "prepared") {
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
 * What a deploy writes once every check passed, in an order where nothing written can leave the
 * old release on stale data: a dry run of the unique preparation first, so a duplicate fails
 * while nothing is written; then the unique values; then the shapes, last. The types whose data
 * the code doesn't fit keep their values, which only `dev` leaves here.
 */
export async function applyTypeShapes(
  storage: Storage,
  options: StorageMigrationOptions,
  shapes: TypeShapeCheck
): Promise<void> {
  const unfit = shapes.types.filter((type) => type.findings.length > 0)
  const keepObjectTypeIds = new Set(unfit.map((type) => type.objectTypeId))
  const rebuild = madeUnique(shapes.types)

  // Not part of the status: it only reads and writes rows, and says when it builds values.
  await checkUniqueProperties({ ...options, storage, keepObjectTypeIds, rebuild })
  await prepareUniqueProperties({ ...options, storage, keepObjectTypeIds, rebuild })

  await recordTypeShapes(storage, shapes)
}
