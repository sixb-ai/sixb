import { describe, expect, test } from "bun:test"
import {
  col,
  type DomainEvent,
  datasetUpdated,
  defineAction,
  defineConnector,
  defineDataset,
  defineLinkProjection,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRule,
  defineSchedule,
  defineSync,
  defineTelemetryProjection,
  defineTrigger,
  defineWorkflow,
  defineWorkflowStep,
  events,
  link,
  prop,
  type RunTrigger,
  type ScheduleDefinition,
  syncFinished,
} from "@sixb/core"
import { compileRoutes, compileRoutesWithDiagnostics } from "../src/compile-routes"
import type { OrchestratorRouteKey, OrchestratorRoutes } from "../src/types"

const daily = defineSchedule("daily").cron("0 2 * * *")
const hourly = defineSchedule("hourly").cron("0 * * * *")

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {}
  },
})

const Sensor = defineObjectType({
  id: "sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link("hasSensors", Sensor, { cardinality: "many" })],
})

const highTemperature = defineTrigger("room.high-temperature")
  .on(events(Room).updated())
  .where((event) => event.object.p.temperature.gt(30))

const highTemperatureRule = defineRule("room.high-temperature-rule")
  .on(Room)
  .where((room) => room.p.temperature.gt(30))

const acknowledgeRoom = defineAction("acknowledge-room")
  .on(Room)
  .params({})
  .writeback(async () => {})

const highTemperatureRuleTriggered = defineTrigger("room.rule-triggered").on(
  events.rule(highTemperatureRule).triggered()
)

const roomAcknowledged = defineTrigger("room.acknowledged").on(
  events.action(acknowledgeRoom).completed()
)

function makeDataset(id: string) {
  return defineDataset(id, {
    schema: [col("id", "string", { nullable: true })],
  })
}

function makeJoinDataset(id: string) {
  return defineDataset(id, {
    schema: [col("room_id", "string"), col("sensor_id", "string")],
  })
}

function makeTelemetryDataset(id: string) {
  return defineDataset(id, {
    schema: [
      col("room_id", "string"),
      col("observed_at", "timestamp"),
      col("temperature", "float64"),
    ],
  })
}

function makeSyncWithSchedule(id: string, schedule: ScheduleDefinition) {
  return defineSync(id)
    .when(schedule)
    .from(erpDb)
    .read(() => [])
    .intoDataset(makeDataset(`raw.${id}`))
}

function makeSyncWithoutSchedule(id: string) {
  return defineSync(id)
    .from(erpDb)
    .read(() => [])
    .intoDataset(makeDataset(`raw.${id}`))
}

function makePipelineWithSchedule(id: string, schedule: ScheduleDefinition) {
  return definePipeline(id).when(schedule).then(makePipelineStep(id))
}

function makePipelineWithoutSchedule(id: string) {
  return definePipeline(id).then(makePipelineStep(id))
}

function makeSyncWithTrigger(id: string, trigger: RunTrigger) {
  return defineSync(id)
    .when(trigger)
    .from(erpDb)
    .read(() => [])
    .intoDataset(makeDataset(`raw.${id}`))
}

function makePipelineWithTrigger(id: string, trigger: RunTrigger) {
  return definePipeline(id).when(trigger).then(makePipelineStep(id))
}

function makePipelineStep(id: string) {
  return definePipelineStep(`${id}-step`)
    .inputs({ source: makeDataset("source") })
    .output(makeDataset(`clean.${id}`))
    .run(() => {})
}

const workflowStep = defineWorkflowStep("workflow-route-step")
  .input({})
  .output({})
  .run(() => ({}))

function makeWorkflowWithoutTriggers(id: string) {
  return defineWorkflow(id).input({}).then(workflowStep)
}

function makeWorkflowWithSchedule(id: string, schedule: ScheduleDefinition) {
  return defineWorkflow(id).input({}).when(schedule).then(workflowStep)
}

function makeWorkflowWithTrigger(id: string) {
  return defineWorkflow(id).input({}).when(highTemperature).then(workflowStep)
}

function makeWorkflowWithRequiredInput(id: string, schedule: ScheduleDefinition) {
  return defineWorkflow(id)
    .input({ accountId: "string" })
    .when(schedule as never)
    .then(workflowStep)
}

function makeObjectProjection(id: string, datasetId: string) {
  return defineProjection(id, Room).fromDataset(makeDataset(datasetId)).properties({ id: "id" })
}

function makeLinkProjection(id: string, datasetId: string) {
  return defineLinkProjection(id, Room.l.hasSensors)
    .fromDataset(makeJoinDataset(datasetId))
    .sourceField("room_id")
    .targetField("sensor_id")
}

function makeTelemetryProjection(id: string, datasetId: string) {
  return defineTelemetryProjection(id, Room.p.temperature)
    .fromDataset(makeTelemetryDataset(datasetId))
    .points({ objectId: "room_id", at: "observed_at", value: "temperature" })
}

function getJobs(routes: OrchestratorRoutes, key: OrchestratorRouteKey) {
  const route = routes.get(key)
  expect(route).toBeDefined()
  return route!.jobs
}

function expectEventType(
  routes: OrchestratorRoutes,
  key: OrchestratorRouteKey,
  eventType: DomainEvent["type"]
) {
  expect(routes.get(key)?.eventType).toBe(eventType)
}

describe("compileRoutes", () => {
  test("syncs without schedule produce an empty map", () => {
    const routes = compileRoutes({
      syncs: [makeSyncWithoutSchedule("sync-a")],
      pipelines: [],
    })
    expect(routes.size).toBe(0)
  })

  test("pipelines without schedule produce an empty map", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [makePipelineWithoutSchedule("pipe-a")],
    })
    expect(routes.size).toBe(0)
  })

  test("workflows without triggers produce an empty map", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      workflows: [makeWorkflowWithoutTriggers("workflow-a")],
    })

    expect(routes.size).toBe(0)
  })

  test("one sync with schedule produces one entry in syncRuns", () => {
    const routes = compileRoutes({
      syncs: [makeSyncWithSchedule("sync-orders", daily)],
      pipelines: [],
    })

    expect(routes.size).toBe(1)

    const jobs = getJobs(routes, "schedule.triggered:daily")
    expect(jobs).toHaveLength(1)
    expectEventType(routes, "schedule.triggered:daily", "schedule.triggered")
    expect(jobs![0]).toEqual({
      queue: "syncRuns",
      job: { type: "sync.run.requested", payload: { syncId: "sync-orders" } },
    })
  })

  test("one pipeline with schedule produces one entry in pipelines", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [makePipelineWithSchedule("pipe-clean", daily)],
    })

    expect(routes.size).toBe(1)

    const jobs = getJobs(routes, "schedule.triggered:daily")
    expect(jobs).toHaveLength(1)
    expectEventType(routes, "schedule.triggered:daily", "schedule.triggered")
    expect(jobs![0]).toEqual({
      queue: "pipelines",
      job: { type: "pipeline.run.requested", payload: { pipelineId: "pipe-clean" } },
    })
  })

  test("one scheduled empty-input workflow produces one entry in workflows", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      workflows: [makeWorkflowWithSchedule("nightly-reconciliation", daily)],
    })

    expect(routes.size).toBe(1)

    const jobs = getJobs(routes, "schedule.triggered:daily")
    expect(jobs).toHaveLength(1)
    expectEventType(routes, "schedule.triggered:daily", "schedule.triggered")
    expect(jobs![0]).toEqual({
      queue: "workflows",
      job: {
        type: "workflow.run.requested",
        payload: {
          workflowId: "nightly-reconciliation",
          input: {},
        },
      },
    })
  })

  test("scheduled non-empty-input workflow is skipped by compileRoutes", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      workflows: [makeWorkflowWithRequiredInput("reconcile-transaction", daily)],
    })

    expect(routes.size).toBe(0)
    expect(routes.has("schedule.triggered:daily")).toBe(false)
  })

  test("scheduled non-empty-input workflow reports diagnostics", () => {
    const result = compileRoutesWithDiagnostics({
      syncs: [],
      pipelines: [],
      workflows: [makeWorkflowWithRequiredInput("reconcile-transaction", daily)],
    })

    expect(result.routes.size).toBe(0)
    expect(result.diagnostics).toEqual([
      {
        type: "workflow.schedule.input-required",
        workflowId: "reconcile-transaction",
        scheduleId: "daily",
        inputFields: ["accountId"],
      },
    ])
  })

  test("workflow trigger produces a trigger subscription route", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      workflows: [makeWorkflowWithTrigger("alert-hot-room")],
      triggers: [highTemperature],
    })

    expect(routes.size).toBe(1)
    expect(routes.get("trigger:object.updated:room")).toEqual({
      eventType: "object.updated",
      jobs: [],
      workflowTriggers: [
        {
          workflowId: "alert-hot-room",
          triggerId: "room.high-temperature",
        },
      ],
    })
  })

  test("rule and action triggers produce source-scoped routes", () => {
    const ruleWorkflow = defineWorkflow("notify-rule-triggered")
      .input({})
      .when(highTemperatureRuleTriggered)
      .then(workflowStep)
    const actionWorkflow = defineWorkflow("notify-room-acknowledged")
      .input({})
      .when(roomAcknowledged)
      .then(workflowStep)

    const ruleRoutes = compileRoutes({
      syncs: [],
      pipelines: [],
      workflows: [ruleWorkflow],
      triggers: [highTemperatureRuleTriggered],
    })
    const actionRoutes = compileRoutes({
      syncs: [],
      pipelines: [],
      workflows: [actionWorkflow],
      triggers: [roomAcknowledged],
    })

    expect(
      ruleRoutes.get("trigger:rule.triggered:room.high-temperature-rule")?.workflowTriggers
    ).toEqual([
      {
        workflowId: "notify-rule-triggered",
        triggerId: "room.rule-triggered",
      },
    ])
    expect(actionRoutes.get("trigger:action.completed:acknowledge-room")?.workflowTriggers).toEqual(
      [
        {
          workflowId: "notify-room-acknowledged",
          triggerId: "room.acknowledged",
        },
      ]
    )
  })

  test("unknown workflow trigger reports diagnostics", () => {
    const result = compileRoutesWithDiagnostics({
      syncs: [],
      pipelines: [],
      workflows: [makeWorkflowWithTrigger("alert-hot-room")],
    })

    expect(result.routes.size).toBe(0)
    expect(result.diagnostics).toEqual([
      {
        type: "workflow.trigger.unknown",
        workflowId: "alert-hot-room",
        triggerId: "room.high-temperature",
      },
    ])
  })

  test("fan-out: one schedule shared by 1 sync + 2 pipelines produces 1 key with 3 jobs", () => {
    const routes = compileRoutes({
      syncs: [makeSyncWithSchedule("sync-a", daily)],
      pipelines: [
        makePipelineWithSchedule("pipe-b", daily),
        makePipelineWithSchedule("pipe-c", daily),
      ],
    })

    expect(routes.size).toBe(1)

    const jobs = getJobs(routes, "schedule.triggered:daily")
    expect(jobs).toHaveLength(3)
    // Order: syncs first, then pipelines in declaration order
    expect(jobs![0]!.queue).toBe("syncRuns")
    expect(jobs![1]!.queue).toBe("pipelines")
    expect(jobs![2]!.queue).toBe("pipelines")
  })

  test("fan-out: sync + pipeline + workflow sharing one schedule preserve deterministic order", () => {
    const routes = compileRoutes({
      syncs: [makeSyncWithSchedule("sync-a", daily)],
      pipelines: [makePipelineWithSchedule("pipe-b", daily)],
      workflows: [makeWorkflowWithSchedule("workflow-c", daily)],
    })

    expect(routes.size).toBe(1)

    const jobs = getJobs(routes, "schedule.triggered:daily")
    expect(jobs).toHaveLength(3)
    expect(jobs![0]!.queue).toBe("syncRuns")
    expect(jobs![1]!.queue).toBe("pipelines")
    expect(jobs![2]!.queue).toBe("workflows")
  })

  test("two empty-input workflows on the same schedule produce two workflow jobs", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      workflows: [
        makeWorkflowWithSchedule("workflow-a", daily),
        makeWorkflowWithSchedule("workflow-b", daily),
      ],
    })

    expect(routes.size).toBe(1)

    const jobs = getJobs(routes, "schedule.triggered:daily")
    expect(jobs).toHaveLength(2)
    expect(jobs).toEqual([
      {
        queue: "workflows",
        job: { type: "workflow.run.requested", payload: { workflowId: "workflow-a", input: {} } },
      },
      {
        queue: "workflows",
        job: { type: "workflow.run.requested", payload: { workflowId: "workflow-b", input: {} } },
      },
    ])
  })

  test("two distinct schedules produce two independent keys", () => {
    const routes = compileRoutes({
      syncs: [makeSyncWithSchedule("sync-a", daily)],
      pipelines: [makePipelineWithSchedule("pipe-b", hourly)],
    })

    expect(routes.size).toBe(2)
    expect(getJobs(routes, "schedule.triggered:daily")).toHaveLength(1)
    expect(getJobs(routes, "schedule.triggered:hourly")).toHaveLength(1)
  })

  test("duplicate sync ids with the same schedule accumulate in the same bucket", () => {
    // This situation is impossible via Sixb's constructor (it rejects duplicate ids),
    // but we document the behavior: compileRoutes is a pure function and does not validate.
    const syncA = makeSyncWithSchedule("sync-dup", daily)
    const syncB = makeSyncWithSchedule("sync-dup", daily)

    const routes = compileRoutes({
      syncs: [syncA, syncB],
      pipelines: [],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "schedule.triggered:daily")
    expect(jobs).toHaveLength(2)
  })

  test("mixed: some definitions with schedule, some without", () => {
    const routes = compileRoutes({
      syncs: [makeSyncWithSchedule("sync-a", daily), makeSyncWithoutSchedule("sync-b")],
      pipelines: [
        makePipelineWithoutSchedule("pipe-c"),
        makePipelineWithSchedule("pipe-d", hourly),
      ],
    })

    expect(routes.size).toBe(2)
    expect(getJobs(routes, "schedule.triggered:daily")).toHaveLength(1)
    expect(getJobs(routes, "schedule.triggered:hourly")).toHaveLength(1)
  })

  test("empty syncs and pipelines produce an empty map", () => {
    const routes = compileRoutes({ syncs: [], pipelines: [] })
    expect(routes.size).toBe(0)
  })

  test("sync with syncFinished trigger produces sync.run.finished route key", () => {
    const routes = compileRoutes({
      syncs: [makeSyncWithTrigger("sync-lines", syncFinished("sync-orders"))],
      pipelines: [],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "sync.run.finished:sync-orders:succeeded")
    expect(jobs).toHaveLength(1)
    expectEventType(routes, "sync.run.finished:sync-orders:succeeded", "sync.run.finished")
    expect(jobs![0]).toEqual({
      queue: "syncRuns",
      job: { type: "sync.run.requested", payload: { syncId: "sync-lines" } },
    })
  })

  test("pipeline with datasetUpdated trigger produces dataset.version.committed route key", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [makePipelineWithTrigger("normalize", datasetUpdated("raw.erp.orders"))],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "dataset.version.committed:raw.erp.orders")
    expect(jobs).toHaveLength(1)
    expectEventType(routes, "dataset.version.committed:raw.erp.orders", "dataset.version.committed")
    expect(jobs![0]).toEqual({
      queue: "pipelines",
      job: { type: "pipeline.run.requested", payload: { pipelineId: "normalize" } },
    })
  })

  test("one object projection produces one projection route", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      projections: [makeObjectProjection("room-proj", "canonical.rooms")],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "dataset.version.committed:canonical.rooms")
    expect(jobs).toHaveLength(1)
    expectEventType(
      routes,
      "dataset.version.committed:canonical.rooms",
      "dataset.version.committed"
    )
    expect(jobs![0]).toEqual({
      queue: "projections",
      job: {
        type: "projection.run.requested",
        payload: {
          projectionId: "room-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
        },
      },
    })
  })

  test("one link projection produces one projection route", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      projections: [makeLinkProjection("room-sensors", "join.room-sensors")],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "dataset.version.committed:join.room-sensors")
    expect(jobs).toHaveLength(1)
    expect(jobs![0]).toEqual({
      queue: "projections",
      job: {
        type: "projection.run.requested",
        payload: {
          projectionId: "room-sensors",
          projectionKind: "link",
          datasetId: "join.room-sensors",
        },
      },
    })
  })

  test("one telemetry projection produces one projection route", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      projections: [makeTelemetryProjection("room-temperature", "canonical.room-readings")],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "dataset.version.committed:canonical.room-readings")
    expect(jobs).toHaveLength(1)
    expect(jobs![0]).toEqual({
      queue: "projections",
      job: {
        type: "projection.run.requested",
        payload: {
          projectionId: "room-temperature",
          projectionKind: "telemetry",
          datasetId: "canonical.room-readings",
        },
      },
    })
  })

  test("object and link projections on the same dataset share one route", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      projections: [
        makeObjectProjection("room-proj", "canonical.rooms"),
        makeLinkProjection("room-sensors", "canonical.rooms"),
      ],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "dataset.version.committed:canonical.rooms")
    expect(jobs).toHaveLength(2)
    expect(jobs).toEqual([
      {
        queue: "projections",
        job: {
          type: "projection.run.requested",
          payload: {
            projectionId: "room-proj",
            projectionKind: "object",
            datasetId: "canonical.rooms",
          },
        },
      },
      {
        queue: "projections",
        job: {
          type: "projection.run.requested",
          payload: {
            projectionId: "room-sensors",
            projectionKind: "link",
            datasetId: "canonical.rooms",
          },
        },
      },
    ])
  })

  test("projection on unrelated dataset does not create another dataset route", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [],
      projections: [makeObjectProjection("room-proj", "canonical.rooms")],
    })

    expect(routes.has("dataset.version.committed:raw.erp.orders")).toBe(false)
  })

  test("pipeline dataset trigger and projection on same dataset share a route bucket", () => {
    const routes = compileRoutes({
      syncs: [],
      pipelines: [makePipelineWithTrigger("normalize", datasetUpdated("canonical.rooms"))],
      projections: [makeObjectProjection("room-proj", "canonical.rooms")],
    })

    expect(routes.size).toBe(1)
    const jobs = getJobs(routes, "dataset.version.committed:canonical.rooms")
    expect(jobs).toHaveLength(2)
    expect(jobs![0]!.queue).toBe("pipelines")
    expect(jobs![1]!.queue).toBe("projections")
  })

  test("definition with multiple triggers produces multiple route keys", () => {
    const sync = defineSync("sync-multi")
      .when(daily)
      .when(syncFinished("sync-upstream"))
      .from(erpDb)
      .read(() => [])
      .intoDataset(makeDataset("raw.multi"))

    const routes = compileRoutes({ syncs: [sync], pipelines: [] })

    expect(routes.size).toBe(2)
    expect(getJobs(routes, "schedule.triggered:daily")).toHaveLength(1)
    expect(getJobs(routes, "sync.run.finished:sync-upstream:succeeded")).toHaveLength(1)
  })
})
