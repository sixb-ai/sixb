import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

/**
 * A storage whose connection probe refuses, the way a Postgres pool does when the host
 * is not there. `sixb check` has to report it and exit non-zero.
 */
class UnreachableStorage extends InMemoryStorage {
  override async ping(): Promise<void> {
    throw new Error("connect ECONNREFUSED 127.0.0.1:5432")
  }
}

export const sixb = new SixbHost({
  id: "cli-check-unreachable",
  ontology: [Room],
  broker: new InMemoryBroker(),
  storage: new UnreachableStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})
