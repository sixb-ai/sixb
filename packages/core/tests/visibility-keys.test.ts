import { describe, expect, test } from "bun:test"
import { defineObjectType, prop, ref } from "../src"
import { bindCurrentUserPredicate } from "../src/objects/query/current-user"
import type { ObjectQueryPredicate } from "../src/objects/query/ir"
import { matchesPredicate } from "../src/objects/query/matches-predicate"
import { validateObjectQuery } from "../src/objects/query/validate"
import { OntologyRegistry } from "../src/ontology"
import type { UserRef } from "../src/ontology/user-ref"
import { viewConditionKeys, viewConditionReadCondition } from "../src/security/visibility-keys"
import type { ObjectVisibilityKeys } from "../src/storage"

const filterable = { nullable: true, query: { searchable: true, filterable: true } } as const

const Doc = defineObjectType({
  id: "doc",
  name: "Doc",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", filterable),
    prop("visibility", "string", filterable),
    prop("amount", "double", filterable),
    prop("owner", ref.user(), filterable),
    prop("reviewer", ref.user(), filterable),
    prop("members", { type: "array", items: ref.user() }, filterable),
  ],
})

const ontology = new OntologyRegistry({ sources: [Doc] })

const me = { type: "currentUser" } as const
const boss = { type: "user", id: "boss" } as const

const eq = (propertyId: string, value: unknown): ObjectQueryPredicate => ({
  op: "eq",
  propertyId,
  value,
})
const neq = (propertyId: string, value: unknown): ObjectQueryPredicate => ({
  op: "neq",
  propertyId,
  value,
})
const contains = (propertyId: string, value: unknown): ObjectQueryPredicate => ({
  op: "contains",
  propertyId,
  value,
})
const and = (...items: ObjectQueryPredicate[]): ObjectQueryPredicate => ({ op: "and", items })
const or = (...items: ObjectQueryPredicate[]): ObjectQueryPredicate => ({ op: "or", items })
const not = (item: ObjectQueryPredicate): ObjectQueryPredicate => ({ op: "not", item })

/** Each condition, with the keys it has, written as `describeKeys` prints them. */
const conditions: readonly [string, ObjectQueryPredicate, string | undefined][] = [
  ["team", eq("visibility", "team"), "everyone"],
  ["mine", eq("owner", me), "user(owner)"],
  ["a member", contains("members", me), "users(members)"],
  ["team or mine", or(eq("visibility", "team"), eq("owner", me)), "everyone | user(owner)"],
  ["open and mine", and(eq("status", "open"), eq("owner", me)), "when(user(owner))"],
  [
    "open, and team or a member",
    and(eq("status", "open"), or(eq("visibility", "team"), contains("members", me))),
    "when(everyone | users(members))",
  ],
  [
    "mine or the boss's",
    { op: "in", propertyId: "owner", values: [me, boss] },
    "everyone | user(owner)",
  ],
  ["mine, through in", { op: "in", propertyId: "owner", values: [me] }, "user(owner)"],
  ["owned or reviewed", or(eq("owner", me), eq("reviewer", me)), "user(owner) | user(reviewer)"],
  ["no draft", not(eq("status", "draft")), "everyone"],
  [
    "large, and open or mine",
    and({ op: "gte", propertyId: "amount", value: 10 }, or(eq("status", "open"), eq("owner", me))),
    "when(everyone | user(owner))",
  ],
  [
    "team and open, or private and a member",
    or(
      and(eq("visibility", "team"), eq("status", "open")),
      and(eq("visibility", "private"), contains("members", me))
    ),
    "everyone | when(users(members))",
  ],
  // Without keys: every user but some, or the users two properties share.
  ["not mine", neq("owner", me), undefined],
  ["not mine, through not", not(eq("owner", me)), undefined],
  ["mine or not reviewed by me", or(eq("owner", me), neq("reviewer", me)), undefined],
  ["mine and a member", and(eq("owner", me), contains("members", me)), undefined],
]

describe("view condition keys", () => {
  test.each(conditions)("%s", (_, predicate, expected) => {
    const keys = viewConditionKeys(validated(predicate))
    expect(keys && describeKeys(keys)).toBe(expected)
  })

  // A guard on the translation: swap `when` for its keys alone, or `union` for its first item,
  // and some document below is shown to a reader its predicate hides, or the reverse.
  test("show a reader exactly the objects its bound condition matches", () => {
    const documents = sampleDocuments()
    const readers: (UserRef | undefined)[] = [
      undefined,
      { type: "user", id: "usr_1" },
      { type: "user", id: "usr_2" },
      { type: "user", id: "boss" },
    ]

    let compared = 0
    for (const [, condition, expected] of conditions) {
      if (expected === undefined) continue
      const predicate = validated(condition)
      const keys = viewConditionKeys(predicate)!

      for (const user of readers) {
        const bound = bindCurrentUserPredicate(predicate, user)
        for (const properties of documents) {
          const row = { properties }
          expect({ properties, user, shown: shows(keys, row, user) }).toEqual({
            properties,
            user,
            shown: matchesPredicate(row, bound),
          })
          compared += 1
        }
      }
    }

    expect(compared).toBeGreaterThan(10_000)
  })

  test("a reader reads the conditions without keys through their bound predicate", () => {
    const user: UserRef = { type: "user", id: "usr_1" }
    const condition = viewConditionReadCondition(
      Doc.id,
      [validated(eq("owner", me)), validated(neq("reviewer", me))],
      user
    )

    const notReviewed: ObjectQueryPredicate = {
      op: "neq",
      propertyId: "reviewer",
      value: user,
      scalarKind: "userRef",
    }

    expect(condition.predicate).toEqual(
      or({ op: "eq", propertyId: "owner", value: user, scalarKind: "userRef" }, notReviewed)
    )
    expect(condition.visibility).toEqual({
      keys: [{ kind: "user", propertyId: "owner" }],
      user,
      remainder: notReviewed,
    })
  })

  test("a reader whose conditions have no keys reads their predicate alone", () => {
    const condition = viewConditionReadCondition(Doc.id, [validated(neq("owner", me))], undefined)

    expect(condition).toEqual({ objectTypeId: Doc.id, predicate: { op: "constant", value: true } })
  })
})

/** The condition as a grant's validation returns it: `scalarKind` resolved, `currentUser()` kept. */
function validated(predicate: ObjectQueryPredicate): ObjectQueryPredicate {
  const { query } = validateObjectQuery(
    { kind: "filter", input: { kind: "start", objectTypeId: Doc.id }, predicate },
    { ontology }
  )
  if (query.kind !== "filter") throw new Error("expected a validated filter")
  return query.predicate
}

/** Whether keys show a row to a reader: everyone's do, and the users' when one is the reader. */
function shows(
  keys: ObjectVisibilityKeys,
  row: { readonly properties: Record<string, unknown> },
  user: UserRef | undefined
): boolean {
  switch (keys.kind) {
    case "everyone":
      return matchesPredicate(row, keys.when)
    case "user":
      return user !== undefined && matchesPredicate(row, validated(eq(keys.propertyId, user)))
    case "users":
      return user !== undefined && matchesPredicate(row, validated(contains(keys.propertyId, user)))
    case "union":
      return keys.items.some((item) => shows(item, row, user))
    case "when":
      return matchesPredicate(row, keys.when) && shows(keys.keys, row, user)
  }
}

function describeKeys(keys: ObjectVisibilityKeys): string {
  switch (keys.kind) {
    case "everyone":
      return "everyone"
    case "user":
    case "users":
      return `${keys.kind}(${keys.propertyId})`
    case "union":
      return keys.items.map(describeKeys).join(" | ")
    case "when":
      return `when(${describeKeys(keys.keys)})`
  }
}

/** Every combination of a few values per property, references malformed in the ways stores hold. */
function sampleDocuments(): Record<string, unknown>[] {
  const users = [
    undefined,
    null,
    { type: "user", id: "usr_1" },
    { type: "user", id: "boss" },
    { type: "user", id: 1 },
    { type: "agent", id: "usr_1" },
  ]
  const lists = [
    undefined,
    [],
    [{ type: "user", id: "usr_1" }],
    [{ type: "user", id: "usr_2" }, { type: "user" }, "usr_1"],
  ]

  const documents: Record<string, unknown>[] = []
  for (const status of [undefined, "open", "draft"])
    for (const visibility of ["team", "private", null])
      for (const amount of [undefined, 5, 10])
        for (const owner of users)
          for (const reviewer of users.slice(0, 3))
            for (const members of lists) {
              documents.push(
                Object.fromEntries(
                  Object.entries({ status, visibility, amount, owner, reviewer, members }).filter(
                    ([, value]) => value !== undefined
                  )
                )
              )
            }
  return documents
}
