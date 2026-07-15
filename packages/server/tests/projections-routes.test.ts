import { describe, expect, test } from "bun:test"
import type {
  AuthorizationContext,
  ObjectProjectionDefinition,
  OntologySource,
  Sixb,
} from "@sixb/core"
import type {
  ListLatestProjectionRunsInput,
  ListProjectionRunsInput,
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

function makeRun(overrides: Partial<ProjectionRunRecord>): ProjectionRunRecord {
  return {
    id: "run-1",
    projectId: "my-app",
    projectionId: "rooms",
    projectionKind: "object",
    datasetId: "ds.rooms",
    datasetVersionId: "ver_1",
    objectTypeId: "room",
    status: "succeeded",
    startedAt: new Date("2026-05-04T09:00:00.000Z"),
    rowsProcessed: 0,
    rowsSkipped: 0,
    objectsUpserted: 0,
    linksUpserted: 0,
    telemetryPointsAppended: 0,
    telemetryPointsSkipped: 0,
    telemetryRowsFailed: 0,
    ...overrides,
  }
}

function authzViewing(...objectTypeIds: string[]): AuthorizationContext {
  return {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: {
      "access:application": new Set(),
      "view:object": new Set(objectTypeIds),
      "view:dataset": new Set(),
      "apply:action": new Set(),
      "run:workflow": new Set(),
      "run:sync": new Set(),
      "run:pipeline": new Set(),
      "run:agent": new Set(),
      "observe:logs": new Set(),
    },
  }
}

function createSixbStub(
  projectionRuns: Partial<ProjectionRunStorage>
): Sixb<readonly OntologySource[]> {
  return {
    id: "my-app",
    storage: { projectionRuns },
    getObjectProjections: () => [roomsProjection, sensorsProjection],
    getLinkProjections: () => [],
    getTelemetryProjections: () => [],
    getProjectionById: (id: string) =>
      [roomsProjection, sensorsProjection].find((p) => p.id === id) ?? null,
  } as unknown as Sixb<readonly OntologySource[]>
}

function appWithAuthz(sixb: Sixb<readonly OntologySource[]>, authz: AuthorizationContext | null) {
  return registerProjectionRoutes(
    new Elysia().derive(() => ({ authz, scoped: null })) as unknown as Elysia,
    sixb
  )
}

describe("projection routes", () => {
  test("list filters definitions by object.view and attaches latest runs", async () => {
    const requested: string[][] = []
    const sixb = createSixbStub({
      async listLatestByProjectionIds(input: ListLatestProjectionRunsInput) {
        requested.push([...input.projectionIds])
        return { runs: [makeRun({ id: "run-rooms", projectionId: "rooms" })] }
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
        return { runs: [makeRun({})], hasMore: false, total: 1 }
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

  test("run detail is hidden when the run's object type is not viewable", async () => {
    const sixb = createSixbStub({
      async getById() {
        return makeRun({ id: "run-x", objectTypeId: "sensor" })
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
