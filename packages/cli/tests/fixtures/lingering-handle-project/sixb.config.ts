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

// Simulates a real provider (redis broker, pg pool) that holds a ref'd handle
// keeping the event loop alive until it is explicitly closed. `sixb check` must
// tear providers down or the process hangs after rendering — this fixture makes
// that hang observable in a test.
const keepAlive = setInterval(() => {}, 1_000)

const queues = Object.assign(new InMemoryQueues(), {
  async close() {
    clearInterval(keepAlive)
  },
})

export const sixb = new SixbHost({
  id: "cli-check-lingering",
  ontology: [Room],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues,
})
