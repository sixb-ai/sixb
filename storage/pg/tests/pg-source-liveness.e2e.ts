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
