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

// A provider whose close never settles. `atlas` and `app` read the project in a child process that
// closes its providers before the role serves, so this must not keep the role from starting.
const queues = Object.assign(new InMemoryQueues(), {
  close: () => new Promise<void>(() => {}),
})

export const sixb = new SixbHost({
  id: "cli-roles-hanging-close",
  ontology: [Room],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues,
})
