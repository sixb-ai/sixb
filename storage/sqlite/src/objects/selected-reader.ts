import type { Database } from "bun:sqlite"
import type {
  CompiledSelectedObjectReadScope,
  ObjectQueryCapabilities,
  ObjectReadExecutionLimits,
  ObjectReadStorage,
} from "@sixb/core/storage"
import {
  assertObjectReaderProject,
  assertObjectReadFacetCount,
  assertObjectReadOutputWithinLimit,
  ObjectReadLimitExceededError,
  snapshotObjectReadExecutionLimits,
} from "@sixb/core/storage"
import { runDeferredReadTransaction } from "../transactions"
import {
  compileSqliteSelectedObjectReadSource,
  type SqliteSelectedObjectReadSource,
} from "./read-scope"
import { assertLinkQueryLimit, SqliteObjectReader } from "./reader"

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
  const reader = new SqliteObjectReader(db, source)
  const assertProject = (actualProjectId: string): void =>
    assertObjectReaderProject(projectId, actualProjectId)
  const read = <T>(run: () => T): T =>
    runDeferredReadTransaction(db, () => {
      assertTraversalBudget(db, source, limits.maxTraversalFacts)
      const value = run()
      assertObjectReadOutputWithinLimit(value, limits)
      return value
    })
  const readMap = <TKey, TValue>(run: () => Map<TKey, TValue>): Map<TKey, TValue> =>
    runDeferredReadTransaction(db, () => {
      assertTraversalBudget(db, source, limits.maxTraversalFacts)
      const value = run()
      assertObjectReadOutputWithinLimit([...value.entries()], limits)
      return value
    })

  return Object.freeze({
    queryCapabilities,
    queryObjects: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.queryObjects(input))
    },
    countObjects: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.countObjects(input))
    },
    existsObjects: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.existsObjects(input))
    },
    facetObjects: async (input) => {
      assertProject(input.projectId)
      assertObjectReadFacetCount(input.facets.length)
      return read(() => reader.facetObjects(input))
    },
    getByPrimaryId: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.getByPrimaryId(input))
    },
    selectsObjectProperties: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.selectsObjectProperties(input))
    },
    listLinks: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.listLinks(input))
    },
    getByPrimaryIdBatch: async (input) => {
      assertProject(input.projectId)
      return readMap(() => reader.getByPrimaryIdBatch(input))
    },
    listLinksBatch: async (input) => {
      assertProject(input.projectId)
      return readMap(() => reader.listLinksBatch(input))
    },
    queryLinks: async (input) => {
      assertProject(input.projectId)
      assertLinkQueryLimit(input.limit)
      return read(() => reader.queryLinks(input))
    },
    list: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.list(input))
    },
  } satisfies ObjectReadStorage)
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
