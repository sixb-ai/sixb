import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
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

/** A client on a test storage's database, closed after `run`: as the role, when one is given. */
async function withClient<T>(
  storage: PostgresStorage,
  schema: string | undefined,
  run: (sql: ReturnType<typeof createPgClient>) => Promise<T>,
  role?: { readonly name: string; readonly password: string }
): Promise<T> {
  const connection = connections.get(storage)
  if (!connection) throw new Error("Expected a test storage.")

  const url = new URL(connection.url)
  if (role) {
    url.username = role.name
    url.password = role.password
  }
  const sql = createPgClient({
    connectionString: url.toString(),
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

/** The tables a snapshot fills, and the members, each row without its commit's id. */
const COPIED_TABLES = [
  "objects",
  "links",
  "ontology_object_overrides",
  "ontology_link_overrides",
  "timeseries",
  "timeseries_latest",
  "object_unique_values",
  "object_unique_properties",
  "object_artifact_refs",
  "object_vectors",
  "auth_users",
  "auth_group_memberships",
]

const branchSchema = (namespace: string) => `sixb_test_branch_${namespace.replaceAll("-", "_")}`

/** The role each test storage's namespaces are handed to, as a hosted branch's would be. */
const roles = new WeakMap<PostgresStorage, { readonly name: string; readonly password: string }>()

/**
 * As the role: empty every table, then fail any statement writing to one, naming who ran it. A
 * trigger runs with the privileges of whoever writes, which is why production writes there no
 * more.
 */
const PLANT = `
  DO $$ BEGIN
    EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ', ')
      FROM pg_tables WHERE schemaname = current_schema());
  END $$;
  CREATE FUNCTION planted() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION 'planted trigger ran as %', current_user; END
  $f$;
  DO $$ DECLARE t record; BEGIN
    FOR t IN SELECT relname FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
        AND NOT relispartition
    LOOP
      EXECUTE format('CREATE TRIGGER planted BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I '
        'FOR EACH STATEMENT EXECUTE FUNCTION planted()', t.relname);
    END LOOP;
  END $$;
`

runSnapshotLoadContractSuite("PostgreSQL storage", {
  createStorage: testStorage,
  cleanup: (storage) => disposeTestStorage(storage),
  roles: {
    handOver: async (storage, namespace) => {
      let role = roles.get(storage)
      if (!role) {
        role = { name: `sixb_test_role_${randomBytes(6).toString("hex")}`, password: "branch" }
        roles.set(storage, role)
        await withClient(storage, "public", async (sql) => {
          await sql.unsafe(`CREATE ROLE ${role!.name} LOGIN PASSWORD '${role!.password}'`)
          await sql.unsafe(`GRANT ${role!.name} TO CURRENT_USER`)
        })
      }
      await storage.handOverBranchNamespace(namespace, role.name)
    },
    plant: (storage, namespace) =>
      withClient(
        storage,
        branchSchema(namespace),
        async (sql) => {
          await sql.unsafe(PLANT)
        },
        roles.get(storage)
      ),
    write: (storage, namespace) =>
      withClient(
        storage,
        branchSchema(namespace),
        async (sql) => {
          await sql`DELETE FROM objects`
        },
        roles.get(storage)
      ),
    cleanup: async (storage) => {
      const role = roles.get(storage)
      if (!role) return
      await withClient(storage, "public", async (sql) => {
        await sql.unsafe(`DROP OWNED BY ${role.name}`)
        await sql.unsafe(`DROP ROLE ${role.name}`)
      })
    },
  },
  rows: (storage, namespace) =>
    withClient(storage, branchSchema(namespace), async (sql) => {
      const rows: Record<string, unknown[]> = {}
      for (const table of COPIED_TABLES) {
        const found = await sql.unsafe<{ row: string }[]>(
          `SELECT (to_jsonb(t) - 'last_commit_id' - 'prepared_at')::text AS row FROM ${table} AS t`
        )
        rows[table] = found.map((entry) => entry.row).sort()
      }

      // And the keys and indexes a copy drops while it runs, every one of them back. A foreign
      // key to a partitioned table numbers the copies it makes for its partitions. Reproduce:
      // skip the partitions' keys in the copy's finish, and the copy's keys differ.
      const schema = branchSchema(namespace)
      const indexes = await sql<{ definition: string }[]>`
        SELECT replace(indexdef, ${`${schema}.`}, '') AS definition FROM pg_indexes
        WHERE schemaname = ${schema}`
      const keys = await sql<{ definition: string }[]>`
        SELECT conrelid::regclass::text || ' ' || regexp_replace(conname, '_fkey[0-9]+$', '_fkey')
          || ' ' || pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace = ${schema}::regnamespace`
      rows.indexes = indexes.map((entry) => entry.definition).sort()
      rows.keys = keys.map((entry) => entry.definition).sort()
      return rows
    }),
})

const PROJECT = "pg-load"
const at = "2026-01-01T00:00:00.000Z"

/** A base commit for a branch, with the execution it needs. */
async function baseCommit(branch: BranchNamespace, id: string) {
  const operation = { type: "ontology.loadSnapshot", snapshotId: id } as const
  await branch.executions.create({
    id: `exec_${id}`,
    projectId: PROJECT,
    executor: { type: "kernel", operation },
    source: { type: "http", requestId: id },
    correlationId: id,
    authorizationRef: { type: "kernel", operation },
  })

  return {
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
  } as const
}

/** Load `batch` into a branch through its loader. */
async function load(branch: BranchNamespace, batch: SnapshotLoadBatch, id = "snapshot_pg") {
  return branch.loadSnapshot(
    {
      projectId: PROJECT,
      commit: await baseCommit(branch, id),
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

/** What a branch schema holds: its indexes and keys, its objects and its comment. */
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
    const keys = await sql<{ name: string }[]>`
      SELECT conrelid::regclass::text || ' ' || conname AS name FROM pg_constraint
      WHERE connamespace = ${schema}::regnamespace AND (contype <> 'f' OR conparentid = 0)
      ORDER BY 1`
    // A load lays out each type's partition first, and keeps it: it holds no row. A foreign key
    // to the partitioned objects has a copy per partition.
    const kept = (rows: { name: string }[]) =>
      rows.map((row) => row.name).filter((name) => !/objects_[0-9a-f]{20}/.test(name))
    return { indexes: kept(indexes), keys: kept(keys), objects: objects?.count, ...comment }
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

// Reproduce: let the copy's failure add again what its finish added already, and the cleanup fails
// on a key that exists, leaving the namespace marked and without its indexes.
test("a copy whose index build fails leaves the namespace as it was", async () => {
  const storage = await testStorage()
  try {
    const branch = (await storage.createBranchNamespace("failing-copy")) as PostgresStorage
    const schema = "sixb_test_branch_failing_copy"
    await withClient(storage, undefined, async (sql) => {
      for (const [sourceId, targetId] of [
        ["a", "b"],
        ["b", "a"],
      ]) {
        await sql`
          INSERT INTO links (project_id, source_type_id, source_id, link_id, target_type_id,
            target_id, created_at, updated_at, last_commit_id)
          VALUES (${PROJECT}, 'Thing', ${sourceId!}, 'next', 'Thing', ${targetId!}, ${at}, ${at},
            'production')`
      }
    })
    // An index no copy can build: both links share a link id. The keys are built before it.
    await withClient(storage, schema, async (sql) => {
      await sql`CREATE UNIQUE INDEX sixb_test_one_link ON links (link_id)`
    })
    const before = await schemaState(storage, schema)
    const commit = await baseCommit(branch, "snapshot_copy")

    const refused = await branch
      .copySnapshot({
        source: storage,
        projectId: PROJECT,
        maxDurationMs: 60_000,
        prepare: async () => ({
          commit,
          uniqueProperties: [],
          members: [],
          types: [
            {
              objectTypeId: "Thing",
              droppedPropertyIds: [],
              telemetryPropertyIds: [],
              uniquePropertyIds: [],
              artifactPropertyIds: [],
              links: [{ linkId: "next", targetTypeId: "Thing", identity: "edge" }],
              vectors: [],
            },
          ],
        }),
      })
      .catch((error: unknown) => error)
    expect(String(refused)).toContain("sixb_test_one_link")
    expect(await schemaState(storage, schema)).toEqual(before)
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
