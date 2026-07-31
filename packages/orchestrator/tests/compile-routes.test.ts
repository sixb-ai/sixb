import { describe, expect, test } from "bun:test"
import {
  col,
  defineAction,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRule,
  defineSchedule,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  events,
  link,
  prop,
  type ScheduleDefinition,
  type WorkflowDefinition,
} from "@sixb/core"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import { compileRoutes, compileRoutesWithDiagnostics } from "../src/compile-routes"
import type { CompileRoutesParams, OrchestratorRouteKey } from "../src/types"

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

const daily = defineSchedule("daily").cron("0 2 * * *")
const highTemperature = defineSchedule("room.high-temperature")
  .on(events.object(Room).updated())
  .where((event) => event.object.p.temperature.gt(30))

const highTemperatureRule = defineRule("room.high-temperature-rule")
  .on(Room)
  .where((room) => room.p.temperature.gt(30))
const acknowledgeRoom = defineAction("acknowledge-room")
  .on(Room)
  .params({})
  .writeback(async () => {})
const ruleTriggered = defineSchedule("room.rule-triggered").on(
  events.rule(highTemperatureRule).triggered()
)
const actionCompleted = defineSchedule("room.acknowledged").on(
  events.action(acknowledgeRoom).completed()
)

function makeDataset(id: string) {
  return defineDataset(id, { schema: [col("id", "string", { nullable: true })] })
}

const rawRooms = makeDataset("raw.rooms")
const cleanRooms = makeDataset("clean.rooms")
const rawRoomsUpdated = defineSchedule("raw-rooms-updated").on(events.dataset(rawRooms).updated())

function projectionDescriptor(
  projectionId: string,
  datasetId: string,
  projectionKind: ProjectionDispatchDescriptor["projectionKind"]
): ProjectionDispatchDescriptor {
  const common = {
    projectionId,
    datasetId,
    ontologyRevision: "ontology-1",
    projectionRevision: `${projectionId}-revision`,
    ownershipHash: `${projectionId}-ownership`,
  }
  switch (projectionKind) {
    case "object":
      return { ...common, projectionKind, protocol: "replacement" }
    case "link":
      return { ...common, projectionKind, protocol: "replacement" }
    case "telemetry":
      return { ...common, projectionKind, protocol: "telemetry" }
  }
}

function makeSync(id: string, schedule?: ScheduleDefinition) {
  const builder = defineSync(id)
  const scheduled = schedule ? builder.when(schedule) : builder
  return scheduled
    .from(erpDb)
    .read(() => [])
    .intoDataset(rawRooms)
}

function makeStep(id: string) {
  return definePipelineStep(`${id}-step`)
    .inputs({ source: rawRooms })
    .output(cleanRooms)
    .run(() => {})
}

function makePipeline(id: string, schedule?: ScheduleDefinition) {
  const pipeline = definePipeline(id)
  return (schedule ? pipeline.when(schedule) : pipeline).then(makeStep(id))
}

const workflowStep = defineWorkflowStep("route-step")
  .input({})
  .output({})
  .run(() => ({}))

function makeWorkflow(id: string, schedule?: ScheduleDefinition) {
  const workflow = defineWorkflow(id).input({})
  return (schedule ? workflow.when(schedule) : workflow).then(workflowStep)
}

function compile(overrides: Partial<CompileRoutesParams> = {}) {
  return compileRoutes({
    schedules: [],
    syncs: [],
    pipelines: [],
    ...overrides,
  })
}

function jobsFor(overrides: Partial<CompileRoutesParams>, key: OrchestratorRouteKey) {
  return compile(overrides).get(key)?.jobs ?? []
}

describe("compileRoutes", () => {
  test("definitions without schedules produce no routes", () => {
    expect(
      compile({
        syncs: [makeSync("sync-rooms")],
        pipelines: [makePipeline("clean-rooms")],
        workflows: [makeWorkflow("inspect-rooms")],
      }).size
    ).toBe(0)
  })

  test("one cron schedule fans out to sync, pipeline, and workflow queues", () => {
    const routes = compile({
      schedules: [daily],
      syncs: [makeSync("sync-rooms", daily)],
      pipelines: [makePipeline("clean-rooms", daily)],
      workflows: [makeWorkflow("inspect-rooms", daily)],
    })

    expect(routes.get("schedule.triggered:daily")?.jobs).toEqual([
      {
        queue: "syncRuns",
        job: { type: "sync.run.requested", payload: { syncId: "sync-rooms" } },
      },
      {
        queue: "pipelines",
        job: { type: "pipeline.run.requested", payload: { pipelineId: "clean-rooms" } },
      },
      {
        queue: "workflows",
        job: {
          type: "workflow.run.requested",
          payload: { workflowId: "inspect-rooms", input: {} },
        },
      },
    ])
  })

  test("an event schedule is compiled once with all workflow consumers", () => {
    const first: WorkflowDefinition = defineWorkflow("first-alert")
      .input({ roomId: "string" })
      .when(highTemperature, ({ event }) => ({ roomId: event.object.primaryId }))
      .then(workflowStep)
    const second: WorkflowDefinition = defineWorkflow("second-alert")
      .input({ roomId: "string" })
      .when(highTemperature, ({ event }) => ({ roomId: event.object.primaryId }))
      .then(workflowStep)

    const route = compile({
      schedules: [highTemperature],
      workflows: [first, second],
    }).get("event-schedule:object.updated:room")

    expect(route?.eventType).toBe("object.updated")
    expect(route?.eventSchedules).toHaveLength(1)
    expect(route?.eventSchedules?.[0]?.schedule.id).toBe(highTemperature.id)
    expect(route?.eventSchedules?.[0]?.targets.map((target) => target.queue)).toEqual([
      "workflows",
      "workflows",
    ])
  })

  test("rule and action event schedules use source-scoped routes", () => {
    const ruleRoutes = compile({
      schedules: [ruleTriggered],
      workflows: [makeWorkflow("rule-alert", ruleTriggered)],
    })
    const actionRoutes = compile({
      schedules: [actionCompleted],
      workflows: [makeWorkflow("action-alert", actionCompleted)],
    })

    expect(ruleRoutes.has("event-schedule:rule.triggered:room.high-temperature-rule")).toBe(true)
    expect(actionRoutes.has("event-schedule:action.completed:acknowledge-room")).toBe(true)
  })

  test("dataset, sync, and pipeline event schedules can target downstream work", () => {
    const upstreamSync = makeSync("upstream-sync")
    const upstreamPipeline = makePipeline("upstream-pipeline")
    const syncSucceeded = defineSchedule("upstream-sync-succeeded").on(
      events.sync(upstreamSync).succeeded()
    )
    const pipelineSucceeded = defineSchedule("upstream-pipeline-succeeded").on(
      events.pipeline(upstreamPipeline).succeeded()
    )

    const routes = compile({
      schedules: [rawRoomsUpdated, syncSucceeded, pipelineSucceeded],
      syncs: [makeSync("from-dataset", rawRoomsUpdated)],
      pipelines: [makePipeline("from-sync", syncSucceeded)],
      workflows: [makeWorkflow("from-pipeline", pipelineSucceeded)],
    })

    expect(routes.has("event-schedule:dataset.version.committed:raw.rooms")).toBe(true)
    expect(routes.has("event-schedule:sync.run.finished:upstream-sync")).toBe(true)
    expect(routes.has("event-schedule:pipeline.run.finished:upstream-pipeline")).toBe(true)
  })

  test("unknown schedule references produce one consumer-aware diagnostic", () => {
    const unknown = defineSchedule("missing").cron("0 * * * *")
    const result = compileRoutesWithDiagnostics({
      schedules: [],
      syncs: [makeSync("sync-rooms", unknown)],
      pipelines: [],
    })

    expect(result.routes.size).toBe(0)
    expect(result.diagnostics).toEqual([
      {
        type: "schedule.reference.unknown",
        scheduleId: "missing",
        consumerKind: "sync",
        consumerId: "sync-rooms",
      },
    ])
  })

  test("required workflow input without an event mapper is diagnosed", () => {
    const workflow = defineWorkflow("invalid-input")
      .input({ roomId: "string" })
      .when(highTemperature as never)
      .then(workflowStep)
    const result = compileRoutesWithDiagnostics({
      schedules: [highTemperature],
      syncs: [],
      pipelines: [],
      workflows: [workflow],
    })

    expect(result.diagnostics).toEqual([
      {
        type: "workflow.schedule.input-required",
        workflowId: "invalid-input",
        scheduleId: "room.high-temperature",
        inputFields: ["roomId"],
      },
    ])
  })

  test("dataset projections keep their direct version-scoped route", () => {
    const projection = defineProjection("rooms-projection", Room)
      .fromDataset(rawRooms)
      .properties({ id: "id" })
    const descriptor = projectionDescriptor(projection.id, projection.datasetId, "object")

    expect(jobsFor({ projections: [descriptor] }, "dataset.version.committed:raw.rooms")).toEqual([
      {
        queue: "projections",
        job: {
          type: "projection.run.requested",
          payload: descriptor,
        },
      },
    ])
  })

  test("link and telemetry projections compile with their projection kind", () => {
    const joins = defineDataset("raw.room-sensors", {
      schema: [col("room_id", "string"), col("sensor_id", "string")],
    })
    const telemetry = defineDataset("raw.room-temperature", {
      schema: [
        col("room_id", "string"),
        col("observed_at", "timestamp"),
        col("temperature", "float64"),
      ],
    })
    const linkProjection = defineProjection("room-sensors", Room.l.hasSensors)
      .fromDataset(joins)
      .sourceField("room_id")
      .targetField("sensor_id")
    const telemetryProjection = defineProjection("room-temperature", Room.p.temperature)
      .fromDataset(telemetry)
      .points({ objectId: "room_id", at: "observed_at", value: "temperature" })

    expect(
      jobsFor(
        {
          projections: [projectionDescriptor(linkProjection.id, linkProjection.datasetId, "link")],
        },
        "dataset.version.committed:raw.room-sensors"
      )[0]
    ).toMatchObject({ queue: "projections", job: { payload: { projectionKind: "link" } } })
    expect(
      jobsFor(
        {
          projections: [
            projectionDescriptor(
              telemetryProjection.id,
              telemetryProjection.datasetId,
              "telemetry"
            ),
          ],
        },
        "dataset.version.committed:raw.room-temperature"
      )[0]
    ).toMatchObject({ queue: "projections", job: { payload: { projectionKind: "telemetry" } } })
  })
})
