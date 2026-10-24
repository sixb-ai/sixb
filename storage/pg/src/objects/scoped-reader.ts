import type { ObjectQuery } from "@sixb/core"
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
import { assertLinkQueryLimit, type PgObjectReader } from "./reader"

/** Run one terminal on a reader over the scope's source; a query terminal passes its query. */
export type PgScopedRead = <T>(
  run: (reader: PgObjectReader) => Promise<T>,
  query?: ObjectQuery
) => Promise<T>

/** Answer every terminal through one scoped source; the scope decides how each read runs. */
export function createPgScopedReader(
  params: {
    projectId: string
    read: PgScopedRead
    limits?: ObjectReadExecutionLimits
  },
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  const { projectId, limits } = params
  const assertProject = (actualProjectId: string): void =>
    assertObjectReaderProject(projectId, actualProjectId)
  const read = async <T>(
    run: (reader: PgObjectReader) => Promise<T>,
    query?: ObjectQuery
  ): Promise<T> => {
    const value = await params.read(run, query)
    if (limits) assertObjectReadOutputWithinLimit(value, limits)
    return value
  }
  const readMap = async <TKey, TValue>(
    run: (reader: PgObjectReader) => Promise<Map<TKey, TValue>>
  ): Promise<Map<TKey, TValue>> => {
    const value = await params.read(run)
    if (limits) assertObjectReadOutputWithinLimit([...value.entries()], limits)
    return value
  }

  return Object.freeze({
    queryCapabilities,
    queryObjects: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.queryObjects(input), input.query)
    },
    countObjects: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.countObjects(input), input.query)
    },
    existsObjects: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.existsObjects(input), input.query)
    },
    facetObjects: async (input) => {
      assertProject(input.projectId)
      assertObjectReadFacetCount(input.facets.length)
      return read((reader) => reader.facetObjects(input), input.query)
    },
    getByPrimaryId: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.getByPrimaryId(input))
    },
    getByUniqueValue: async (input) => {
      assertProject(input.projectId)
      return read((reader) => reader.getByUniqueValue(input))
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
