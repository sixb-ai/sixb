import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
  SixbHost,
} from "@sixb/core"
import type {
  ProjectionSourceDeletion,
  ProjectionSourceEntry,
} from "@sixb/core/internal/materialization"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import { createProjectionRunId, getProjectionRegistry } from "@sixb/core/internal/projections"
import { startTestProjectionRun } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { cleanupSourceVersions } from "../src/ontology-storage/source-cleanup"
import { createPgClient, type SQL } from "../src/pg-client"
import { createTestStorage } from "./helpers"

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
})
const devices = defineDataset("liveness.devices", {
  primaryKey: "id",
  schema: [col("id", "string"), col("name", "string")],
})
const projection = defineProjection("liveness-devices", Device)
  .fromDataset(devices)
  .properties({ id: "id", name: "name" })

let storage: PostgresStorage
let sql: SQL

beforeEach(async () => {
  const created = await createTestStorage()
  storage = created.storage
  sql = createPgClient({
    connectionString: process.env.DATABASE_URL!,
    schemaName: created.schemaName,
    max: 1,
  })
})

afterEach(async () => {
  await sql.end()
  await storage.dropSchema()
  await storage.close()
})

// A row keeps the transaction id that last wrote it (`xmin`), so a root whose xmin equals its
// version's was rewritten by the activation that flipped that version.
// Red proof: rewrite the candidate's roots in activateSourceRoots, even `SET deleted = deleted`.
test("activation writes only the roots it replaces and keeps one live root per key", async () => {
  const { publish, device } = await devicePublisher()
  const roots = () => sql`
    SELECT versions.dataset_version_id AS version, roots.root_key AS key, roots.deleted,
      roots.retired_at IS NULL AND NOT roots.deleted AND versions.status IN ('active', 'superseded')
        AS live,
      roots.xmin = versions.xmin AS written_by_activation
    FROM ontology_source_roots AS roots JOIN ontology_sources AS versions USING (version_id)
    ORDER BY versions.version_id, roots.root_key`
  const key = (id: string) => `["object","Device","${id}"]`

  await publish([device("a", "A"), device("b", "B"), device("c", "C")])
  expect(
    (await roots()).map(({ live, written_by_activation }) => [live, written_by_activation])
  ).toEqual([
    [true, false],
    [true, false],
    [true, false],
  ])

  await publish(
    [
      device("a", "A2"),
      {
        root: { kind: "object", ref: { objectTypeId: Device.id, primaryId: "c" } },
        deleted: true,
      },
      device("d", "D"),
    ],
    true
  )
  expect([...(await roots())]).toEqual([
    {
      version: "v1",
      key: key("a"),
      deleted: false,
      live: false,
      written_by_activation: true,
    },
    {
      version: "v1",
      key: key("b"),
      deleted: false,
      live: true,
      written_by_activation: false,
    },
    {
      version: "v1",
      key: key("c"),
      deleted: false,
      live: false,
      written_by_activation: true,
    },
    {
      version: "v2",
      key: key("a"),
      deleted: false,
      live: true,
      written_by_activation: false,
    },
    {
      version: "v2",
      key: key("c"),
      deleted: true,
      live: false,
      written_by_activation: true,
    },
    {
      version: "v2",
      key: key("d"),
      deleted: false,
      live: true,
      written_by_activation: false,
    },
  ])
  const [duplicates] = await sql`
    SELECT count(*)::int AS count FROM (
      SELECT roots.root_key FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions USING (version_id)
      WHERE roots.retired_at IS NULL AND NOT roots.deleted
        AND versions.status IN ('active', 'superseded')
      GROUP BY versions.project_id, versions.source_id, roots.root_key HAVING count(*) > 1
    ) AS duplicated`
  expect(duplicates?.count).toBe(0)
})

// Red proof: retire the candidate's roots in PgOntologySourceStorage.transitionToAbandoned.
test("abandoning a candidate writes none of its roots and purging removes them", async () => {
  const input = await stageCandidate()
  const written = () =>
    sql`SELECT xmin::text AS xmin, retired_at FROM ontology_source_roots ORDER BY root_key`
  const staged = [...(await written())]

  await storage.ontology.sources.abandon({
    kind: "candidate",
    ...input,
    abandonedAt: "2026-01-01T00:01:00.000Z",
  })
  expect([...(await written())]).toEqual(staged)
  expect(staged.every((root) => root.retired_at === null)).toBe(true)

  await storage.ontology.sources.purgeAbandoned({ projectId: "p", limit: 100 })
  const [left] = await sql`SELECT count(*)::int AS count FROM ontology_source_roots`
  expect(left?.count).toBe(0)
})

// Removal proof: drop PLAN_PURGED from purgeAbandonedSourceVersions; the purge then fails on the
// plan's foreign key instead of leaving the version for later.
test("purging keeps an abandoned version until its plan is gone", async () => {
  const input = await stageCandidate()
  await storage.ontology.sources.abandon({
    kind: "candidate",
    ...input,
    abandonedAt: "2026-01-01T00:01:00.000Z",
  })
  await sql`
    INSERT INTO ontology_replacement_plans (
      version_id, project_id, commit_id, committed_at, watermark
    ) SELECT version_id, project_id, 'commit', '2026-01-01T00:00:00.000Z', pg_current_snapshot()
    FROM ontology_sources
  `
  const versions = async () =>
    (await sql`SELECT count(*)::int AS count FROM ontology_sources`)[0]?.count

  await storage.ontology.sources.purgeAbandoned({ projectId: "p", limit: 100 })
  expect(await versions()).toBe(1)

  expect(await storage.ontology.replacementPlans.purge({ projectId: "p", limit: 100 })).toBe(1)
  await storage.ontology.sources.purgeAbandoned({ projectId: "p", limit: 100 })
  expect(await versions()).toBe(0)
})

// Removal proof: drop PLAN_PURGED from cleanupSourceVersions; the cleanup then fails on the
// plan's foreign key instead of leaving the version for later.
test("cleanup keeps a superseded version until its plan is gone", async () => {
  const { publish, device } = await devicePublisher()
  await publish([device("a", "A")])
  await publish([device("a", "A2")])
  const cleanup = () =>
    storage.ontology.sources.cleanupTerminal({
      projectId: "liveness",
      terminalBefore: "2100-01-01T00:00:00.000Z",
      limit: 100,
    })
  const statuses = async () =>
    (await sql`SELECT status FROM ontology_sources ORDER BY version_id`).map((row) => row.status)

  await cleanup()
  expect(await statuses()).toEqual(["superseded", "active"])

  await storage.ontology.replacementPlans.purge({ projectId: "liveness", limit: 1_000 })
  await cleanup()
  expect(await statuses()).toEqual(["active"])
})

// Removal proof: drop the root_count update from cleanupSourceVersions; v1 then outlives its roots.
test("cleanup deletes a superseded version once the roots it still holds are gone", async () => {
  const { publish, device } = await devicePublisher()
  const cleanup = async () => {
    await storage.ontology.replacementPlans.purge({ projectId: "liveness", limit: 1_000 })
    // One deletion a pass: a version's roots go over several passes.
    const pass = () =>
      storage.ontology.sources.cleanupTerminal({
        projectId: "liveness",
        terminalBefore: "2100-01-01T00:00:00.000Z",
        limit: 1,
      })
    while (Object.values(await pass()).some((deleted) => deleted > 0));
  }
  const versions = async () => [
    ...(await sql`SELECT dataset_version_id AS version, status, root_count::int AS roots
      FROM ontology_sources ORDER BY version_id`),
  ]

  await publish([device("a", "A"), device("b", "B")])
  await publish([device("a", "A2")], true)
  await cleanup()
  expect(await versions()).toEqual([
    { version: "v1", status: "superseded", roots: 1 },
    { version: "v2", status: "active", roots: 1 },
  ])

  await publish([device("b", "B2")], true)
  await cleanup()
  expect(await versions()).toEqual([
    { version: "v2", status: "superseded", roots: 1 },
    { version: "v3", status: "active", roots: 1 },
  ])
})

// Removal proof: select manifests by `NOT EXISTS` roots again; the pass then reads every
// superseded version and every root. Row visits avoid machine-dependent timing limits.
test("cleanup finds drained versions without reading those that still hold roots", async () => {
  await sql.unsafe(`
    INSERT INTO ontology_sources (project_id, source_id, materialization_id, projection_run_id,
      projection_kind, protocol, status, dataset_id, dataset_version_id, dataset_version_created_at,
      projection_revision, ownership_hash, ontology_revision, root_count, assertion_count,
      created_at, ready_at, activated_at, terminal_at, last_commit_id, updated_at)
    SELECT 'p', 'source', 'm' || i, 'run' || i, 'object', 'replacement', 'superseded', 'd', 'v',
      '2026-01-01Z', 'r', 'h', 'o', CASE WHEN i <= 2 THEN 0 ELSE 1 END,
      CASE WHEN i <= 2 THEN 0 ELSE 1 END, '2026-01-01Z', '2026-01-01Z', '2026-01-01Z',
      '2026-01-02Z', 'c', '2026-01-02Z'
    FROM generate_series(1, 20000) AS i`)
  await sql.unsafe(`INSERT INTO ontology_source_roots (version_id, project_id, root_key, staging_ordinal)
    SELECT version_id, 'p', 'key' || version_id, 0 FROM ontology_sources WHERE root_count = 1`)
  await sql.unsafe("ANALYZE ontology_sources, ontology_source_roots")
  const rollback = new Error("rollback synthetic cleanup")
  let visited = Number.NaN

  await sql
    .begin(async (tx) => {
      const observed = new Proxy(tx, {
        apply(target, thisArg, args: unknown[]) {
          const parts = args[0]
          if (!Array.isArray(parts) || !parts.join("").includes("DELETE FROM ontology_sources"))
            return Reflect.apply(target, thisArg, args)
          return (async () => {
            const query = Reflect.apply(target, thisArg, args) as ReturnType<SQL["unsafe"]>
            const rows = await target`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${query}`
            visited = visits((rows[0]?.["QUERY PLAN"] as readonly { Plan: PlanNode }[])[0]!.Plan)
            return Reflect.apply(target, thisArg, args)
          })()
        },
      })
      await cleanupSourceVersions(observed, {
        projectId: "p",
        terminalBefore: "2026-02-01T00:00:00.000Z",
        limit: 1_000,
      })
      throw rollback
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error
    })
  expect(visited).toBeLessThan(100)
}, 30_000)

interface PlanNode {
  readonly "Relation Name"?: string
  readonly "Actual Rows"?: number
  readonly "Actual Loops"?: number
  readonly "Rows Removed by Filter"?: number
  readonly Plans?: readonly PlanNode[]
}

/** Rows read from the source version and root tables, over the whole plan. */
function visits(node: PlanNode): number {
  const own = ["ontology_sources", "ontology_source_roots"].includes(node["Relation Name"] ?? "")
    ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
      (node["Actual Loops"] ?? 0)
    : 0
  return own + (node.Plans ?? []).reduce((total, child) => total + visits(child), 0)
}

/** Publishes the device projection the way a projection worker does, one dataset version a call. */
async function devicePublisher() {
  const host = new SixbHost({
    id: "liveness",
    ontology: [Device],
    datasets: [devices],
    projections: [projection],
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
  })
  await host.closeBroker()
  const source = { projectionId: projection.id }
  let published = 0
  // What a projection worker does once it has read its dataset: claim the run, then replace.
  const publish = async (
    entries: readonly (ProjectionSourceEntry | ProjectionSourceDeletion)[],
    delta = false
  ) => {
    const version = ++published
    const dispatch = getProjectionRegistry(host).resolveDispatch(projection.id)
    const datasetVersion = {
      datasetId: dispatch.datasetId,
      versionId: `v${version}`,
      createdAt: `2026-01-0${version}T00:00:00.000Z`,
    }
    const identity = {
      projectionId: projection.id,
      projectionKind: "object" as const,
      protocol: "replacement" as const,
      datasetVersion,
      ontologyRevision: dispatch.ontologyRevision,
      projectionRevision: dispatch.projectionRevision,
      ownershipHash: dispatch.ownershipHash,
    }
    const id = createProjectionRunId(host.id, identity)
    const claim = await startTestProjectionRun(storage, {
      projectId: host.id,
      id,
      identity,
      target: { objectTypeId: Device.id },
    })
    const run = await storage.projectionRuns.getById({ projectId: host.id, id })
    const execution = await storage.executions.getById({
      projectId: host.id,
      id: run!.executionId,
    })
    const { ontologyMutations } = bindDurablePrimitiveExecution(host, {
      execution: execution!,
      primitive: { kind: "projection", id: projection.id, runId: id },
    })
    const active = delta ? await ontologyMutations.getProjectionSource?.(source) : null
    await ontologyMutations.replaceProjection({
      source,
      datasetVersion,
      execution: claim.execution,
      entries: (async function* () {
        yield* entries
      })(),
      ...(active?.lastCommitId
        ? {
            base: {
              materializationId: active.materializationId,
              lastCommitId: active.lastCommitId,
            },
          }
        : {}),
    })
  }
  const device = (id: string, name: string): ProjectionSourceEntry => {
    const ref = { objectTypeId: Device.id, primaryId: id }
    return {
      root: { kind: "object", ref },
      assertions: [{ kind: "object", ref, properties: { id, name } }],
    }
  }
  return { publish, device }
}

/** A candidate staged with three roots, still owned by its run. */
async function stageCandidate() {
  const identity = {
    projectionId: "source",
    projectionKind: "object" as const,
    protocol: "replacement" as const,
    datasetVersion: {
      datasetId: "dataset",
      versionId: "v1",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    projectionRevision: "projection",
    ontologyRevision: "ontology",
    ownershipHash: "ownership",
  }
  const run = await startTestProjectionRun(storage, {
    projectId: "p",
    id: "run",
    identity,
    target: { objectTypeId: "Device" },
  })
  const input = {
    projectId: "p",
    source: { projectionId: "source" },
    materializationId: "candidate",
    execution: run.execution,
  }
  await storage.ontology.sources.beginMaterialization({
    ...input,
    ...identity,
    createdAt: identity.datasetVersion.createdAt,
  })
  await storage.ontology.sources.stageRows({
    ...input,
    rows: ["a", "b", "c"].map((primaryId, stagingOrdinal) => {
      const root = { kind: "object" as const, ref: { objectTypeId: "Device", primaryId } }
      return { root, stagingOrdinal, assertion: { ...root, properties: { id: primaryId } } }
    }),
  })
  return input
}
