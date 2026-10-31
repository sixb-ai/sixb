import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LinkLineage,
  link,
  type ObjectLineage,
  prop,
  SixbHost,
  type SixbHostView,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { registerLinkRoutes } from "../src/routes/links"
import { registerObjectRoutes } from "../src/routes/objects"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// Devices a runtime write created and linked. Viewers read devices; outsiders read nothing. What
// each reader may see of a lineage is owned by core's object-lineage.test.ts; this proves the
// routes serve it, and hide what the reader cannot read.

const projectId = "object-lineage-routes"

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
  links: [link.self("peers", { cardinality: "many" })],
})

const viewers = defineGroup("viewers")
const viewer = defineRole("viewer", { grantedTo: [viewers], grants: [can.view(Device)] })

async function createApp() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Device],
    groups: [viewers],
    roles: [viewer],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" },
  })

  const trusted = createTestSixb(host)
  await trusted.objects(Device).upsert({ properties: { id: "dev-1", name: "Boiler" } })
  await trusted.objects(Device).upsert({ properties: { id: "dev-2", name: "Pump" } })
  await trusted.objects.upsertLink(Device.id, "dev-1", "peers", {
    targetTypeId: Device.id,
    targetId: "dev-2",
  })

  const callers = {
    viewer: await seedSession(storage, "usr_viewer", [viewers.id]),
    outsider: await seedSession(storage, "usr_outsider", []),
  }
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const get = (caller: keyof typeof callers, path: string) =>
    app.fetch(new Request(`http://localhost/api/objects${path}`, { headers: callers[caller] }))

  return { get }
}

async function seedSession(storage: InMemoryStorage, userId: string, groupIds: readonly string[]) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({ id: userId, projectId, email: `${userId}@acme.com` })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-10-31T10:00:00.000Z"),
    expiresAt: new Date("2099-10-31T10:00:00.000Z"),
  })
  return { cookie: `sixb_session_app=${credential.cookieValue}` }
}

const commit = expect.stringMatching(/^commit:/)
const edit = { kind: "edit", commitId: expect.any(String), committedAt: expect.any(String) }

describe("object lineage route", () => {
  test("explains an object the caller reads", async () => {
    const { get } = await createApp()

    const response = await get("viewer", "/Device/dev-1/lineage")

    expect(response.status).toBe(200)
    const lineage = await response.json()
    expect(lineage).toEqual({
      objectTypeId: Device.id,
      primaryId: "dev-1",
      existence: { source: commit },
      sources: {
        [lineage.existence.source]: expect.objectContaining(edit),
        identity: { kind: "identity" },
      },
      properties: { id: { source: "identity" }, name: { source: lineage.existence.source } },
      restricted: 0,
    })
  })

  test.each([
    ["an object the caller cannot read", "outsider", "/Device/dev-1/lineage"],
    ["a missing object", "viewer", "/Device/dev-9/lineage"],
    ["an unknown type", "viewer", "/Gadget/dev-1/lineage"],
  ] as const)("answers 404 for %s", async (_, caller, path) => {
    const { get } = await createApp()

    const response = await get(caller, path)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Object not found" })
  })
})

describe("link lineage route", () => {
  const peers = "/Device/dev-1/links/peers/lineage"

  test("explains a link the caller reads", async () => {
    const { get } = await createApp()

    const response = await get("viewer", `${peers}?targetTypeId=Device&targetId=dev-2`)

    expect(response.status).toBe(200)
    const lineage = await response.json()
    expect(lineage).toEqual({
      sourceTypeId: Device.id,
      sourceId: "dev-1",
      linkId: "peers",
      targetTypeId: Device.id,
      targetId: "dev-2",
      existence: { source: commit },
      sources: { [lineage.existence.source]: expect.objectContaining(edit) },
      restricted: 0,
    })
  })

  test.each([
    ["a link the caller cannot read", "outsider", "?targetTypeId=Device&targetId=dev-2"],
    ["a missing link", "viewer", "?targetTypeId=Device&targetId=dev-1"],
  ] as const)("answers 404 for %s", async (_, caller, search) => {
    const { get } = await createApp()

    const response = await get(caller, `${peers}${search}`)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Link not found" })
  })
})

describe("lineage response schemas", () => {
  // Every source kind and every optional field, so a schema that rejects or strips one fails here.
  const objectLineage = {
    objectTypeId: Device.id,
    primaryId: "dev-1",
    existence: { source: "projection:devices" },
    sources: {
      "projection:devices": {
        kind: "projection",
        projectionId: "devices",
        projectionRunId: "projection-run",
        datasetVersion: { datasetId: "devices", versionId: "ducklake:4" },
        rowOrigins: [{ datasetId: "raw_devices", column: "status" }],
      },
      "commit:c-2": {
        kind: "edit",
        commitId: "c-2",
        committedAt: "2026-10-31T10:02:00.000Z",
        requestedBy: { type: "user", id: "usr_operator" },
        executor: { type: "primitive", kind: "action", id: "rename", runId: "action-run" },
        action: { actionId: "rename", runId: "action-run" },
      },
      "commit@2026-10-31T10:03:00.000Z": {
        kind: "edit",
        commitId: null,
        committedAt: "2026-10-31T10:03:00.000Z",
      },
      "telemetry:c-4": {
        kind: "telemetry",
        commitId: "c-4",
        committedAt: "2026-10-31T10:04:00.000Z",
        projectionId: "readings",
        executor: { type: "primitive", kind: "projection", id: "readings", runId: "readings-run" },
      },
      identity: { kind: "identity" },
    },
    properties: {
      id: { source: "identity" },
      name: {
        source: "commit:c-2",
        replaced: { source: "projection:devices", column: "name", value: "Boiler" },
        resolution: {
          strategy: "mostRecent",
          sourceUpdatedAt: "2026-10-31T10:01:00.000Z",
          editedAt: "2026-10-31T10:02:00.000Z",
        },
      },
      note: {
        source: "projection:devices",
        column: "note",
        origins: [{ datasetId: "raw_devices", column: "note" }],
        removed: true,
        replaced: { source: "commit@2026-10-31T10:03:00.000Z" },
        resolution: { strategy: "editsWin" },
      },
      temperature: { source: "telemetry:c-4", at: "2026-10-31T10:04:00.000Z" },
    },
    restricted: 2,
  } satisfies ObjectLineage
  const linkLineage = {
    sourceTypeId: Device.id,
    sourceId: "dev-1",
    linkId: "peers",
    targetTypeId: Device.id,
    targetId: "dev-2",
    existence: {
      source: "projection:device-peers",
      columns: ["device_id", "peer_id"],
      origins: [{ datasetId: "raw_peers", column: "peer" }],
    },
    sources: {
      "projection:device-peers": { kind: "projection", projectionId: "device-peers" },
    },
    restricted: 1,
  } satisfies LinkLineage

  function createStubApp() {
    const objectSet = { lineage: async () => objectLineage, linkLineage: async () => linkLineage }
    const objects = Object.assign(() => objectSet, { getTypeById: () => Device })
    const host = {} as SixbHostView
    const app = new Elysia()
    app.derive(() => ({ sixb: { objects } }))

    registerObjectRoutes(app, host)
    registerLinkRoutes(app, host)
    return app
  }

  test.each([
    ["an object", "/Device/dev-1/lineage", objectLineage],
    ["a link", "/Device/dev-1/links/peers/lineage?targetTypeId=Device&targetId=dev-2", linkLineage],
  ] as const)("serve %s's lineage whole", async (_, path, lineage) => {
    const response = await createStubApp().handle(
      new Request(`http://localhost/api/objects${path}`)
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(lineage)
  })
})
