import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  defineObjectType,
  link,
  migrateStorage,
  type ObjectQuery,
  OntologyRegistry,
  prop,
} from "@sixb/core"
import { validateObjectQuery } from "@sixb/core/internal/query"
import { compileConditionalObjectReadScope } from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import { objectPartitionName } from "../src/objects/partitions"
import { compilePgObjectCountQuery, compilePgObjectQuery } from "../src/objects/query-compiler"
import { compilePgConditionalObjectReadSource } from "../src/objects/read-scope"
import { createPgClient, type SQL, type SqlParameter } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

// A member whose role carries view conditions reads through the conditional scope. A statement
// that reads objects without naming their type plans every partition and its indexes: on a
// 45-type ontology, one page with seven expansions took 196 MB and 239 ms to plan, enough to
// cross the JIT threshold. A member's read must plan only the partitions of the types it names.
//
// Reproduce: remove `linksBetweenVisibleObjectsTable` from the conditional source in
// read-scope.ts. Expansions and traversals then check both endpoints of each link again, whose
// types come from the link row, and their plans read every type's partition.

const Account = defineObjectType({
  id: "PartitionAccount",
  name: "Account",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Note = defineObjectType({
  id: "PartitionNote",
  name: "Note",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("visibility", "string", { query: { searchable: true, filterable: true } }),
  ],
})

const Task = defineObjectType({
  id: "PartitionTask",
  name: "Task",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("visibility", "string", { query: { searchable: true, filterable: true } }),
  ],
  links: [
    link("account", Account, { cardinality: "one" }),
    link("sourceNote", Note, { cardinality: "one" }),
    link("relatedNotes", Note, { cardinality: "many" }),
  ],
})

// Types the statements never name: each one is a partition a statement must not plan.
const unrelated = Array.from({ length: 32 }, (_, index) =>
  defineObjectType({
    id: `PartitionUnrelated${index}`,
    name: `Unrelated ${index}`,
    properties: [prop("id", "string", { required: true, primary: true })],
  })
)

const ontology = new OntologyRegistry({ sources: [Account, Note, Task, ...unrelated] })
const projectId = "pg-conditional-read-partitions"

const namedPartitions = [Account, Note, Task].map((type) => objectPartitionName(type.id)).sort()

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

  // Preparing the ontology gives every type its partition.
  await migrateStorage(storage, { projectId, ontology })
})

afterAll(async () => {
  await sql?.end()
  if (storage) await disposeTestStorage(storage)
})

/** A member's source: `visibility = 'team'` on tasks and notes. */
const memberSource = compilePgConditionalObjectReadSource(
  projectId,
  compileConditionalObjectReadScope({
    kind: "conditional",
    conditions: [Task.id, Note.id].map((objectTypeId) => {
      const { query } = validated({
        kind: "filter",
        input: { kind: "start", objectTypeId },
        predicate: { op: "eq", propertyId: "visibility", value: "team" },
      })
      if (query.kind !== "filter") throw new Error("expected a validated filter")

      return { objectTypeId, predicate: query.predicate }
    }),
  })
)

/** Core resolves each link's endpoint types before a provider compiles the query. */
function validated(query: ObjectQuery) {
  return validateObjectQuery(query, { ontology, resolveLinkEndpoints: true })
}

/** The partitions of objects a statement's plan reads, each once. */
async function plannedPartitions(statement: {
  readonly sql: string
  readonly args: readonly unknown[]
}): Promise<string[]> {
  const [row] = await sql.unsafe<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(
    `EXPLAIN (FORMAT JSON) ${statement.sql}`,
    statement.args as SqlParameter[]
  )

  const partitions = new Set<string>()
  const visit = (node: PlanNode) => {
    const relation = node["Relation Name"]
    if (relation?.startsWith("objects_")) partitions.add(relation)
    for (const child of node.Plans ?? []) visit(child)
  }
  visit(row!["QUERY PLAN"][0]!.Plan)

  return [...partitions].sort()
}

interface PlanNode {
  readonly "Relation Name"?: string
  readonly Plans?: readonly PlanNode[]
}

test("a member's expansions plan only the partitions of the types they read", async () => {
  const { query } = validated({
    kind: "expand",
    input: { kind: "limit", limit: 50, input: { kind: "start", objectTypeId: Task.id } },
    expansions: [
      { linkId: "account", direction: "outgoing" },
      { linkId: "sourceNote", direction: "outgoing" },
      {
        linkId: "relatedNotes",
        direction: "outgoing",
        expand: [{ linkId: "sourceNote", direction: "incoming", sourceObjectTypeId: Task.id }],
      },
    ],
  })

  const compiled = compilePgObjectQuery(projectId, query, {
    includeTotal: false,
    source: memberSource,
  })
  expect(await plannedPartitions(compiled)).toEqual(namedPartitions)
})

test("a member's traversals plan only the partitions of the types they read", async () => {
  const tasksOfNotes = validated({
    kind: "traverse",
    direction: "incoming",
    linkId: "relatedNotes",
    sourceObjectTypeId: Task.id,
    input: {
      kind: "traverse",
      direction: "outgoing",
      linkId: "sourceNote",
      input: { kind: "start", objectTypeId: Task.id },
    },
  }).query
  const tasksAndNotes = [Note.id, Task.id].map(objectPartitionName).sort()

  const page = compilePgObjectQuery(
    projectId,
    { kind: "limit", limit: 50, input: tasksOfNotes },
    { includeTotal: false, source: memberSource }
  )
  expect(await plannedPartitions(page)).toEqual(tasksAndNotes)

  // A bounded page sizes its traversal first, with its own statement.
  expect(page.traversalProbe).toBeDefined()
  expect(await plannedPartitions(page.traversalProbe!)).toEqual(tasksAndNotes)

  // A count reads an incoming traversal from one source type by batches of identities.
  const count = compilePgObjectCountQuery(projectId, tasksOfNotes, { source: memberSource })
  expect(await plannedPartitions(count)).toEqual(tasksAndNotes)
})
