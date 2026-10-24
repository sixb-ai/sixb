import type {
  CompiledSelectedObjectReadScope,
  ObjectQueryCapabilities,
  ObjectReadExecutionLimits,
  ObjectReadStorage,
} from "@sixb/core/storage"
import { ObjectReadLimitExceededError, snapshotObjectReadExecutionLimits } from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "../pg-client"
import { type PgStoreClient, runPgRepeatableReadTransaction } from "../transactions"
import { compilePgSelectedObjectReadSource, type PgSelectedObjectReadSource } from "./read-scope"
import { PgObjectReader } from "./reader"
import { createPgScopedReader } from "./scoped-reader"

/** Keep the traversal probe and every terminal statement on one repeatable-read snapshot. */
export function createPgSelectedReader(
  sql: PgStoreClient,
  params: {
    projectId: string
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  },
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  const projectId = params.projectId
  const limits = snapshotObjectReadExecutionLimits(params.limits)
  const source = compilePgSelectedObjectReadSource(
    projectId,
    params.scope,
    limits.maxTraversalFacts
  )

  return createPgScopedReader(
    {
      projectId,
      read: (run) =>
        runPgRepeatableReadTransaction(sql, async (tx) => {
          await assertTraversalBudget(tx, source, limits.maxTraversalFacts)
          return run(new PgObjectReader(tx, source))
        }),
      limits,
    },
    queryCapabilities
  )
}

async function assertTraversalBudget(
  sql: SQLClient,
  source: PgSelectedObjectReadSource,
  maxTraversalFacts: number
): Promise<void> {
  const [row] = await sql.unsafe<{ total: string | number | bigint }[]>(
    source.traversalProbe.sql,
    source.traversalProbe.args as SqlParameter[]
  )
  if (BigInt(row?.total ?? 0) > BigInt(maxTraversalFacts)) {
    throw new ObjectReadLimitExceededError("traversalFacts", maxTraversalFacts)
  }
}
