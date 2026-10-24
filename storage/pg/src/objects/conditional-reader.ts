import type { ObjectQuery } from "@sixb/core"
import { hasVectorProfile } from "@sixb/core/internal/query"
import type {
  CompiledConditionalObjectReadScope,
  ObjectQueryCapabilities,
  ObjectReadStorage,
} from "@sixb/core/storage"
import { type PgStoreClient, runPgRepeatableReadTransaction } from "../transactions"
import type { PgAggregateAdmission } from "./aggregate-admission"
import { compilePgConditionalObjectReadSource } from "./read-scope"
import { PgObjectReader } from "./reader"
import { createPgScopedReader } from "./scoped-reader"

/**
 * Read objects and links through relations that apply the scope's conditions as they are read.
 *
 * Reads run as unscoped ones do, under the same aggregate admission: on the pool, and a vector
 * query on one repeatable-read snapshot for its candidate probe and its rows.
 */
export function createPgConditionalReader(
  sql: PgStoreClient,
  params: {
    projectId: string
    scope: CompiledConditionalObjectReadScope
  },
  options: {
    aggregateAdmission?: PgAggregateAdmission
    queryCapabilities: () => ObjectQueryCapabilities
  }
): ObjectReadStorage {
  const source = compilePgConditionalObjectReadSource(params.projectId, params.scope)
  const reader = new PgObjectReader(sql, source, options.aggregateAdmission)

  return createPgScopedReader(
    {
      projectId: params.projectId,
      read: (run, query?: ObjectQuery) =>
        query && hasVectorProfile(query)
          ? runPgRepeatableReadTransaction(sql, (tx) => run(new PgObjectReader(tx, source)))
          : run(reader),
    },
    options.queryCapabilities
  )
}
