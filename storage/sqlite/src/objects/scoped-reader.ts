import type { Database } from "bun:sqlite"
import type {
  ObjectQueryCapabilities,
  ObjectReadExecutionLimits,
  ObjectReadStorage,
} from "@sixb/core/storage"
import {
  assertObjectReaderProject,
  assertObjectReadFacetCount,
  assertObjectReadOutputWithinLimit,
} from "@sixb/core/storage"
import { runDeferredReadTransaction } from "../transactions"
import type { SqliteObjectQuerySource } from "./query-compiler"
import { assertLinkQueryLimit, SqliteObjectReader } from "./reader"

/**
 * Answer every terminal from one scoped source, each in its own synchronous snapshot so the
 * statements of one read, and the scope's own checks before them, agree.
 */
export function createSqliteScopedReader(
  db: Database,
  params: {
    projectId: string
    source: SqliteObjectQuerySource
    /** Runs first in each read's snapshot. */
    beforeRead?: () => void
    limits?: ObjectReadExecutionLimits
  },
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  const { projectId, source, beforeRead, limits } = params
  const reader = new SqliteObjectReader(db, source)
  const assertProject = (actualProjectId: string): void =>
    assertObjectReaderProject(projectId, actualProjectId)
  const read = <T>(run: () => T): T =>
    runDeferredReadTransaction(db, () => {
      beforeRead?.()
      const value = run()
      if (limits) assertObjectReadOutputWithinLimit(value, limits)
      return value
    })
  const readMap = <TKey, TValue>(run: () => Map<TKey, TValue>): Map<TKey, TValue> =>
    runDeferredReadTransaction(db, () => {
      beforeRead?.()
      const value = run()
      if (limits) assertObjectReadOutputWithinLimit([...value.entries()], limits)
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
    getByUniqueValue: async (input) => {
      assertProject(input.projectId)
      return read(() => reader.getByUniqueValue(input))
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
