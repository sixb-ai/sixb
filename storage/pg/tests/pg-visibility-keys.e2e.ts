import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  defineObjectType,
  migrateStorage,
  type ObjectQueryPredicate,
  OntologyRegistry,
  prop,
  ref,
  type UserRef,
  type ViewCondition,
} from "@sixb/core"
import { validateObjectQuery } from "@sixb/core/internal/query"
import { compileConditionalObjectReadScope, type ObjectVisibilityKeys } from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import { objectPartitionName } from "../src/objects/partitions"
import {
  compilePgObjectQuery,
  compilePgObjectStatement,
  compilePredicate,
} from "../src/objects/query-compiler"
import { compilePgConditionalObjectReadSource } from "../src/objects/read-scope"
import { compilePgConditionFilter } from "../src/objects/visibility"
import { createPgClient, type SQL, type SqlParameter } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

// A member reads a conditioned type through its conditions' keys, which PostgreSQL indexes once per
// condition. The shared conditional read contract checks that keys show what the condition shows
// on the data the materializer writes. Here, the SQL of keys is checked against the SQL of the
// predicate on rows a store may hold anyway: malformed references, and ids jsonb prints escaped.
// Reproduce a leak: in compilePgVisibilityKeys, drop the `(ref - 'type' - 'id') = '{}'` check of
// a user key, and a reference with an extra field shows its object to that user, which `eq` does
// not.

const filterable = { nullable: true, query: { searchable: true, filterable: true } } as const

const Doc = defineObjectType({
  id: "VisibilityDoc",
  name: "Doc",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", filterable),
    prop("visibility", "string", filterable),
    prop("amount", "double", filterable),
    prop("owner", ref.user(), filterable),
    prop("reviewer", ref.user(), filterable),
    prop("members", { type: "array", items: ref.user() }, filterable),
    prop("tags", { type: "array", items: "string" }, filterable),
  ],
})

const ontology = new OntologyRegistry({ sources: [Doc] })
const projectId = "pg-visibility-keys"

const me = { type: "currentUser" } as const

const eq = (propertyId: string, value: unknown): ObjectQueryPredicate => ({
  op: "eq",
  propertyId,
  value,
})
const contains = (propertyId: string, value: unknown): ObjectQueryPredicate => ({
  op: "contains",
  propertyId,
  value,
})
const or = (...items: ObjectQueryPredicate[]): ObjectQueryPredicate => ({ op: "or", items })
const and = (...items: ObjectQueryPredicate[]): ObjectQueryPredicate => ({ op: "and", items })

/**
 * Ids a key could confuse: quotes and separators as jsonb prints them, and the keys' own forms. In
 * a list, `z", ` printed before `a"b` reads `z\", ", "a\"b`, whose first `", "` is inside it.
 */
const oddIds = [
  "usr_1",
  'z", ',
  'a"b',
  "a\\b",
  'a", "b',
  'q", "usr_1',
  "x\u001fy",
  "é",
  "*",
  "u:usr_1",
]

/**
 * Ids too long for a GIN entry once escaped, which keys leave out: the index would refuse them,
 * and every write of their objects with it. Readers with them read the predicate. Reproduce: drop
 * the `like_regex` bound in compilePgVisibilityKeys, and preparation fails with "index row size
 * 3016 exceeds maximum 2712".
 */
const longIds = [
  "\u0001".repeat(201),
  // 3 kB that does not compress: PostgreSQL compresses an entry before it measures it.
  Array.from({ length: 1_000 }, (_, index) =>
    String.fromCodePoint(0x4e00 + ((index * 7_919) % 20_000))
  ).join(""),
]

/**
 * Each condition's keys, as core derives them, and its predicate bound to a reader: a user's
 * reference where it held `currentUser()`, or the constant `bindCurrentUser` leaves without one.
 */
const conditions: Record<
  string,
  {
    readonly keys: ObjectVisibilityKeys
    readonly bound: (user: UserRef | undefined) => ObjectQueryPredicate
  }
> = {
  "a value with ? and '": {
    keys: { kind: "everyone", when: eq("status", "what? it's") },
    bound: () => eq("status", "what? it's"),
  },
  mine: {
    keys: { kind: "user", propertyId: "owner" },
    bound: (user) => (user ? userEq("owner", user) : NO_ROW),
  },
  "a member": {
    keys: { kind: "users", propertyId: "members" },
    bound: (user) => (user ? userContains("members", user) : NO_ROW),
  },
  "open, and team or a member": {
    keys: {
      kind: "when",
      when: eq("status", "open"),
      keys: {
        kind: "union",
        items: [
          { kind: "everyone", when: eq("visibility", "team") },
          { kind: "users", propertyId: "members" },
        ],
      },
    },
    bound: (user) =>
      and(
        eq("status", "open"),
        or(eq("visibility", "team"), user ? userContains("members", user) : NO_ROW)
      ),
  },
  "mine or usr_1's": {
    keys: {
      kind: "union",
      items: [
        { kind: "everyone", when: userIn("owner", [{ type: "user", id: "usr_1" }]) },
        { kind: "user", propertyId: "owner" },
      ],
    },
    bound: (user) => userIn("owner", [...(user ? [user] : []), { type: "user", id: "usr_1" }]),
  },
  "large, or reviewed by me": {
    keys: {
      kind: "union",
      items: [
        {
          kind: "everyone",
          when: { op: "gte", propertyId: "amount", value: 10, scalarKind: "double" },
        },
        { kind: "user", propertyId: "reviewer" },
      ],
    },
    bound: (user) =>
      or(
        { op: "gte", propertyId: "amount", value: 10, scalarKind: "double" },
        user ? userEq("reviewer", user) : NO_ROW
      ),
  },
}

const NO_ROW: ObjectQueryPredicate = { op: "constant", value: false }

function userEq(propertyId: string, user: UserRef): ObjectQueryPredicate {
  return { op: "eq", propertyId, value: user, scalarKind: "userRef" }
}

function userContains(propertyId: string, user: UserRef): ObjectQueryPredicate {
  return { op: "contains", propertyId, value: user, scalarKind: "userRef" }
}

function userIn(propertyId: string, users: readonly UserRef[]): ObjectQueryPredicate {
  return { op: "in", propertyId, values: users, scalarKind: "userRef" }
}

let storage: PostgresStorage
let sql: SQL

beforeAll(async () => {
  const created = await createTestStorage()
  storage = created.storage
  sql = createPgClient({
    connectionString: created.connectionString,
    schemaName: created.schemaName,
    max: 1,
  })

  await migrateStorage(storage, { projectId, ontology })

  const documents = sampleDocuments()
  await sql`
    INSERT INTO objects (
      project_id, object_type_id, primary_id, properties, version, last_commit_id, created_at, updated_at
    )
    SELECT ${projectId}, ${Doc.id}, 'doc-' || ordinality, value, 1, 'seed', now(), now()
    FROM jsonb_array_elements(${JSON.stringify(documents)}::text::jsonb) WITH ORDINALITY`
}, 30_000)

afterAll(async () => {
  await sql?.end()
  if (storage) await disposeTestStorage(storage)
})

describe("visibility keys", () => {
  test("show each reader exactly the rows its bound condition matches", async () => {
    const readers: (UserRef | undefined)[] = [
      undefined,
      ...[...oddIds, ...longIds].map((id) => ({ type: "user" as const, id })),
    ]

    let shown = 0
    for (const [name, condition] of Object.entries(conditions)) {
      for (const user of readers) {
        const byKeys = await idsWhere(
          compilePgConditionFilter({
            objectTypeId: Doc.id,
            predicate: condition.bound(user),
            visibility: { keys: [condition.keys], ...(user ? { user } : {}) },
          })
        )
        const byPredicate = await idsWhere(compilePredicate(condition.bound(user)))

        expect({ name, user, ids: byKeys }).toEqual({ name, user, ids: byPredicate })
        shown += byKeys.length
      }
    }

    // The comparison means something only if readers see some rows and not others.
    expect(shown).toBeGreaterThan(1_000)
  })

  test("preparation indexes each condition's keys, and a member's read matches its index", async () => {
    const team = viewCondition(or(eq("visibility", "team"), eq("owner", me)))
    const members = viewCondition(contains("members", me))

    const prepared = await migrateStorage(storage, {
      projectId,
      ontology,
      security: { listViewConditions: () => [team, members] },
    })
    expect(conditionWarnings(prepared.queries?.warnings)).toEqual([])
    expect(await visibilityIndexes()).toHaveLength(2)
    expect(await visibilityStatistics()).toHaveLength(2)

    const user: UserRef = { type: "user", id: 'a", "b' }
    const source = compilePgConditionalObjectReadSource(
      projectId,
      compileConditionalObjectReadScope({
        kind: "conditional",
        conditions: [
          {
            objectTypeId: Doc.id,
            predicate: or(
              eq("visibility", "team"),
              userEq("owner", user),
              userContains("members", user)
            ),
            visibility: {
              keys: [
                {
                  kind: "union",
                  items: [
                    { kind: "everyone", when: validated(eq("visibility", "team")) },
                    { kind: "user", propertyId: "owner" },
                  ],
                },
                { kind: "users", propertyId: "members" },
              ],
              user,
            },
          },
        ],
      })
    )
    const read = compilePgObjectQuery(
      projectId,
      { kind: "limit", limit: 20, input: { kind: "start", objectTypeId: Doc.id } },
      { includeTotal: false, source }
    )

    // With no sequential or ordered scan to fall back to, only an index on the read's own key
    // expressions can serve the filter: their text must match the indexed one exactly.
    const plan = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`
      await tx`SET LOCAL enable_indexscan = off`
      const rows = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${read.sql}`, read.args as SqlParameter[])
      return JSON.stringify(rows[0]?.["QUERY PLAN"])
    })
    for (const index of await visibilityIndexes()) expect(plan).toContain(index)
  })

  test("a changed condition replaces its index, and a removed one takes its statistics", async () => {
    const team = viewCondition(eq("visibility", "team"))
    await migrateStorage(storage, {
      projectId,
      ontology,
      security: { listViewConditions: () => [team, viewCondition(eq("owner", me))] },
    })
    const before = await visibilityIndexes()

    await migrateStorage(storage, {
      projectId,
      ontology,
      security: { listViewConditions: () => [team, viewCondition(eq("reviewer", me))] },
    })
    const after = await visibilityIndexes()
    expect(after).toHaveLength(2)
    expect(after.filter((name) => before.includes(name))).toHaveLength(1)
    expect(await visibilityStatistics()).toHaveLength(2)

    // Prepared without the conditions, as a custom runtime might: what was built stays.
    await migrateStorage(storage, { projectId, ontology })
    expect(await visibilityIndexes()).toEqual(after)

    await migrateStorage(storage, {
      projectId,
      ontology,
      security: { listViewConditions: () => [] },
    })
    expect(await visibilityIndexes()).toEqual([])
    expect(await visibilityStatistics()).toEqual([])
  })

  // Guard removal: drop the project filter of dropUnusedVisibilityIndexes, or its `kept.some`
  // check. The other project's index, or the statistics it still uses, go with this project's.
  test("a project drops only its own indexes, and statistics another one uses stay", async () => {
    const team = viewCondition(eq("visibility", "team"))
    const prepare = (id: string, conditions: readonly ViewCondition[]) =>
      migrateStorage(storage, {
        projectId: id,
        ontology,
        security: { listViewConditions: () => conditions },
      })

    await prepare(projectId, [team])
    const own = await visibilityIndexes()
    await prepare("other-project", [team])
    const both = await visibilityIndexes()

    expect(both).toHaveLength(2)
    expect(await visibilityStatistics()).toHaveLength(1)

    await prepare(projectId, [])
    expect(await visibilityIndexes()).toEqual(both.filter((name) => !own.includes(name)))
    expect(await visibilityStatistics()).toHaveLength(1)

    await prepare("other-project", [])
    expect(await visibilityIndexes()).toEqual([])
    expect(await visibilityStatistics()).toEqual([])
  })

  test("a condition PostgreSQL cannot index is reported, and read row by row", async () => {
    const tagged = viewCondition(contains("tags", "urgent"))

    const prepared = await migrateStorage(storage, {
      projectId,
      ontology,
      security: { listViewConditions: () => [tagged] },
    })

    expect(conditionWarnings(prepared.queries?.warnings)).toEqual([
      expect.stringContaining(`${Doc.id}: a view condition cannot be indexed`),
    ])
    expect(await visibilityIndexes()).toEqual([])
  })
})

/** A grant's condition as validation returns it: `scalarKind` resolved, `currentUser()` kept. */
function validated(predicate: ObjectQueryPredicate): ObjectQueryPredicate {
  const { query } = validateObjectQuery(
    { kind: "filter", input: { kind: "start", objectTypeId: Doc.id }, predicate },
    { ontology }
  )
  if (query.kind !== "filter") throw new Error("expected a validated filter")
  return query.predicate
}

function viewCondition(predicate: ObjectQueryPredicate): ViewCondition {
  return { roleId: "member", objectTypeId: Doc.id, predicate: validated(predicate) }
}

function conditionWarnings(warnings: readonly string[] | undefined): readonly string[] {
  return (warnings ?? []).filter((warning) => warning.includes("view condition"))
}

/** Ids of the documents a filter keeps, numbered like a read's statement. */
async function idsWhere(filter: {
  readonly sql: string
  readonly args: readonly unknown[]
}): Promise<string[]> {
  const statement = compilePgObjectStatement(
    `SELECT primary_id FROM objects WHERE project_id = ? AND object_type_id = ? AND ${filter.sql} ORDER BY primary_id`,
    [projectId, Doc.id, ...filter.args]
  )
  const rows = await sql.unsafe<{ primary_id: string }[]>(
    statement.sql,
    statement.args as SqlParameter[]
  )
  return rows.map((row) => row.primary_id)
}

async function visibilityIndexes(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT indexname AS name FROM pg_indexes
    WHERE tablename = ${objectPartitionName(Doc.id)} AND indexname LIKE 'sixb_visibility_%'
    ORDER BY indexname`
  return rows.map((row) => row.name)
}

async function visibilityStatistics(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT stxname AS name FROM pg_statistic_ext WHERE stxname LIKE 'sixb_visibility_stats_%'
    ORDER BY stxname`
  return rows.map((row) => row.name)
}

/** Every combination of a few values per property, references malformed in the ways stores hold. */
function sampleDocuments(): Record<string, unknown>[] {
  const users = [
    undefined,
    null,
    ...[...oddIds, ...longIds].map((id) => ({ type: "user", id })),
    { type: "user", id: "usr_1", name: "extra field" },
    { type: "user", id: 1 },
    { type: "agent", id: "usr_1" },
    "usr_1",
  ]
  const lists = [
    undefined,
    [],
    oddIds.slice(0, 4).map((id) => ({ type: "user", id })),
    [...oddIds.slice(4), ...longIds].map((id) => ({ type: "user", id })),
    [{ type: "user", id: "usr_1", role: "editor" }, { type: "user" }, "usr_1", ["usr_1"]],
    { type: "user", id: "usr_1" },
  ]

  const documents: Record<string, unknown>[] = []
  for (const [index, owner] of users.entries())
    for (const members of lists)
      for (const status of [undefined, "open", "what? it's"])
        for (const visibility of ["team", "private"]) {
          documents.push(
            Object.fromEntries(
              Object.entries({
                status,
                visibility,
                amount: index % 3 === 0 ? 5 : 12,
                owner,
                reviewer: users[(index + 3) % users.length],
                members,
                tags: index % 2 === 0 ? ["urgent"] : [],
              }).filter(([, value]) => value !== undefined)
            )
          )
        }
  return documents
}
