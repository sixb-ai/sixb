import type { Database } from "bun:sqlite"
import type {
  CompiledSelectedObjectReadScope,
  ObjectQueryCapabilities,
  ObjectReadExecutionLimits,
  ObjectReadStorage,
} from "@sixb/core/storage"
import { ObjectReadLimitExceededError, snapshotObjectReadExecutionLimits } from "@sixb/core/storage"
import {
  compileSqliteSelectedObjectReadSource,
  type SqliteSelectedObjectReadSource,
} from "./read-scope"
import { createSqliteScopedReader } from "./scoped-reader"

/** Keep the traversal probe and every terminal statement in the same synchronous snapshot. */
export function createSqliteSelectedReader(
  db: Database,
  params: {
    projectId: string
    scope: CompiledSelectedObjectReadScope
    limits: ObjectReadExecutionLimits
  },
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  const projectId = params.projectId
  const limits = snapshotObjectReadExecutionLimits(params.limits)
  const source = compileSqliteSelectedObjectReadSource(
    projectId,
    params.scope,
    limits.maxTraversalFacts
  )

  return createSqliteScopedReader(
    db,
    {
      projectId,
      source,
      beforeRead: () => assertTraversalBudget(db, source, limits.maxTraversalFacts),
      limits,
    },
    queryCapabilities
  )
}

function assertTraversalBudget(
  db: Database,
  source: SqliteSelectedObjectReadSource,
  maxTraversalFacts: number
): void {
  const row = db.query(source.traversalProbe.sql).get(...source.traversalProbe.args) as {
    total: number | bigint
  }
  if (BigInt(row.total) > BigInt(maxTraversalFacts)) {
    throw new ObjectReadLimitExceededError("traversalFacts", maxTraversalFacts)
  }
}
