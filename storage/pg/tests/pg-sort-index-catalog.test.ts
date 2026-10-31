import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { PgSortIndexCatalog } from "../src/objects/query-indexes"
import type { SQLClient } from "../src/pg-client"

const definition = JSON.stringify({
  kind: "sort",
  projectId: "p",
  objectTypeId: "Article",
  fields: [{ propertyId: "title" }],
})

/** A client answering the catalog read with the given rows, counting its reads. */
function catalogClient(answer: () => Promise<{ definition: string }[]>) {
  const client = { reads: 0, sql: (() => {}) as unknown as SQLClient }
  client.sql = (() => {
    client.reads++
    return answer()
  }) as unknown as SQLClient
  return client
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

// Guard removal: return readPgSortIndexes(sql) from indexes() and every query reads the catalog.
test("reads the sort indexes once a minute and again after preparing", async () => {
  const client = catalogClient(async () => [{ definition }, { definition: "{" }])
  const catalog = new PgSortIndexCatalog()

  const [first, second] = await Promise.all([
    catalog.indexes(client.sql),
    catalog.indexes(client.sql),
  ])
  expect(first).toEqual([JSON.parse(definition)])
  expect(second).toBe(first)
  expect(client.reads).toBe(1)

  jest.advanceTimersByTime(59_000)
  await catalog.indexes(client.sql)
  expect(client.reads).toBe(1)

  jest.advanceTimersByTime(1_000)
  await catalog.indexes(client.sql)
  expect(client.reads).toBe(2)

  catalog.invalidate()
  await catalog.indexes(client.sql)
  expect(client.reads).toBe(3)
})

// Guard removal: keep the read in indexes()' catch and a failed read is served for a minute.
test("reads again after a failed read", async () => {
  let fail = true
  const client = catalogClient(async () => {
    if (fail) throw new Error("connection reset")
    return [{ definition }]
  })
  const catalog = new PgSortIndexCatalog()

  const error = await catalog.indexes(client.sql).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)

  fail = false
  expect(await catalog.indexes(client.sql)).toHaveLength(1)
  expect(client.reads).toBe(2)
})
