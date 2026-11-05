import { describe, expect, test } from "bun:test"
import type { ObjectReadCondition, ObjectVisibilityKeys } from "@sixb/core/storage"
import { visibilityStatisticsName } from "../src/objects/visibility-indexes"
import { readsFewObjects } from "../src/objects/visibility-statistics"

const owner: ObjectVisibilityKeys = { kind: "user", propertyId: "owner" }
const watchers: ObjectVisibilityKeys = { kind: "users", propertyId: "watchers" }

const condition = (
  user: { readonly type: "user"; readonly id: string },
  visibility: Partial<NonNullable<ObjectReadCondition["visibility"]>> = {}
): ObjectReadCondition => ({
  objectTypeId: "Ticket",
  predicate: { op: "eq", propertyId: "owner", value: user, scalarKind: "userRef" },
  visibility: { keys: [owner, watchers], user, ...visibility },
})

/** Both conditions' statistics list the three owners. */
const statistics = new Map(
  [owner, watchers].map((keys) => [
    visibilityStatisticsName("Ticket", keys),
    new Set(["u:usr_0", "u:usr_1", "u:usr_2"]),
  ])
)

// Guard removal: drop any early `return false` of readsFewObjects, and its case below fails.
describe("a reader who sees few objects", () => {
  test("is one none of whose keys the statistics list", () => {
    expect(readsFewObjects(condition({ type: "user", id: "usr_9" }), statistics)).toBe(true)
  })

  test("is not one whose key a statistic lists", () => {
    expect(readsFewObjects(condition({ type: "user", id: "usr_1" }), statistics)).toBe(false)
  })

  test("is unknown without a statistic for each of its conditions' keys", () => {
    const partial = new Map([...statistics].slice(0, 1))
    expect(readsFewObjects(condition({ type: "user", id: "usr_9" }), partial)).toBe(false)
  })

  test("is unknown with a remainder read object by object", () => {
    const remainder = { op: "neq", propertyId: "reviewer", value: "usr_9" } as const
    const reader = condition({ type: "user", id: "usr_9" }, { remainder })
    expect(readsFewObjects(reader, statistics)).toBe(false)
  })

  test("is unknown for an id too long to have a key", () => {
    const reader = condition({ type: "user", id: "u".repeat(201) })
    expect(readsFewObjects(reader, statistics)).toBe(false)
  })

  test("is unknown without keys", () => {
    const { visibility: _, ...predicateOnly } = condition({ type: "user", id: "usr_9" })
    expect(readsFewObjects(predicateOnly, statistics)).toBe(false)
  })
})
