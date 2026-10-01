import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  migrateStorage,
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
import { SqliteStorage } from "../src"
import { sqliteStoragePath } from "../src/migrations"

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

let directory: string
let storage: SqliteStorage
let db: Database

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-source-liveness-"))
  storage = new SqliteStorage({ path: directory })
  await migrateStorage(storage)
  db = new Database(sqliteStoragePath(directory))
  // Records every rewrite of a root, whichever connection makes it.
  db.exec(`
    CREATE TABLE test_root_writes (root_id INTEGER NOT NULL);
    CREATE TRIGGER test_record_root_writes AFTER UPDATE ON ontology_source_roots
    BEGIN INSERT INTO test_root_writes VALUES (NEW.id); END;
  `)
})

afterEach(async () => {
  db.close()
  await storage.close()
  await rm(directory, { recursive: true, force: true })
})

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
    const execution = await storage.executions.getById({
      projectId: host.id,
      id: claim.run.executionId,
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
  const roots = () =>
    db
      .query(`SELECT versions.dataset_version_id AS version, roots.root_key AS key, roots.deleted,
        roots.retired_at IS NULL AND roots.deleted = 0
          AND versions.status IN ('active', 'superseded') AS live,
        EXISTS (SELECT 1 FROM test_root_writes WHERE root_id = roots.id) AS written
      FROM ontology_source_roots AS roots JOIN ontology_sources AS versions USING (version_id)
      ORDER BY versions.version_id, roots.root_key`)
      .all()
  const key = (id: string) => `["object","Device","${id}"]`

  await publish([device("a", "A"), device("b", "B"), device("c", "C")])
  expect(roots()).toEqual(
    ["a", "b", "c"].map((id) => ({ version: "v1", key: key(id), deleted: 0, live: 1, written: 0 }))
  )

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
  expect(roots()).toEqual([
    { version: "v1", key: key("a"), deleted: 0, live: 0, written: 1 },
    { version: "v1", key: key("b"), deleted: 0, live: 1, written: 0 },
    { version: "v1", key: key("c"), deleted: 0, live: 0, written: 1 },
    { version: "v2", key: key("a"), deleted: 0, live: 1, written: 0 },
    { version: "v2", key: key("c"), deleted: 1, live: 0, written: 1 },
    { version: "v2", key: key("d"), deleted: 0, live: 1, written: 0 },
  ])
  expect(
    db
      .query(`SELECT count(*) AS count FROM (
        SELECT roots.root_key FROM ontology_source_roots AS roots
        JOIN ontology_sources AS versions USING (version_id)
        WHERE roots.retired_at IS NULL AND roots.deleted = 0
          AND versions.status IN ('active', 'superseded')
        GROUP BY versions.project_id, versions.source_id, roots.root_key HAVING count(*) > 1
      )`)
      .get()
  ).toEqual({ count: 0 })
})

// Red proof: retire the candidate's roots in SqliteOntologySourceStorage.transitionToAbandoned.
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

  await storage.ontology.sources.abandon({
    kind: "candidate",
    ...input,
    abandonedAt: "2026-01-01T00:01:00.000Z",
  })
  expect(db.query("SELECT count(*) AS count FROM test_root_writes").get()).toEqual({ count: 0 })
  expect(
    db.query("SELECT count(*) AS count FROM ontology_source_roots WHERE retired_at IS NULL").get()
  ).toEqual({ count: 3 })

  await storage.ontology.sources.purgeAbandoned({ projectId: "p", limit: 100 })
  expect(db.query("SELECT count(*) AS count FROM ontology_source_roots").get()).toEqual({
    count: 0,
  })
  expect(db.query("SELECT count(*) AS count FROM ontology_sources").get()).toEqual({ count: 0 })
})
