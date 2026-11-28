import { randomUUID } from "node:crypto"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import { createKernelScope } from "../execution/scopes"
import { sha256Canonical } from "../materialization/identity"
import { createRuntimeIdempotencyKey } from "../materializer/shared/identity"
import { vectorConfiguration } from "../objects/vectors/profile"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { sameShape } from "../ontology/type-shapes"
import type { ObjectVectorSearchProfile } from "../ontology/types"
import { uniquePropertiesOf } from "../ontology/unique-values"
import { computeOntologyRevision } from "../projections/revision"
import {
  type PendingUniqueRename,
  uniqueValuesMove,
} from "../storage/migrations/prepare-unique-properties"
import type { TypeShapeCheck } from "../storage/migrations/type-shapes"
import type { OntologyCommitRecord } from "../storage/ontology/commits"
import {
  migrationRunTotals,
  type OntologyMigrationLaneRecord,
  type OntologyMigrationRunPlan,
  type OntologyMigrationRunRecord,
  type OntologyMigrationStorage,
  type OntologyMigrationVectorMove,
} from "../storage/ontology/migrations"
import type { PreparedUniqueProperty } from "../storage/ontology/unique-values"
import type { Storage } from "../storage/types"
import { stepKindOf } from "./steps"
import type { MigrationDefinition } from "./types"

/**
 * Objects and edits, or source roots, per batch: each batch is one transaction. Measured on
 * PostgreSQL, 8 CPUs, 1M objects (`.local/bench/ontology-migrations-run`): 1k rows 7.2 s, 5k 6.0 s,
 * 10k 5.8 s, 25k 6.3 s, 50k 6.5 s; larger batches hold their locks and WAL longer for nothing.
 */
export const MIGRATION_BATCH_ROWS = 10_000

/**
 * Applies the migration steps `check` planned, once every check that can fail has passed: the
 * point of no return is `startRun`. From there the run only goes forward, lane by lane, each batch
 * saving where its lane's next one starts; a crash resumes from there with
 * {@link resumeOntologyMigration}. Returns the applied run, or `null` when `check` plans nothing.
 */
export async function applyOntologyMigrations(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly ontology: OntologyDefinitionCatalog
  readonly migrations: readonly MigrationDefinition[]
  readonly check: TypeShapeCheck
  readonly batchRows?: number
  /** Called once the run is past its point of no return, before its first batch. */
  readonly onStarted?: (runId: string) => Promise<void> | void
}): Promise<OntologyMigrationRunRecord | null> {
  const { storage, projectId, check } = input
  const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId })
  const plan = runPlan({ ...input, prepared })
  if (!plan) return null

  const migrations = migrationStorage(storage)
  const runId = `migration_${randomUUID()}`

  // The shapes the check read are still the stored ones, or another deploy moved them; then the
  // run's execution and the run itself, in one transaction.
  const run = await storage.transaction(async (tx) => {
    await tx.ontology.typeShapes.lock({ projectId })
    const current = new Map(
      (await tx.ontology.typeShapes.list({ projectId })).map((row) => [row.objectTypeId, row])
    )

    for (const type of check.types) {
      if (!plan.types.some((planned) => planned.objectTypeId === type.objectTypeId)) continue
      if (sameShape(current.get(type.objectTypeId)?.shape ?? null, type.stored?.shape ?? null)) {
        continue
      }
      throw new Error(
        `[Sixb] The stored shape of '${type.objectTypeId}' changed while it was being checked. ` +
          "Run the command again."
      )
    }

    const executionId = await createRunExecution(tx, projectId, runId)
    return migrationStorage(tx).startRun({
      projectId,
      id: runId,
      executionId,
      startedAt: new Date().toISOString(),
      plan,
      parts: migrations.parallelism,
    })
  })

  console.info(
    `[Sixb] Applying migrations to ${plan.types.map((type) => type.objectTypeId).join(", ")} ` +
      `(run ${runId}). The deploy only goes forward from here: if it stops, ` +
      "`sixb db migrate` finishes it."
  )
  await input.onStarted?.(run.id)
  return finish(migrations, run, input.batchRows)
}

/**
 * Finishes the run a crash or a failure left open, from its stored plan and lanes: the code that
 * resumes it may be another release's. Returns the applied run, or `null` when none is open.
 */
export async function resumeOntologyMigration(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly batchRows?: number
  /** Called before the first batch the resume applies. */
  readonly onStarted?: (runId: string) => Promise<void> | void
}): Promise<OntologyMigrationRunRecord | null> {
  const migrations = input.storage.ontology.migrations
  if (!migrations) return null

  const open = await migrations.getOpenRun({ projectId: input.projectId })
  if (!open) return null

  const left = open.lanes.filter((lane) => lane.cursor !== null).length
  console.info(
    `[Sixb] Resuming migration run ${open.id} from its stored plan: ${left} of ` +
      `${open.lanes.length} lanes left.`
  )
  await input.onStarted?.(open.id)
  return finish(migrations, open, input.batchRows)
}

/**
 * Applies every lane left, `parallelism` of them side by side in the order `startRun` laid them
 * out, then finishes the run. A failure stops every lane at its next batch; every lane's error is
 * reported.
 */
async function finish(
  migrations: OntologyMigrationStorage,
  run: OntologyMigrationRunRecord,
  batchRows = MIGRATION_BATCH_ROWS
): Promise<OntologyMigrationRunRecord> {
  const queue = run.lanes.filter((lane) => lane.cursor !== null)
  const errors: unknown[] = []
  let applied = 0

  const worker = async () => {
    for (let lane = queue.shift(); lane && errors.length === 0; lane = queue.shift()) {
      while (lane.cursor !== null && errors.length === 0) {
        try {
          lane = await migrations.applyBatch({
            projectId: run.projectId,
            runId: run.id,
            ordinal: lane.ordinal,
            batches: lane.batches,
            commit: batchCommit(run, lane),
            batchRows,
          })
          applied += 1
        } catch (error) {
          errors.push(error)
          break
        }
      }
    }
  }
  const width = Math.max(1, Math.min(migrations.parallelism, queue.length))
  await Promise.all(Array.from({ length: width }, worker))

  if (errors.length > 0) {
    const reasons = errors.map((error) => (error instanceof Error ? error.message : String(error)))
    throw new AggregateError(
      errors,
      `[Sixb] Migration run ${run.id} stopped after ${applied} more batches:\n` +
        `${[...new Set(reasons)].map((reason) => `  ${reason}`).join("\n")}\n` +
        "Nothing of a batch in flight was written. Run `sixb db migrate` to resume it."
    )
  }

  const finished = await migrations.finishRun({
    projectId: run.projectId,
    runId: run.id,
    appliedAt: new Date().toISOString(),
  })
  const { batches, counts } = migrationRunTotals(finished)
  console.info(
    `[Sixb] Migration run ${run.id} applied in ${batches === 1 ? "1 batch" : `${batches} batches`}: ` +
      `${counts.objects} objects, ${counts.edits} edits and ${counts.sources} source rows rewritten.`
  )
  return finished
}

/** The renames `check` runs, per type: their unique values are the run's to move or drop. */
export function runRenames(
  check: Pick<TypeShapeCheck, "types">,
  migrations: readonly MigrationDefinition[]
): PendingUniqueRename[] {
  const byId = new Map(migrations.map((migration) => [migration.id, migration]))

  return check.types.flatMap((type) =>
    type.run.flatMap(({ migrationId, index }) => {
      const step = byId.get(migrationId)?.steps[index]
      if (step?.kind !== "renameProperty") return []

      const fromShape = type.stored?.shape ?? type.baseline
      const fromUnique = fromShape?.properties[step.from]?.unique === true
      return [{ objectTypeId: type.objectTypeId, from: step.from, to: step.to, fromUnique }]
    })
  )
}

/** What the run applies: the types `check` found steps to run for, and nothing else it found. */
function runPlan(input: {
  readonly ontology: OntologyDefinitionCatalog
  readonly migrations: readonly MigrationDefinition[]
  readonly check: TypeShapeCheck
  readonly prepared: readonly PreparedUniqueProperty[]
}): OntologyMigrationRunPlan | null {
  const { ontology, check, prepared } = input
  const byId = new Map(input.migrations.map((migration) => [migration.id, migration]))
  const renames = runRenames(check, input.migrations)
  const valueTypes = ontology.getValueTypesById()

  const types = check.types.flatMap((type) => {
    if (type.run.length === 0 || type.findings.length > 0 || type.next.kind !== "write") return []

    const fromShape = type.stored?.shape ?? type.baseline
    if (!fromShape) return []

    const { objectTypeId } = type
    const objectType = ontology.getObjectTypeById(objectTypeId)!
    const unique = new Map(
      uniquePropertiesOf(objectType, valueTypes).map((property) => [
        property.propertyId,
        property.kind,
      ])
    )
    const uniqueMoves = new Set(
      renames
        .filter((rename) => rename.objectTypeId === objectTypeId)
        .filter((rename) => uniqueValuesMove(prepared, rename, unique.get(rename.to)))
        .map((rename) => rename.from)
    )

    const steps = type.run.map(({ migrationId, index }) => {
      const step = byId.get(migrationId)?.steps[index]
      const storeStep = step && stepKindOf(step).storeStep
      if (!step || !storeStep) {
        throw new Error(
          `[Sixb] This build can't apply step ${index} of migration '${migrationId}'.`
        )
      }
      return { ...storeStep(step, { uniqueMoves }), migrationId }
    })

    const vectors = vectorMoves(
      objectType.search?.vectors ?? {},
      renames.filter((rename) => rename.objectTypeId === objectTypeId)
    )
    return [
      {
        objectTypeId,
        fromShape,
        toShape: type.next.shape,
        steps,
        ...(vectors.length > 0 ? { vectors } : {}),
      },
    ]
  })
  if (types.length === 0) return null

  const ids = [...new Set(types.flatMap((type) => type.steps.map((step) => step.migrationId)))]

  return {
    ontologyRevision: computeOntologyRevision(ontology),
    migrations: ids.sort().map((id) => ({ id, hash: migrationHash(byId.get(id)!) })),
    types,
  }
}

/**
 * The code's vector profiles whose source names a renamed property. Their stored vectors were
 * built with the same profile under the old keys, so they keep their embedding; one built with
 * another model or source has another configuration, and goes like a removed key's.
 */
function vectorMoves(
  profiles: Readonly<Record<string, ObjectVectorSearchProfile>>,
  renames: readonly PendingUniqueRename[]
): OntologyMigrationVectorMove[] {
  return Object.entries(profiles).flatMap(([profile, definition]) => {
    const toSource = [...definition.source]
    const fromSource = toSource.map((id) => renames.find((rename) => rename.to === id)?.from ?? id)
    if (fromSource.every((id, index) => id === toSource[index])) return []

    return [
      {
        profile,
        fromConfiguration: vectorConfiguration({ ...definition, source: fromSource }),
        toConfiguration: vectorConfiguration(definition),
        fromSource,
        toSource,
      },
    ]
  })
}

/**
 * The commit of a lane's next batch: a runtime origin under the run's kernel execution, timed at
 * the run's start, and listing no change, as a snapshot's base commit does. Its identity comes
 * from (run, lane, batch), so two processes can't both commit one batch.
 */
function batchCommit(
  run: OntologyMigrationRunRecord,
  lane: OntologyMigrationLaneRecord
): OntologyCommitRecord {
  const requestId = `${run.id}:${lane.ordinal}:${lane.batches}`
  const id = `${run.id}_${lane.ordinal}_${lane.batches}`

  return {
    projectId: run.projectId,
    id,
    idempotencyKey: createRuntimeIdempotencyKey(requestId),
    requestHash: sha256Canonical({ run: run.id, lane: lane.ordinal, batch: lane.batches }),
    executionId: run.executionId,
    origin: { kind: "runtime", requestId },
    ontologyRevision: run.plan.ontologyRevision,
    committedAt: run.startedAt,
    intent: { kind: "edit", mode: "atomic", operationCount: 0 },
    result: {
      kind: "edit",
      commitId: id,
      created: true,
      eventCount: 0,
      committedAt: run.startedAt,
      outcomes: [],
      changes: { objects: [], links: [] },
    },
  }
}

/** The run's execution, the kernel operation `ontology.migrate`, which every batch commit cites. */
async function createRunExecution(
  storage: Storage,
  projectId: string,
  runId: string
): Promise<string> {
  const scope = createKernelScope({
    projectId,
    operation: { type: "ontology.migrate", runId },
    source: { type: "http", requestId: runId },
    correlationId: runId,
  })

  await ensureExecutionRecord(storage.executions, {
    ...executionRecordInputFromRuntime({
      execution: scope.execution,
      runtimeAuthorization: scope.authorization,
    }),
    requesterGroupIds: [],
  })
  return scope.execution.id
}

/** For history only: a function counts by its source. */
function migrationHash(migration: MigrationDefinition): string {
  const steps = migration.steps.map((step) =>
    Object.fromEntries(
      Object.entries(step).map(([key, value]) => [
        key,
        typeof value === "function" ? value.toString() : value,
      ])
    )
  )
  return sha256Canonical({ id: migration.id, objectTypeId: migration.objectTypeId, steps })
}

function migrationStorage(storage: Storage): OntologyMigrationStorage {
  if (storage.ontology.migrations) return storage.ontology.migrations

  throw new Error(
    "[Sixb] This storage provider cannot apply ontology migrations. Use PostgreSQL, SQLite or " +
      "in-memory storage."
  )
}
