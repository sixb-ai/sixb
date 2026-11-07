import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetVersion,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryStorage,
  OntologyRegistry,
  prop,
} from "../src"
import { createTestingScope } from "../src/execution/scopes"
import {
  createOntologyMaterializer,
  ProjectionRegistry,
  type ProjectionSourceReplacement,
} from "../src/materializer"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { startTestSyncRun } from "../src/testing"
import { atomic, claimProjectionExecution, entries, projectionScope } from "./materializer-fixture"

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
  ],
})

const customersDataset = defineDataset("customers", {
  schema: [col("id", "string"), col("name", "string")],
})

const whenMissingRemoveProjection = defineProjection("customers", Customer)
  .fromDataset(customersDataset)
  .properties({ id: "id", name: "name" })
  .whenMissing("remove")

const defaultProjection = defineProjection("customers", Customer)
  .fromDataset(customersDataset)
  .properties({ id: "id", name: "name" })

const customerRef = (primaryId: string) => ({ objectTypeId: "Customer", primaryId })

interface MockLakeVersion {
  readonly datasetId: string
  readonly versionId: string
  readonly mode: "snapshot"
  readonly createdAt: Date
  readonly producer?: { readonly kind: "sync"; readonly runId: string }
}

function createCustomerFixture(options: {
  readonly whenMissing?: "remove"
  readonly lakeVersions?: Map<string, MockLakeVersion>
}) {
  const ontology = new OntologyRegistry({ sources: [Customer] })
  const projection =
    options.whenMissing === "remove" ? whenMissingRemoveProjection : defaultProjection
  const projections = new ProjectionRegistry({
    projections: [projection],
    ontology,
    datasetsById: new Map([[customersDataset.id, customersDataset]]),
  })
  const storage = new InMemoryStorage()
  const lakeStorage = {
    getVersion: async (datasetId: string, versionId: string): Promise<DatasetVersion | null> =>
      (options.lakeVersions?.get(`${datasetId}:${versionId}`) as unknown as DatasetVersion) ?? null,
  }

  let clockTime = new Date("2026-05-01T12:00:00.000Z")
  const baseMaterializer = createOntologyMaterializer({
    projectId: "project",
    ontology,
    projections,
    storage,
    lakeStorage,
    dependencies: {
      clock: () => clockTime,
    },
  })
  const runtimeMaterializer = baseMaterializer.withScope(
    createTestingScope({
      projectId: "project",
      executionId: "customer-execution",
      requestId: "customer-request",
      correlationId: "customer-correlation",
    })
  )

  const materializerFixture = {
    edits: runtimeMaterializer.edits,
    projections: {
      async replace(request: ProjectionSourceReplacement) {
        const scope = await projectionScope(storage, {
          projectId: "project",
          projectionId: request.source.projectionId,
          runId: request.execution.projectionRunId,
        })
        return baseMaterializer.withScope(scope).projections.replace(request)
      },
    },
  }

  return {
    ontology,
    projections,
    storage,
    materializer: materializerFixture,
    setClock: (time: Date) => {
      clockTime = time
    },
  }
}

describe("projections with .whenMissing('remove')", () => {
  test("builder records whenMissingPolicy remove", () => {
    expect(whenMissingRemoveProjection.whenMissingPolicy).toBe("remove")
    expect(defaultProjection.whenMissingPolicy).toBeUndefined()
  })

  test("removes action-created object when missing from source read after create", async () => {
    const lakeVersions = new Map<string, MockLakeVersion>()
    const fixture = createCustomerFixture({ whenMissing: "remove", lakeVersions })

    // 1. Action creates "Acme Co" at 10:05:00
    fixture.setClock(new Date("2026-05-01T10:05:00.000Z"))
    await fixture.materializer.edits.commit(
      atomic("action-create-1", [
        {
          id: "create-acme",
          kind: "object.create",
          ref: customerRef("acme"),
          properties: { name: "Acme Co" },
        },
      ])
    )

    // Verify object exists initially
    const createdObject = await fixture.storage.objects.getByPrimaryId({
      projectId: "project",
      objectTypeId: "Customer",
      primaryId: "acme",
    })
    expect(createdObject?.properties.name).toBe("Acme Co")

    // 2. Sync runs: read started at 10:10:00 (AFTER create at 10:05:00)
    await startTestSyncRun(fixture.storage, {
      id: "sync-run-1",
      projectId: "project",
      syncId: "customers-sync",
      datasetId: "customers",
      mode: "snapshot",
      startedAt: new Date("2026-05-01T10:10:00.000Z"),
    })

    const datasetVersion = {
      datasetId: "customers",
      versionId: "v1",
      createdAt: "2026-05-01T10:12:00.000Z",
    }
    lakeVersions.set("customers:v1", {
      datasetId: "customers",
      versionId: "v1",
      mode: "snapshot",
      createdAt: new Date("2026-05-01T10:12:00.000Z"),
      producer: { kind: "sync", runId: "sync-run-1" },
    })

    // 3. Projection replaces with dataset that DOES NOT contain "acme"
    const execution = await claimProjectionExecution(fixture.storage, fixture.projections, {
      runId: "proj-run-1",
      projectionId: "customers",
      protocol: "replacement",
      datasetVersion,
    })
    fixture.setClock(new Date("2026-05-01T10:15:00.000Z"))
    const result = await fixture.materializer.projections.replace({
      source: { projectionId: "customers" },
      datasetVersion,
      execution,
      entries: entries([]), // empty dataset: "acme" is absent!
    })

    expect(result.created).toBe(true)

    // 4. Object must be REMOVED!
    const afterSync = await fixture.storage.objects.getByPrimaryId({
      projectId: "project",
      objectTypeId: "Customer",
      primaryId: "acme",
    })
    expect(afterSync).toBeNull()

    // 5. Override must also be deleted from storage
    const overrides = [
      ...getInMemoryOntologyStorageTestingAdapter(fixture.storage.ontology)
        .snapshot()
        .objectOverrides.values(),
    ]
    expect(overrides).toHaveLength(0)
  })

  test("safeguard: keeps action-created object when source read started BEFORE create", async () => {
    const lakeVersions = new Map<string, MockLakeVersion>()
    const fixture = createCustomerFixture({ whenMissing: "remove", lakeVersions })

    // 1. Action creates object at 10:15:00
    fixture.setClock(new Date("2026-05-01T10:15:00.000Z"))
    await fixture.materializer.edits.commit(
      atomic("action-create-2", [
        {
          id: "create-acme",
          kind: "object.create",
          ref: customerRef("acme"),
          properties: { name: "Acme Co" },
        },
      ])
    )

    // 2. Sync had started reading at 10:10:00 (BEFORE the create at 10:15:00)
    await startTestSyncRun(fixture.storage, {
      id: "sync-run-old",
      projectId: "project",
      syncId: "customers-sync",
      datasetId: "customers",
      mode: "snapshot",
      startedAt: new Date("2026-05-01T10:10:00.000Z"),
    })

    const datasetVersion = {
      datasetId: "customers",
      versionId: "v-old",
      createdAt: "2026-05-01T10:16:00.000Z",
    }
    lakeVersions.set("customers:v-old", {
      datasetId: "customers",
      versionId: "v-old",
      mode: "snapshot",
      createdAt: new Date("2026-05-01T10:16:00.000Z"),
      producer: { kind: "sync", runId: "sync-run-old" },
    })

    // 3. Projection replaces with dataset missing "acme"
    const execution = await claimProjectionExecution(fixture.storage, fixture.projections, {
      runId: "proj-run-old",
      projectionId: "customers",
      protocol: "replacement",
      datasetVersion,
    })
    await fixture.materializer.projections.replace({
      source: { projectionId: "customers" },
      datasetVersion,
      execution,
      entries: entries([]),
    })

    // 4. Object must be KEPT because the sync hadn't caught up!
    const afterSync = await fixture.storage.objects.getByPrimaryId({
      projectId: "project",
      objectTypeId: "Customer",
      primaryId: "acme",
    })
    expect(afterSync?.properties.name).toBe("Acme Co")
  })

  test("backward compatibility: keeps action-created object when projection lacks .whenMissing('remove')", async () => {
    const lakeVersions = new Map<string, MockLakeVersion>()
    const fixture = createCustomerFixture({ lakeVersions })

    // 1. Action creates object at 10:05:00
    fixture.setClock(new Date("2026-05-01T10:05:00.000Z"))
    await fixture.materializer.edits.commit(
      atomic("action-create-3", [
        {
          id: "create-acme",
          kind: "object.create",
          ref: customerRef("acme"),
          properties: { name: "Acme Co" },
        },
      ])
    )

    // 2. Sync read after create at 10:10:00
    await startTestSyncRun(fixture.storage, {
      id: "sync-run-compat",
      projectId: "project",
      syncId: "customers-sync",
      datasetId: "customers",
      mode: "snapshot",
      startedAt: new Date("2026-05-01T10:10:00.000Z"),
    })

    const datasetVersion = {
      datasetId: "customers",
      versionId: "v-compat",
      createdAt: "2026-05-01T10:12:00.000Z",
    }
    lakeVersions.set("customers:v-compat", {
      datasetId: "customers",
      versionId: "v-compat",
      mode: "snapshot",
      createdAt: new Date("2026-05-01T10:12:00.000Z"),
      producer: { kind: "sync", runId: "sync-run-compat" },
    })

    // 3. Projection replaces without "acme"
    const execution = await claimProjectionExecution(fixture.storage, fixture.projections, {
      runId: "proj-run-compat",
      projectionId: "customers",
      protocol: "replacement",
      datasetVersion,
    })
    await fixture.materializer.projections.replace({
      source: { projectionId: "customers" },
      datasetVersion,
      execution,
      entries: entries([]),
    })

    // 4. Object must be KEPT (old behavior preserved!)
    const afterSync = await fixture.storage.objects.getByPrimaryId({
      projectId: "project",
      objectTypeId: "Customer",
      primaryId: "acme",
    })
    expect(afterSync?.properties.name).toBe("Acme Co")
  })
})
