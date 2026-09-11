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
import type { SQLClient, SqlParameter } from "../pg-client"
import { type PgStoreClient, runPgRepeatableReadTransaction } from "../transactions"
import { compilePgSelectedObjectReadSource, type PgSelectedObjectReadSource } from "./read-scope"

import { assertLinkQueryLimit, PgObjectReader } from "./reader"

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
  const assertProject = (actualProjectId: string): void =>
    assertObjectReaderProject(projectId, actualProjectId)
  const read = <T>(run: (reader: PgObjectReader) => Promise<T>): Promise<T> =>
    runPgRepeatableReadTransaction(sql, async (tx) => {
      await assertTraversalBudget(tx, source, limits.maxTraversalFacts)
      const value = await run(new PgObjectReader(tx, source))
      assertObjectReadOutputWithinLimit(value, limits)
      return value
    })
  const readMap = <TKey, TValue>(
    run: (reader: PgObjectReader) => Promise<Map<TKey, TValue>>
  ): Promise<Map<TKey, TValue>> =>
    runPgRepeatableReadTransaction(sql, async (tx) => {
      await assertTraversalBudget(tx, source, limits.maxTraversalFacts)
      const value = await run(new PgObjectReader(tx, source))
      assertObjectReadOutputWithinLimit([...value.entries()], limits)
      return value
    })

  return Object.freeze({
    queryCapabilities,
    queryObjects: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.queryObjects(input))
    },
    countObjects: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.countObjects(input))
    },
    existsObjects: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.existsObjects(input))
    },
    facetObjects: async (input) => {
      assertProject(input.projectId)
      assertObjectReadFacetCount(input.facets.length)
      return read((reader) => reader.facetObjects(input))
    },
    getByPrimaryId: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.getByPrimaryId(input))
    },
    selectsObjectProperties: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.selectsObjectProperties(input))
    },
    listLinks: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.listLinks(input))
    },
    getByPrimaryIdBatch: async (input) => {
      assertProject(input.projectId)
      return readMap((reader) => reader.getByPrimaryIdBatch(input))
    },
    listLinksBatch: async (input) => {
      assertProject(input.projectId)
      return readMap((reader) => reader.listLinksBatch(input))
    },
    queryLinks: async (input) => {
      assertProject(input.projectId)
      assertLinkQueryLimit(input.limit)
      return read((reader) => reader.queryLinks(input))
    },
    list: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.list(input))
    },
  } satisfies ObjectReadStorage)
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
