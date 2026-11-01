import { afterEach, describe, expect, test } from "bun:test"
import { migrateStorage } from "@sixb/core"
import { postgresStorageMigrations } from "../src/migrations"
import { ensureObjectPartition, objectPartitionName } from "../src/objects/partitions"
import { compilePgObjectQuery } from "../src/objects/query-compiler"
import { createPgClient, type SQL, type SqlParameter } from "../src/pg-client"
import { withReservedPgConnection } from "../src/transactions"
import { createTestStorage, disposeTestStorage, type TestStorage, waitForLockWait } from "./helpers"

const projectId = "partitions"
const partitionMigration = postgresStorageMigrations.steps.findIndex(
  (step) => step.id === "084-partition-objects"
)

let created: TestStorage | undefined
let sql: SQL | undefined

async function open(options?: Parameters<typeof createTestStorage>[0]) {
  created = await createTestStorage(options)
  sql = createPgClient({
    connectionString: created.connectionString,
    schemaName: created.schemaName,
    max: 1,
  })
  return { storage: created.storage, sql }
}

afterEach(async () => {
  await sql?.end()
  if (created) await disposeTestStorage(created.storage)
  sql = undefined
  created = undefined
})

async function seed(client: SQL, objectTypeId: string, ids: readonly string[]) {
  for (const id of ids) {
    await client`INSERT INTO objects
      (project_id, object_type_id, primary_id, properties, created_at, updated_at, version, last_commit_id)
      VALUES (${projectId}, ${objectTypeId}, ${id}, ${client.json({ id, status: "open" })}, now(), now(), 1, 'seed')`
  }
}

async function rowsIn(client: SQL, table: string): Promise<string[]> {
  const rows = await client.unsafe<{ primary_id: string }[]>(
    `SELECT primary_id FROM "${table}" ORDER BY primary_id`
  )
  return rows.map((row) => row.primary_id)
}

const referencing = `CREATE TABLE object_notes (
  project_id TEXT NOT NULL, object_type_id TEXT NOT NULL, primary_id TEXT NOT NULL,
  FOREIGN KEY (project_id, object_type_id, primary_id)
    REFERENCES objects (project_id, object_type_id, primary_id) ON DELETE CASCADE
)`

describe("objects partitions", () => {
  test("the migration moves every object to its type's partition and keeps references", async () => {
    const { storage, sql: client } = await open({ migrateThrough: partitionMigration })
    await seed(client, "Quote", ["q1", "q2"])
    await seed(client, "Organization", ["o1"])
    await client.unsafe(referencing)
    await client`INSERT INTO object_notes VALUES (${projectId}, 'Quote', 'q1')`

    await migrateStorage(storage)

    expect(await rowsIn(client, objectPartitionName("Quote"))).toEqual(["q1", "q2"])
    expect(await rowsIn(client, objectPartitionName("Organization"))).toEqual(["o1"])
    expect(await rowsIn(client, "objects_default")).toEqual([])
    expect(await client`SELECT 1 FROM object_notes`).toHaveLength(1)

    await client`DELETE FROM objects WHERE object_type_id = 'Quote' AND primary_id = 'q1'`
    expect(await client`SELECT 1 FROM object_notes`).toHaveLength(0)

    const indexes = await client<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'objects' ORDER BY indexname`
    expect(indexes.map((index) => index.name)).toEqual([
      "idx_objects_created_at",
      "idx_objects_project_type",
      "idx_objects_updated_at",
      "objects_pkey",
    ])
  })

  // Removal proof: drop the DROP and ADD CONSTRAINT loops in ensureObjectPartition. Moving a row
  // out of the default partition then fires ON DELETE CASCADE, and object_notes comes back empty.
  test("preparation moves rows out of the default partition without firing cascades", async () => {
    const { storage, sql: client } = await open()
    await client.unsafe(referencing)
    await seed(client, "Late", ["a", "b"])
    await seed(client, "Other", ["x"])
    await client`INSERT INTO object_notes VALUES (${projectId}, 'Late', 'a')`
    expect(await rowsIn(client, "objects_default")).toEqual(["a", "b", "x"])

    await storage.ensureObjectQueryIndexes([
      { projectId, objectTypeId: "Late", kind: "filter", properties: ["status"] },
    ])

    expect(await rowsIn(client, objectPartitionName("Late"))).toEqual(["a", "b"])
    expect(await rowsIn(client, "objects_default")).toEqual(["x"])
    expect(await client`SELECT 1 FROM object_notes`).toHaveLength(1)

    await client`DELETE FROM objects WHERE object_type_id = 'Late' AND primary_id = 'a'`
    expect(await client`SELECT 1 FROM object_notes`).toHaveLength(0)
  })

  // A second session, as another process adding a type would be.
  async function addPartition(objectTypeId: string): Promise<void> {
    const other = createPgClient({
      connectionString: created!.connectionString,
      schemaName: created!.schemaName,
      max: 1,
    })
    try {
      await withReservedPgConnection(other, (connection) =>
        ensureObjectPartition(connection, created!.schemaName, objectTypeId)
      )
    } finally {
      await other.end()
    }
  }

  // Removal proof: create the partition with CREATE TABLE ... PARTITION OF, which takes the parent
  // exclusively. It then waits for this open read until its lock attempts run out.
  test("adding a type does not wait for queries running on other types", async () => {
    const { sql: client } = await open()
    await addPartition("Busy")
    await seed(client, "Busy", ["b1"])

    await client.begin(async (tx) => {
      await tx`SELECT * FROM objects WHERE object_type_id = 'Busy'`
      await addPartition("Added")
      expect(await tx`SELECT * FROM objects WHERE object_type_id = 'Busy'`).toHaveLength(1)
    })

    expect(await rowsIn(client, objectPartitionName("Added"))).toEqual([])
  })

  // Removal proof: lock objects_default ahead of the parent and take the parent exclusively, as the
  // first version did. This read then holds the parent while it waits for the default partition,
  // and PostgreSQL kills one side as a deadlock.
  test("adding a type does not deadlock with a query reading every partition", async () => {
    const { sql: client } = await open()
    await addPartition("Read")
    await seed(client, "Read", ["r1"])

    let adding: Promise<void> | undefined
    await client.begin(async (tx) => {
      await tx`SELECT * FROM objects WHERE object_type_id = 'Read'`
      adding = addPartition("Late")
      await waitForLockWait(created!.connectionString, adding)
      expect(await tx`SELECT primary_id FROM objects`).toHaveLength(1)
    })
    await adding

    expect(await rowsIn(client, objectPartitionName("Late"))).toEqual([])
  })

  test("gives way to a query holding the default partition, then finishes", async () => {
    const { sql: client } = await open()

    let adding: Promise<void> | undefined
    await client.begin(async (tx) => {
      await tx`SELECT * FROM objects_default`
      adding = addPartition("Patient")
      await waitForLockWait(created!.connectionString, adding)
    })

    await adding
    expect(await rowsIn(client, objectPartitionName("Patient"))).toEqual([])
  })

  test("preparing a type twice leaves one partition and one index", async () => {
    const { storage, sql: client } = await open()
    const index = {
      projectId,
      objectTypeId: "Twice",
      kind: "filter" as const,
      properties: ["status"],
    }

    const [first] = await storage.ensureObjectQueryIndexes([index])
    const [second] = await storage.ensureObjectQueryIndexes([index])

    expect(second).toBe(first)
    const partitions = await client`
      SELECT 1 FROM pg_inherits WHERE inhparent = 'objects'::regclass
        AND inhrelid = ${objectPartitionName("Twice")}::regclass`
    expect(partitions).toHaveLength(1)
  })

  test("a type's index never reaches another type, even with the same definition", async () => {
    const { storage, sql: client } = await open()
    const [one, other] = await storage.ensureObjectQueryIndexes([
      { projectId, objectTypeId: "One", kind: "filter", properties: ["status"] },
      { projectId, objectTypeId: "Another", kind: "filter", properties: ["status"] },
    ])

    expect(one).not.toBe(other)
    const tables = await client<{ table_name: string }[]>`
      SELECT tablename AS table_name FROM pg_indexes WHERE indexname = ${one!}`
    expect(tables.map((row) => row.table_name)).toEqual([objectPartitionName("One")])
  })

  test("a query reads and plans only its own type's partition", async () => {
    const { storage, sql: client } = await open()
    await storage.ensureObjectQueryIndexes([
      { projectId, objectTypeId: "Read", kind: "filter", properties: ["status"] },
      { projectId, objectTypeId: "Ignored", kind: "filter", properties: ["status"] },
    ])
    await seed(client, "Read", ["r1"])
    await seed(client, "Ignored", ["i1"])

    const compiled = compilePgObjectQuery(
      projectId,
      { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Read" } },
      { includeTotal: false }
    )
    const plan = await client.unsafe(`EXPLAIN ${compiled.sql}`, compiled.args as SqlParameter[])
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n")

    expect(text).toContain(objectPartitionName("Read"))
    expect(text).not.toContain(objectPartitionName("Ignored"))
    expect(text).not.toContain("objects_default")
  })

  test("an object of a type without a partition is stored, read and removed", async () => {
    const { storage, sql: client } = await open()
    await seed(client, "Unprepared", ["u1"])

    const row = await storage.objects.getByPrimaryId({
      projectId,
      objectTypeId: "Unprepared",
      primaryId: "u1",
    })
    expect(row?.primaryId).toBe("u1")
    expect(await rowsIn(client, "objects_default")).toEqual(["u1"])

    await client`DELETE FROM objects WHERE object_type_id = 'Unprepared'`
    expect(await rowsIn(client, "objects_default")).toEqual([])
  })
})
