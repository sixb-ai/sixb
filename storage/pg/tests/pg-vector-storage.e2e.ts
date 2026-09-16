import { describe, expect, mock, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  type EmbeddingModel,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  migrateStorage,
  OntologyRegistry,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  MaterializationConflictError,
  type OntologyEditCommit,
} from "@sixb/core/internal/materialization"
import { ProjectionRegistry } from "@sixb/core/internal/materializer"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import { defineMigrations } from "@sixb/core/storage"
import {
  createMaterializerTestFixture,
  createTestSixb,
  startTestProjectionRun,
} from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import { createPostgresMigrator, postgresStorageMigrations, quoteIdent } from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

const model: EmbeddingModel = {
  providerId: "test",
  modelId: "embedding-v1",
  definition: { kind: "embedding", providerId: "test", modelId: "embedding-v1", dimensions: 3 },
  async embed({ texts }) {
    return { vectors: texts.map(() => [1, 0, 0]) }
  },
}
const Product = defineObjectType({
  id: "VectorProduct",
  name: "Product",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("description", "string"),
    prop("context", "string"),
    prop("status", "string"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  search: {
    vectors: {
      content: { source: ["title", "description"], model },
      context: { source: ["context"], model },
    },
  },
})
const ref = { objectTypeId: Product.id, primaryId: "a" }
const projectId = "vector-test"

function runtime(storage: PostgresStorage, embedding = model, id = projectId) {
  return createTestSixb({
    id,
    ontology: [Product],
    models: { embedding: [embedding] },
    storage,
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })
}
async function fixture(migrate = true) {
  const { storage, schemaName } = await createTestStorage({ migrate })
  const connectionString = process.env.DATABASE_URL!
  const sql = createPgClient({ connectionString, schemaName, max: 2 })
  const embed = mock(model.embed)
  const sixb = runtime(storage, { ...model, embed })
  const objects = sixb.objects(Product)
  return {
    storage,
    schemaName,
    connectionString,
    sql,
    embed,
    sixb,
    objects,
    handle: objects.byId("a").vector("content"),
    states: () => storage.ontology.vectors.list({ projectId, ref }),
    seed: () =>
      objects.upsert({
        properties: { id: "a", title: "Title", description: "Description", context: "Context" },
      }),
    async close() {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`)
      await sql.end()
      await storage.close()
    },
  }
}

// Each test owns its schema; the package's setup supplies an ordinary PostgreSQL server.
describe("PostgreSQL vector storage", () => {
  test("persists float32 values and metadata across connections without pgvector", async () => {
    const f = await fixture()
    try {
      const before = await f.seed()
      f.embed.mockResolvedValueOnce({ vectors: [[0.1, 0.2, 0.3]] })
      await f.handle.index()
      const [row] =
        await f.sql`SELECT embedding::double precision[] AS embedding, pg_typeof(embedding)::text AS type FROM object_vectors`
      expect(row?.embedding).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)])
      expect(row?.type).toBe("real[]")
      expect(await f.sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`).toHaveLength(0)
      const states = await f.states()
      expect(states).toHaveLength(1)
      expect(states[0]).not.toHaveProperty("values")
      expect(await f.objects.byId("a").get()).toEqual(before)
      await f.storage.close()
      const reopened = new PostgresStorage({
        connectionString: f.connectionString,
        schemaName: f.schemaName,
      })
      try {
        expect(await reopened.ontology.vectors.list({ projectId, ref })).toEqual(states)
        expect(await runtime(reopened).objects(Product).byId("a").get()).toEqual(before)
        expect(await reopened.ontology.vectors.list({ projectId: "another-project", ref })).toEqual(
          []
        )
      } finally {
        await reopened.close()
      }
    } finally {
      await f.close()
    }
  })

  test("source edits invalidate only affected profiles; delete/restore cannot resurrect vectors", async () => {
    // Regression proof: bypass invalidateVectorChanges in drainStagedWork; the source-edit assertion fails.
    const f = await fixture()
    try {
      await f.seed()
      await f.handle.index()
      await f.objects.byId("a").vector("context").index()
      const before = await f.states()
      await f.objects.upsert({ properties: { id: "a", status: "paused" } })
      await f.objects
        .byId("a")
        .telemetry(Product.p.temperature)
        .append({ value: 20, at: new Date("2026-01-01") })
      expect(await f.states()).toEqual(before)
      await f.objects.upsert({ properties: { id: "a", title: "Changed" } })
      expect((await f.states()).map((state) => state.profile)).toEqual(["context"])
      await f.objects.byId("a").delete()
      expect(await f.states()).toEqual([])
      await f.objects.byId("a").restore()
      expect(await f.states()).toEqual([])
      await f.objects.byId("a").delete()
      await f.seed()
      expect(await f.states()).toEqual([])
    } finally {
      await f.close()
    }
  })

  test("late computations reject object changes and newer vectors from another pool", async () => {
    const f = await fixture()
    const other = new PostgresStorage({
      connectionString: f.connectionString,
      schemaName: f.schemaName,
    })
    try {
      await f.seed()
      const objects = runtime(other).objects(Product)
      for (const change of [
        () => objects.byId("a").vector("content").index(),
        () => objects.upsert({ properties: { id: "a", title: "Changed" } }),
        async () => {
          await objects.byId("a").delete()
          await f.seed()
        },
      ]) {
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<{ vectors: number[][] }>()
        f.embed.mockImplementationOnce(() => {
          started.resolve()
          return release.promise
        })
        const pending = f.handle.index()
        await started.promise
        try {
          await change()
        } finally {
          release.resolve({ vectors: [[0, 1, 0]] })
        }
        await expect(pending).rejects.toBeInstanceOf(MaterializationConflictError)
      }
    } finally {
      await other.close()
      await f.close()
    }
  })

  test("competing inserts and updates accept exactly one result across pools", async () => {
    // Regression proof: remove the expected last_commit_id predicate in vectors.write.
    const f = await fixture()
    const other = new PostgresStorage({
      connectionString: f.connectionString,
      schemaName: f.schemaName,
    })
    try {
      await f.seed()
      for (const _existing of [false, true]) {
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<{ vectors: number[][] }>()
        let calls = 0
        const embedding = {
          ...model,
          embed: async () => {
            if (++calls === 2) started.resolve()
            return release.promise
          },
        }
        const handles = [f.storage, other].map((storage) =>
          runtime(storage, embedding).objects(Product).byId("a").vector("content")
        )
        const pending = handles.map((handle) => handle.index())
        await started.promise
        release.resolve({ vectors: [[1, 0, 0]] })
        const results = await Promise.allSettled(pending)
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
        expect(calls).toBe(2)
        expect(await f.states()).toHaveLength(1)
      }
    } finally {
      await other.close()
      await f.close()
    }
  })

  test("failed finalization rolls back reindexing, invalidation and object changes together", async () => {
    const f = await fixture()
    try {
      const beforeObject = await f.seed()
      await f.handle.index()
      const beforeVectors = await f.sql`SELECT * FROM object_vectors`
      await f.sql.unsafe(`CREATE FUNCTION fail_vector_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected finalization failure'; END $$;
        CREATE TRIGGER fail_vector_commit BEFORE INSERT ON ontology_commits
        FOR EACH ROW EXECUTE FUNCTION fail_vector_commit();`)
      f.embed.mockResolvedValueOnce({ vectors: [[0, 1, 0]] })
      await expect(f.handle.index()).rejects.toThrow("injected finalization failure")
      await expect(f.objects.upsert({ properties: { id: "a", title: "Changed" } })).rejects.toThrow(
        "injected finalization failure"
      )
      await expect(f.objects.byId("a").delete()).rejects.toThrow("injected finalization failure")
      expect(await f.objects.byId("a").get()).toEqual(beforeObject)
      expect([...(await f.sql`SELECT * FROM object_vectors`)]).toEqual([...beforeVectors])
    } finally {
      await f.close()
    }
  })

  test("raw mutations require an active session and metadata reads obey transaction scope", async () => {
    const f = await fixture()
    try {
      await f.seed()
      await f.handle.index()
      const [state] = await f.states()
      if (!state) throw new Error("Missing vector")
      await expect(
        f.storage.ontology.vectors.write({
          projectId,
          session: { providerToken: {} },
          expectedCommitId: state.lastCommitId,
          value: { ...state, values: [0, 1, 0] },
        })
      ).rejects.toThrow("session")
      await expect(
        f.storage.ontology.vectors.remove({
          projectId,
          ref,
          profile: "content",
          session: { providerToken: {} },
          expectedCommitId: state.lastCommitId,
        })
      ).rejects.toThrow("session")
      await f.storage.transaction(async (tx) => {
        expect(await tx.ontology.vectors?.list({ projectId, ref })).toEqual([state])
        await expect(f.states()).rejects.toThrow("Root storage")
      })
    } finally {
      await f.close()
    }
  })

  test("upgrades an existing schema without changing objects or promoting raw arrays", async () => {
    const f = await fixture(false)
    try {
      await createPostgresMigrator({
        sql: f.sql,
        schemaName: f.schemaName,
        migrations: defineMigrations({
          adapterId: postgresStorageMigrations.adapterId,
          steps: postgresStorageMigrations.steps.slice(0, -1),
        }),
      }).migrate()
      // Seed an actual pre-migration row; the old schema has no vector capability/table.
      await f.sql`INSERT INTO objects (project_id, object_type_id, primary_id, properties, version, last_commit_id, created_at, updated_at)
          VALUES (${projectId}, ${Product.id}, 'a', '{"id":"a","title":"Title","embedding":[1,0,0]}', 1, 'legacy', '2026-01-01', '2026-01-01')`
      const before = await f.sql`SELECT * FROM objects`
      await migrateStorage(f.storage)
      await migrateStorage(f.storage)
      expect([...(await f.sql`SELECT * FROM objects`)]).toEqual([...before])
      expect(await f.states()).toEqual([])
      await f.handle.index()
      expect(await f.states()).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  test("exact commit replay never duplicates or resurrects a vector", async () => {
    const f = await fixture()
    try {
      await f.seed()
      await f.handle.index()
      const [state] = await f.states()
      const row = await f.storage.objects.getByPrimaryId({ projectId, ...ref })
      if (!state || !row) throw new Error("Missing indexed object")
      const writer = createMaterializerTestFixture({
        projectId,
        storage: f.storage,
        ontology: new OntologyRegistry({ sources: [Product] }),
      })
      const expected = {
        ref,
        exists: true as const,
        version: row.version,
        lastCommitId: row.lastCommitId,
      }
      const command: OntologyEditCommit = {
        mode: "atomic",
        source: { kind: "runtime", requestId: "replay-vector" },
        operations: [],
        expectedObjects: [expected],
        expectedLinks: [],
        expectedLinkScopes: [],
        vectorWrites: [
          {
            input: {
              projectId,
              ref,
              profile: "content",
              configuration: state.configuration,
              text: f.embed.mock.calls[0]![0].texts[0]!,
              sourceFingerprint: state.sourceFingerprint,
              expectedObject: expected,
              expectedVectorCommitId: state.lastCommitId,
            },
            values: [0, 1, 0],
          },
        ],
      }
      const result = await writer.materializer.edits.commit(command)
      expect(await writer.materializer.edits.commit(command)).toEqual({ ...result, created: false })
      expect(await f.states()).toHaveLength(1)
      await f.objects.upsert({ properties: { id: "a", title: "New source" } })
      expect(await writer.materializer.edits.commit(command)).toEqual({ ...result, created: false })
      expect(await f.states()).toEqual([])
    } finally {
      await f.close()
    }
  })

  test("projection replacements invalidate effective changes and preserve overridden sources", async () => {
    const f = await fixture()
    try {
      const dataset = defineDataset("vector_products", {
        schema: [col("id", "string"), col("title", "string")],
      })
      const projection = defineProjection("vector_products", Product)
        .fromDataset(dataset)
        .properties({ id: "id", title: "title" })
      const ontology = new OntologyRegistry({ sources: [Product] })
      const projections = new ProjectionRegistry({
        projections: [projection],
        ontology,
        datasetsById: new Map([[dataset.id, dataset]]),
      })
      const host = new SixbHost({
        id: projectId,
        ontology: [Product],
        datasets: [dataset],
        projections: [projection],
        models: { embedding: [model] },
        storage: f.storage,
        broker: new InMemoryBroker(),
        blobStorage: new InMemoryBlobStorage(),
        lakeStorage: new InMemoryLakeStorage(),
        queues: new InMemoryQueues(),
      })
      const objects = createTestSixb(host).objects(Product)
      const resolved = projections.resolveSource(projection.id)
      async function replace(version: number, title: string) {
        const datasetVersion = {
          datasetId: dataset.id,
          versionId: `v${version}`,
          createdAt: `2026-01-0${version}T00:00:00.000Z`,
        }
        const runId = `projection-${version}`
        const claim = await startTestProjectionRun(f.storage, {
          projectId,
          id: runId,
          identity: {
            projectionId: projection.id,
            projectionKind: "object",
            protocol: "replacement",
            datasetVersion,
            ontologyRevision: projections.ontologyRevision,
            projectionRevision: resolved.projectionRevision,
            ownershipHash: resolved.ownershipHash,
          },
          target: { objectTypeId: Product.id },
        })
        const execution = await f.storage.executions.getById({
          projectId,
          id: claim.run.executionId,
        })
        if (!execution) throw new Error("Missing projection execution")
        const bound = bindDurablePrimitiveExecution(host, {
          execution,
          primitive: { kind: "projection", id: projection.id, runId },
        })
        return bound.ontologyMutations.replaceProjection({
          source: { projectionId: projection.id },
          datasetVersion,
          execution: claim.execution,
          entries: (async function* () {
            yield {
              root: { kind: "object" as const, ref },
              assertions: [{ kind: "object" as const, ref, properties: { title } }],
            }
          })(),
        })
      }
      await replace(1, "Alpha")
      await objects.byId("a").vector("content").index()
      await replace(2, "Beta")
      expect(await f.states()).toEqual([])
      await objects.upsert({ properties: { id: "a", title: "Override" } })
      await objects.byId("a").vector("content").index()
      const before = await f.states()
      await replace(3, "Gamma")
      expect(await f.states()).toEqual(before)
      expect((await objects.byId("a").get())?.properties.title).toBe("Override")
    } finally {
      await f.close()
    }
  })

  test("the database rejects malformed arrays and vector queries remain disabled", async () => {
    const f = await fixture()
    try {
      await f.seed()
      await f.handle.index()
      for (const values of [[], [0, 0, 0], [NaN, 1], [Infinity, 1], [-Infinity, 1], [null, 1]]) {
        await expect(
          Promise.resolve(
            f.sql`UPDATE object_vectors SET embedding = ${f.sql.array(values)}::real[]`
          )
        ).rejects.toThrow()
      }
      await expect(
        Promise.resolve(
          f.sql.unsafe("UPDATE object_vectors SET embedding = '{{1,2},{3,4}}'::real[]")
        )
      ).rejects.toThrow()
      await expect(
        f.objects.query().vector("content", [1, 0, 0], { k: 1 }).list()
      ).rejects.toThrow()
    } finally {
      await f.close()
    }
  })
})
