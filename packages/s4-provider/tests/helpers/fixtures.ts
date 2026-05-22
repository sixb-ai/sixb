import {
  actionParam,
  col,
  defineAction,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  type OntologySource,
  Pario,
  type ParioOptions,
  prop,
  stringEnum,
} from "@pario/core"
import { createParioApi, ParioServer } from "@pario/server"
import { mount, S4Runtime } from "@s4/runtime"
import { createParioRemoteS4Provider, type ParioS4Fetch } from "../../src"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link("devices", "Device", { cardinality: "many" })],
})

export const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("manufacturer", "string"),
  ],
})

export const setMode = defineAction("setMode", {
  description: "Set the device mode.",
})
  .target(Device)
  .params({
    mode: actionParam(stringEnum(["cool", "heat", "off"]), { required: true }),
  })
  .run(async () => {})

export const rawDevicesDataset = defineDataset("raw.devices", {
  description: "Raw device inventory snapshots.",
  schema: [
    col("id", "string"),
    col("manufacturer", "string", {
      nullable: true,
    }),
  ],
})

const devicesConnector = defineConnector("devices-api", {
  type: "test",
  connect() {
    return { ok: true }
  },
})

export const syncDevices = defineSync("sync-devices", { mode: "append" })
  .from(devicesConnector)
  .read(() => [])
  .intoDataset(rawDevicesDataset)

export interface RequestLogEntry {
  readonly url: URL
  readonly request: Request
  readonly body: string
}

export interface S4TestHarness {
  readonly runtime: S4Runtime
  readonly pario: TestPario
  readonly versionId: string
  readonly requests: readonly RequestLogEntry[]
}

export type TestPario = Pario<readonly OntologySource[]>

interface OfflineParioApi {
  fetch(request: Request): Response | Promise<Response>
}

export async function createS4RouteHarness(): Promise<S4TestHarness> {
  const project = await createParioTestProject()
  const requests: RequestLogEntry[] = []
  const app = createOfflineParioApi(createOfflineParioServer(project.pario))

  return {
    ...project,
    requests,
    runtime: new S4Runtime({
      mounts: [
        mount(
          "/pario",
          createParioRemoteS4Provider({
            baseUrl: "http://pario.test",
            fetch: createOfflineFetch(app, requests),
          })
        ),
      ],
    }),
  }
}

export async function createParioTestProject(): Promise<{
  readonly pario: TestPario
  readonly versionId: string
}> {
  const lakeStorage = new InMemoryLakeStorage()
  const storage = new InMemoryStorage()
  const pario = createParioInstance({
    id: "s4-provider-contract-test",
    ontology: [Room, Device],
    actions: [setMode],
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    lakeStorage,
    storage,
    queues: new InMemoryQueues(),
    connectors: [devicesConnector],
    datasets: [rawDevicesDataset],
    syncs: [syncDevices],
  })

  await pario.upsertObject("Room", { id: "room-1", name: "Plant room" })
  await pario.upsertObject("Device", { id: "ac-123", manufacturer: "Panasonic" })
  await pario.upsertLink("Room", "room-1", "devices", {
    targetTypeId: "Device",
    targetId: "ac-123",
  })

  await lakeStorage.createDataset(rawDevicesDataset)
  const write = await lakeStorage.beginWrite({
    dataset: rawDevicesDataset,
    mode: "append",
    producer: {
      kind: "sync",
      id: "sync-devices",
      runId: "run-previous",
    },
  })
  await write.writeRows([{ id: "ac-123", manufacturer: "Panasonic" }])
  const version = await write.commit({ commitMessage: "previous device import" })

  await storage.syncRuns.start({
    id: "run-previous",
    projectId: pario.id,
    syncId: "sync-devices",
    datasetId: "raw.devices",
    mode: "append",
    startedAt: new Date("2026-02-18T09:00:00.000Z"),
    commitMessage: "previous device import",
  })
  await storage.syncRuns.finish({
    id: "run-previous",
    projectId: pario.id,
    status: "succeeded",
    finishedAt: new Date("2026-02-18T09:00:03.000Z"),
    rowsRead: 1,
    output: {
      datasetId: "raw.devices",
      versionId: version.versionId,
    },
  })

  return {
    pario,
    versionId: version.versionId,
  }
}

function createParioInstance(options: ParioOptions<readonly OntologySource[]>): TestPario {
  const ParioConstructor = Pario as unknown as new (
    options: ParioOptions<readonly OntologySource[]>
  ) => TestPario

  return new ParioConstructor(options)
}

function createOfflineParioApi(server: ParioServer): OfflineParioApi {
  return createParioApi(server) as unknown as OfflineParioApi
}

function createOfflineParioServer(pario: TestPario): ParioServer {
  const ParioServerConstructor = ParioServer as unknown as new (options: {
    readonly pario: unknown
    readonly quiet: boolean
    readonly ui: boolean
  }) => ParioServer

  return new ParioServerConstructor({ pario, quiet: true, ui: false })
}

function createOfflineFetch(app: OfflineParioApi, requests: RequestLogEntry[]): ParioS4Fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = await request.clone().text()
    requests.push({ url: new URL(request.url), request, body })
    return await app.fetch(request)
  }
}
