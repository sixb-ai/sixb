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
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

// Simulates a client that reports itself closed while it keeps retrying a server it never
// reached — as a Redis client does when its server is unreachable — so a ref'd handle outlives
// `close()`.
setInterval(() => {}, 1_000)

const queues = Object.assign(new InMemoryQueues(), {
  async close() {},
})

export const sixb = new SixbHost({
  id: "cli-check-retrying",
  ontology: [Room],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues,
})
