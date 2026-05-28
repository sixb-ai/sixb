import {
  defineFunction,
  defineObjectType,
  defineSchedule,
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  Pario,
  prop,
  type RuleDefinition,
} from "@pario/core"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const daily = defineSchedule("start-order-daily").cron("0 2 * * *")

const workflowStep = defineWorkflowStep("start-order-workflow-step")
  .input({})
  .output({})
  .run(() => ({}))

const workflow = defineWorkflow("start-order-workflow").input({}).when(daily).then(workflowStep)

const intervalFunction = defineFunction("start-order-function")
  .interval(60_000)
  .run(() => {})

const roomNamedRule: RuleDefinition = {
  kind: "rule",
  id: "room.named",
  subject: {
    kind: "object",
    objectTypeId: "Room",
  },
  predicate: {
    kind: "property",
    propertyId: "name",
    op: "isPresent",
  },
}

export const pario = new Pario({
  id: "cli-start-order",
  ontology: [Room],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
  functions: [intervalFunction],
  schedules: [daily],
  rules: [roomNamedRule],
  workflows: [workflow],
})
