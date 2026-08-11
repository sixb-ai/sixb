import { describe, expect, test } from "bun:test"
import type {
  AuthorizationContext,
  ObjectProjectionDefinition,
  OntologySource,
  Sixb,
} from "@sixb/core"
import {
  emptyGrantIndex,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  Sixb as SixbRuntime,
} from "@sixb/core"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import type {
  ListLatestProjectionRunsInput,
  ListProjectionRunsInput,
  ObjectProjectionRunRecord,
  ProjectionRunRecord,
  ProjectionRunStorage,
} from "@sixb/core/storage"
import { Elysia } from "elysia"
import { registerProjectionRoutes } from "../src/routes/projections"

const roomsProjection: ObjectProjectionDefinition = {
  _tag: "ObjectProjectionDefinition",
  id: "rooms",
  objectTypeId: "room",
  datasetId: "ds.rooms",
  properties: { id: "room_id" },
  links: {},
}

const sensorsProjection: ObjectProjectionDefinition = {
  _tag: "ObjectProjectionDefinition",
  id: "sensors",
  objectTypeId: "sensor",
  datasetId: "ds.sensors",
  properties: { id: "sensor_id" },
  links: {},
}

function makeRun(
  input: {
    readonly run?: Partial<ObjectProjectionRunRecord>
    readonly projectionId?: string
    readonly objectTypeId?: string
  } = {}
): ObjectProjectionRunRecord {
  return {
    id: "run-1",
    projectId: "my-app",
    identity: {
      projectionId: input.projectionId ?? "rooms",
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion: {
        datasetId: "ds.rooms",
        versionId: "ver_1",
        createdAt: "2026-05-04T08:00:00.000Z",
      },
      ontologyRevision: "ontology-revision",
      projectionRevision: "projection-revision",
      ownershipHash: "ownership-hash",
    },
    target: { objectTypeId: input.objectTypeId ?? "room" },
    status: "succeeded",
    attempt: 2,
    startedAt: new Date("2026-05-04T09:00:00.000Z"),
    progress: { sourceRowsRead: 0, sourceRowsSkipped: 0 },
    ...input.run,
  }
}

function authzViewing(...objectTypeIds: string[]): AuthorizationContext {
  return {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "view:object": new Set(objectTypeIds) },
  }
}

function createSixbStub(
  projectionRuns: Partial<ProjectionRunStorage>
): Sixb<readonly OntologySource[]> {
  const storage = new InMemoryStorage()
  if (!storage.projectionRuns) throw new Error("Expected projection run storage")
  Object.assign(storage.projectionRuns, projectionRuns)

  const sixb = new SixbRuntime<readonly OntologySource[]>({
    id: "my-app",
    ontology: [],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const definitions = [roomsProjection, sensorsProjection]
  Object.defineProperty(sixb, "projections", {
    value: {
      list: () => definitions,
      listObjects: () => definitions,
      listLinks: () => [],
      listTelemetry: () => [],
      getById: (id: string) => definitions.find((projection) => projection.id === id) ?? null,
    },
  })
  return sixb
}

function appWithAuthz(sixb: Sixb<readonly OntologySource[]>, authz: AuthorizationContext | null) {
  const app = new Elysia()
  app.derive(({ request }) => ({
    sdk: bindRequestExecution(sixb, {
      request,
      authorization: authz ? { type: "principal", context: authz } : { type: "disabled" },
    }),
  }))
  return registerProjectionRoutes(app, sixb)
}

describe("projection routes", () => {
  test("list filters definitions by object.view and attaches latest runs", async () => {
    const requested: string[][] = []
    const sixb = createSixbStub({
      async listLatestByProjectionIds(input: ListLatestProjectionRunsInput) {
        requested.push([...input.projectionIds])
        return {
          runs: [makeRun({ run: { id: "run-rooms" }, projectionId: "rooms" })],
        }
      },
    })

    const app = appWithAuthz(sixb, authzViewing("room"))
    const response = await app.handle(new Request("http://localhost/api/projections"))
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      objectProjections: { id: string; latestRun: { id: string } | null }[]
    }

    // Only the room projection is visible; the latest-run lookup is scoped to it.
    expect(requested).toEqual([["rooms"]])
    expect(body.objectProjections.map((p) => [p.id, p.latestRun?.id ?? null])).toEqual([
      ["rooms", "run-rooms"],
    ])
  })

  test("run list passes the viewable object type set to storage", async () => {
    let captured = null as ListProjectionRunsInput | null
    const sixb = createSixbStub({
      async list(input: ListProjectionRunsInput) {
        captured = input
        return { runs: [makeRun()], hasMore: false, total: 1 }
      },
    })

    const app = appWithAuthz(sixb, authzViewing("room"))
    const response = await app.handle(
      new Request("http://localhost/api/projection-runs?projectionId=rooms")
    )
    expect(response.status).toBe(200)
    expect(captured?.objectTypeIds).toEqual(["room"])
    expect(captured?.projectionId).toBe("rooms")

    const body = (await response.json()) as { runs: { id: string }[]; total: number }
    expect(body.total).toBe(1)
    expect(body.runs[0]?.id).toBe("run-1")
  })

  test("serializes only the public run schema even if a provider returns internal fields", async () => {
    const internalRun = {
      ...makeRun({ run: { status: "running" } }),
      executionToken: "secret-capability",
      telemetryCheckpoint: {
        fixedBatchSize: 500,
        nextBatchOrdinal: 2,
        nextRowOffset: 1_000,
        inputExhausted: false,
      },
    } as unknown as ProjectionRunRecord
    const sixb = createSixbStub({
      async list() {
        return { runs: [internalRun], hasMore: false, total: 1 }
      },
    })

    const response = await appWithAuthz(sixb, authzViewing("room")).handle(
      new Request("http://localhost/api/projection-runs")
    )
    const body = (await response.json()) as { runs: Record<string, unknown>[] }

    expect(body.runs[0]).toMatchObject({ attempt: 2 })
    expect(body.runs[0]).not.toHaveProperty("executionToken")
    expect(body.runs[0]).not.toHaveProperty("telemetryCheckpoint")
    expect(body.runs[0]).toHaveProperty("identity.ontologyRevision", "ontology-revision")
  })

  test("run detail is hidden when the run's object type is not viewable", async () => {
    const sixb = createSixbStub({
      async getById() {
        return makeRun({ run: { id: "run-x" }, objectTypeId: "sensor" })
      },
    })

    const denied = await appWithAuthz(sixb, authzViewing("room")).handle(
      new Request("http://localhost/api/projection-runs/run-x")
    )
    expect(denied.status).toBe(404)

    const allowed = await appWithAuthz(sixb, authzViewing("sensor")).handle(
      new Request("http://localhost/api/projection-runs/run-x")
    )
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as { id: string }).id).toBe("run-x")
  })
})
