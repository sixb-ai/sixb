import { expect, test } from "bun:test"
import type { BranchNamespace, SnapshotLoadBatch } from "@sixb/core/storage"
import { runSnapshotLoadContractSuite, runSnapshotReadContractSuite } from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

const connections = new WeakMap<PostgresStorage, { url: string; schema: string }>()

async function testStorage(): Promise<PostgresStorage> {
  const { storage, connectionString, schemaName } = await createTestStorage()
  connections.set(storage, { url: connectionString, schema: schemaName })
  return storage
}

/** A client on a test storage's database, closed after `run`. */
async function withClient<T>(
  storage: PostgresStorage,
  schema: string | undefined,
  run: (sql: ReturnType<typeof createPgClient>) => Promise<T>
): Promise<T> {
  const connection = connections.get(storage)
  if (!connection) throw new Error("Expected a test storage.")

  const sql = createPgClient({
    connectionString: connection.url,
    schemaName: schema ?? connection.schema,
    max: 1,
  })
  try {
    return await run(sql)
  } finally {
    await sql.end()
  }
}

runSnapshotReadContractSuite("PostgreSQL storage", {
  createStorage: testStorage,
  cleanup: (storage) => disposeTestStorage(storage),
  // Ranges come from the statistics of a type's partition.
  beforeRanges: (storage) =>
    withClient(storage, undefined, async (sql) => {
      await sql`ANALYZE`
    }),
})

runSnapshotLoadContractSuite("PostgreSQL storage", {
  createStorage: testStorage,
  cleanup: (storage) => disposeTestStorage(storage),
})

const PROJECT = "pg-load"
const at = "2026-01-01T00:00:00.000Z"

/** Load `batch` into a branch through its loader, with the execution its commit needs. */
async function load(branch: BranchNamespace, batch: SnapshotLoadBatch, id = "snapshot_pg") {
  const operation = { type: "ontology.loadSnapshot", snapshotId: id } as const
  await branch.executions.create({
    id: `exec_${id}`,
    projectId: PROJECT,
    executor: { type: "kernel", operation },
    source: { type: "http", requestId: id },
    correlationId: id,
    authorizationRef: { type: "kernel", operation },
  })

  return branch.loadSnapshot(
    {
      projectId: PROJECT,
      commit: {
        projectId: PROJECT,
        id,
        idempotencyKey: id,
        requestHash: id,
        executionId: `exec_${id}`,
        origin: { kind: "runtime", requestId: id },
        ontologyRevision: "revision",
        committedAt: at,
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        result: {
          kind: "edit",
          commitId: id,
          created: true,
          eventCount: 0,
          committedAt: at,
          outcomes: [],
          changes: { objects: [], links: [] },
        },
      },
      uniqueProperties: [],
      objectTypeIds: ["Thing"],
    },
    (loader) => loader.write(batch)
  )
}

const things: SnapshotLoadBatch = {
  objects: ["a", "b"].map((id) => ({
    objectTypeId: "Thing",
    primaryId: id,
    properties: { id },
    override: { kind: "create", properties: { id } },
    createdAt: at,
    updatedAt: at,
  })),
  links: [
    ["a", "b"],
    ["b", "a"],
  ].map(([sourceId, targetId]) => ({
    sourceTypeId: "Thing",
    sourceId: sourceId!,
    linkId: "next",
    targetTypeId: "Thing",
    targetId: targetId!,
    identity: "edge" as const,
    createdAt: at,
    updatedAt: at,
  })),
}

/** What a branch schema holds: its indexes, its objects and its comment. */
async function schemaState(storage: PostgresStorage, schema: string) {
  return withClient(storage, "public", async (sql) => {
    const indexes = await sql<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes WHERE schemaname = ${schema} ORDER BY indexname`
    const [objects] = await sql.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM "${schema}".objects`
    )
    const [comment] = await sql<{ comment: string | null }[]>`
      SELECT obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace
      WHERE nspname = ${schema}`
    // A load lays out each type's partition first, and keeps it: it holds no row.
    const kept = indexes
      .map((row) => row.name)
      .filter((name) => !/^objects_[0-9a-f]{20}/.test(name))
    return { indexes: kept, objects: objects?.count, ...comment }
  })
}

// Reproduce: commit each lane before building its indexes, and the failed build leaves the
// schema without them.
test("a load whose index build fails leaves the namespace as it was", async () => {
  const storage = await testStorage()
  try {
    const branch = await storage.createBranchNamespace("failing-index")
    const schema = "sixb_test_branch_failing_index"
    // An index no load can build: both links share a link id.
    await withClient(storage, schema, async (sql) => {
      await sql`CREATE UNIQUE INDEX sixb_test_one_link ON links (link_id)`
    })
    const before = await schemaState(storage, schema)

    const refused = await load(branch, things).catch((error: unknown) => error)
    expect(String(refused)).toContain("sixb_test_one_link")
    expect(await schemaState(storage, schema)).toEqual(before)

    await withClient(storage, schema, async (sql) => {
      await sql`DROP INDEX sixb_test_one_link`
    })
    await load(branch, things, "snapshot_again")
    expect((await schemaState(storage, schema)).objects).toBe(2)
  } finally {
    await disposeTestStorage(storage)
  }
}, 60_000)

// Reproduce: commit each lane once its own copies end, and drop the TRUNCATE from emptyAgain: the
// objects' lane keeps its rows after the link overrides' lane failed.
test("a load that fails in a later lane keeps nothing of the earlier ones", async () => {
  const storage = await testStorage()
  try {
    const branch = await storage.createBranchNamespace("failing-lane")
    const schema = "sixb_test_branch_failing_lane"
    const before = await schemaState(storage, schema)

    // The link overrides' lane refuses an identity that is neither an edge nor a slot.
    const broken: SnapshotLoadBatch = {
      ...things,
      links: things.links?.map((link) => ({ ...link, identity: "bogus" as "edge" })),
    }
    const refused = await load(branch, broken).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(await schemaState(storage, schema)).toEqual(before)
  } finally {
    await disposeTestStorage(storage)
  }
}, 60_000)

// Reproduce: let openBranchNamespace ignore the `loading` mark, and a half-loaded namespace opens.
test("a load cut short marks the namespace, which then refuses to open", async () => {
  const storage = await testStorage()
  try {
    await storage.createBranchNamespace("cut-short")
    // What a crash between two lanes' commits leaves: the mark the first transaction wrote.
    await withClient(storage, "public", async (sql) => {
      await sql.unsafe(
        `COMMENT ON SCHEMA "sixb_test_branch_cut_short" IS '{"sixbBranch":"cut-short","loading":true}'`
      )
    })

    const opened = await storage.openBranchNamespace("cut-short").catch((error) => error)
    expect(String(opened)).toContain("drop it and load the snapshot again")

    await storage.dropBranchNamespace("cut-short")
    expect(await storage.listBranchNamespaces()).toEqual([])
  } finally {
    await disposeTestStorage(storage)
  }
}, 60_000)

// Reproduce: drop the branchName check from loadSnapshot, and the root schema is truncated; drop
// the advisory lock, and two loads write into one namespace.
test("a snapshot loads into a branch namespace only, one load at a time", async () => {
  const storage = await testStorage()
  try {
    const root = await load(storage, things).catch((error: unknown) => error)
    expect(String(root)).toContain("loads into a branch namespace only")

    const branch = await storage.createBranchNamespace("one-at-a-time")
    const first = load(branch, things)
    const second = await load(branch, things, "snapshot_second").catch((error: unknown) => error)
    await first
    expect(String(second)).toMatch(/loading a snapshot already|holds no object yet/)
  } finally {
    await disposeTestStorage(storage)
  }
}, 60_000)

// Reproduce: drop FREEZE from the COPY in PgSnapshotLoad, and no page of the partition is
// visible to all until a vacuum runs, so counts read the heap.
test("a loaded partition is visible to all at once", async () => {
  const storage = await testStorage()
  try {
    const branch = await storage.createBranchNamespace("frozen")
    await load(branch, things)

    const [stats] = await withClient(
      storage,
      "sixb_test_branch_frozen",
      (sql) =>
        sql<{ pages: number; visible: number }[]>`
        SELECT relpages AS pages, relallvisible AS visible FROM pg_class
        WHERE oid = to_regclass(format('objects_%s', left(md5('Thing'), 24)))`
    )
    expect(stats?.pages).toBeGreaterThan(0)
    expect(stats?.visible).toBe(stats?.pages)
  } finally {
    await disposeTestStorage(storage)
  }
}, 60_000)

// Reproduce: cut branchSchemaName at 63 bytes without the hash, and the two names share a schema.
test("a long branch name keeps a schema of its own", async () => {
  const created = await testStorage()
  const connection = connections.get(created)
  const storage = new PostgresStorage({
    connectionString: connection?.url,
    schemaName: "a_production_schema_with_a_long_name",
    max: 4,
  })
  try {
    const long = "feature-with-a-really-long-name-for-it-1"
    const twin = "feature-with-a-really-long-name-for-it-2"
    await storage.createBranchNamespace(long)
    await storage.createBranchNamespace(twin)

    expect(await storage.listBranchNamespaces()).toEqual([long, twin])
    expect(await storage.openBranchNamespace(long)).not.toBeNull()
    expect(String(await storage.createBranchNamespace(long).catch((error) => error))).toContain(
      "exists already"
    )
  } finally {
    await storage.close()
    await disposeTestStorage(created)
  }
}, 60_000)

// Reproduce: drop the roots' flush before a flush of `ontology_source_rows` in PgSnapshotLoad:
// the rows' 8 MB fill first, and their COPY reaches roots not copied yet.
test("a source whose rows pass a COPY batch before its roots do loads whole", async () => {
  const storage = await testStorage()
  try {
    const branch = await storage.createBranchNamespace("large-source")
    // Each root asserts one object with a long note: its row is about 8 times its root.
    const note = "n".repeat(800)
    const roots = Array.from({ length: 12_000 }, (_, index) => {
      const ref = { objectTypeId: "Thing", primaryId: `t-${String(index).padStart(6, "0")}` }
      return {
        projectionId: "things",
        materializationId: "snapshot_things",
        rootKey: JSON.stringify(["object", ref.objectTypeId, ref.primaryId]),
        root: { kind: "object" as const, ref },
        stagingOrdinal: index,
        assertions: [{ kind: "object" as const, ref, properties: { note } }],
      }
    })
    await load(branch, {
      sources: [
        {
          projectionId: "things",
          materializationId: "snapshot_things",
          datasetVersion: { datasetId: "things", versionId: "v1", createdAt: at },
          projectionRevision: "revision",
          ownershipHash: "ownership",
          ontologyRevision: "ontology",
        },
      ],
      sourceRoots: roots,
    })

    const active = await branch.ontology.sources.getActive({
      projectId: PROJECT,
      source: { projectionId: "things" },
    })
    expect(active).toMatchObject({ status: "active", rootCount: 12_000, assertionCount: 12_000 })
  } finally {
    await disposeTestStorage(storage)
  }
}, 60_000)

// Red check: in readPgLinkEditsOf, leave legacy slots in the query and drop them after it: a page
// of them comes back empty, and the export stops reading link edits there.
test("a page of slots an old migration left in conflict does not end the link edits", async () => {
  const storage = await testStorage()
  try {
    await withClient(storage, undefined, async (sql) => {
      for (const [id, kind] of [
        ["a", "legacy-conflict"],
        ["b", "legacy-conflict"],
        ["c", "legacy-conflict"],
        ["d", "clear"],
      ] as const) {
        const value =
          kind === "clear" ? { kind, target: { objectTypeId: "Thing", primaryId: "x" } } : { kind }
        await sql`
          INSERT INTO ontology_link_overrides (project_id, identity_kind, identity_key,
            source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, value,
            last_commit_id, updated_at)
          VALUES (${PROJECT}, 'slot', ${sql.json(["Thing", id, "owner"])}, 'Thing', ${id},
            'owner', 'Thing', 'x', ${sql.json(value)}, 'c', ${at})
        `
      }
    })

    const page = await storage.readSnapshot({ views: 1, maxDurationMs: 60_000 }, ([view]) =>
      view!.readLinkEdits({ projectId: PROJECT, sourceTypeId: "Thing", limit: 3 })
    )
    expect(page.map((edit) => (edit.kind === "slot" ? edit.source.primaryId : ""))).toEqual(["d"])
  } finally {
    await disposeTestStorage(storage)
  }
}, 60_000)
