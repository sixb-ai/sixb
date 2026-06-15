import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  ActionDefinitionError,
  ActionRunError,
  defineAction,
  defineObjectType,
  OntologyValidationError,
  optional,
  param,
  prop,
  ref,
  Sixb,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("currentTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
})

const SuiteRoom = defineObjectType({
  id: "SuiteRoom",
  name: "Suite Room",
  extends: Room,
  properties: [prop("tier", "string")],
})

const setTemperature = defineAction("setTemperature", {
  description: "Set room temperature.",
})
  .on(Room)
  .params({ target: param("double") })
  .validate(({ params }) => {
    if (params.target < 10) {
      return { error: "Target is too low" }
    }
  })
  .writeback(async () => {})

const reboot = defineAction("reboot")
  .on(Room)
  .params({})
  .writeback(async () => {})

const createRoom = defineAction("createRoom")
  .params({
    id: param("string"),
    name: param("string"),
  })
  .validate(({ params }) => {
    if (!params.id.startsWith("room:")) {
      return { error: "Room id must start with room:" }
    }
  })
  .edits(({ objects, params }) => {
    objects(Room).create({
      id: params.id,
      name: params.name,
      externalId: params.id,
    })
  })

const prepareSuite = defineAction("prepareSuite")
  .on(SuiteRoom)
  .params({ note: optional(param("string")) })
  .writeback(async () => {})

const attachRelatedRoom = defineAction("attachRelatedRoom")
  .on(Room)
  .params({
    relatedRoom: param(ref(Room)),
  })
  .writeback(async () => {})

function actionDefinition(action: unknown): ActionDefinition {
  return action as ActionDefinition
}

describe("defineAction", () => {
  test("builds an inert typed action definition", () => {
    expect(setTemperature.kind).toBe("action")
    expect(setTemperature.binding.kind).toBe("object")
    expect(setTemperature.id).toBe("setTemperature")
    expect(setTemperature.binding.objectType.id).toBe("Room")
    expect(setTemperature.params.target.schema).toBe("double")
    expect(setTemperature.params.target.required).toBe(true)
    expect(setTemperature.phases.validate).toHaveLength(1)
    expect(typeof setTemperature.phases.writeback).toBe("function")
    expect(setTemperature.description).toBe("Set room temperature.")
  })

  test("builds global action definitions without a target", () => {
    expect(createRoom.kind).toBe("action")
    expect(createRoom.binding.kind).toBe("global")
    expect(createRoom.params.id.required).toBe(true)
    expect(createRoom.phases.validate).toHaveLength(1)
    expect(typeof createRoom.phases.edits).toBe("function")
  })

  test("validates empty action ids", () => {
    expect(() => {
      defineAction("")
    }).toThrow(ActionDefinitionError)
    expect(() => {
      defineAction("")
    }).toThrow("Action id must not be empty")
  })
})

describe("ActionRegistry", () => {
  test("lists actions by id and by inherited target type", () => {
    const sixb = new Sixb({
      id: "action-registry-test",
      ontology: [Room, SuiteRoom],
      actions: [
        actionDefinition(setTemperature),
        actionDefinition(reboot),
        actionDefinition(prepareSuite),
        actionDefinition(createRoom),
      ],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.getActionDefinitions().map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
      "prepareSuite",
      "createRoom",
    ])
    expect(sixb.getActionById("reboot")?.id).toBe(reboot.id)
    expect(sixb.getGlobalActions().map((action) => action.id)).toEqual(["createRoom"])
    expect(sixb.getActionsForType(Room).map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
    ])
    expect(sixb.getActionsForType(SuiteRoom).map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
      "prepareSuite",
    ])
  })

  test("rejects duplicate action ids", () => {
    const duplicate = defineAction("reboot")
      .on(Room)
      .params({})
      .writeback(async () => {})

    expect(() => {
      new Sixb({
        ontology: [Room],
        actions: [actionDefinition(reboot), actionDefinition(duplicate)],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
    expect(() => {
      new Sixb({
        ontology: [Room],
        actions: [actionDefinition(reboot), actionDefinition(duplicate)],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Duplicate action id "reboot"')
  })

  test("rejects duplicate action ids in inheritance chains with a precise error", () => {
    const suiteOverride = defineAction("setTemperature")
      .on(SuiteRoom)
      .params({})
      .writeback(async () => {})

    expect(() => {
      new Sixb({
        ontology: [Room, SuiteRoom],
        actions: [actionDefinition(setTemperature), actionDefinition(suiteOverride)],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(
      'Duplicate action id "setTemperature" in inheritance chain of "SuiteRoom": defined on both "Room" and "SuiteRoom".'
    )
  })

  test("rejects actions targeting unregistered object types", () => {
    const Unknown = defineObjectType({
      id: "Unknown",
      name: "Unknown",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const unknownAction = defineAction("unknown")
      .on(Unknown)
      .params({})
      .writeback(async () => {})

    expect(() => {
      new Sixb({
        ontology: [Room],
        actions: [actionDefinition(unknownAction)],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
  })
})

describe("requestAction", () => {
  test("rejects unknown action", async () => {
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature), actionDefinition(reboot)],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "nonexistent",
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "nonexistent",
      })
    ).rejects.toThrow("Unknown action 'nonexistent'")
  })

  test("rejects actions that are not valid for the object type", async () => {
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room, SuiteRoom],
      actions: [actionDefinition(setTemperature), actionDefinition(prepareSuite)],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "prepareSuite",
      })
    ).rejects.toThrow("Action 'prepareSuite' is not valid for object type 'Room'")
  })

  test("rejects missing required param", async () => {
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: {},
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: {},
      })
    ).rejects.toThrow("Missing required param 'target'")
  })

  test("rejects unknown param", async () => {
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: { target: 72, bogus: "nope" },
      })
    ).rejects.toThrow("Unknown param 'bogus'")
  })

  test("accepts object ref params", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "action-ref-test",
      ontology: [Room],
      actions: [actionDefinition(attachRelatedRoom)],
      ...runtimeDeps,
    })

    expect(attachRelatedRoom.params.relatedRoom.schema).toEqual({
      type: "objectRef",
      objectTypeId: "Room",
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "attachRelatedRoom",
      params: {
        relatedRoom: { objectTypeId: "Room", primaryId: "room:2" },
      },
    })

    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(events.length).toBe(1)
    if (events[0].type === "action.requested") {
      expect(events[0].payload.params).toEqual({
        relatedRoom: { objectTypeId: "Room", primaryId: "room:2" },
      })
    }
  })

  test("rejects object ref params with the wrong object type", async () => {
    const sixb = new Sixb({
      id: "action-ref-test",
      ontology: [Room],
      actions: [actionDefinition(attachRelatedRoom)],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "attachRelatedRoom",
        params: {
          relatedRoom: { objectTypeId: "SuiteRoom", primaryId: "suite:1" },
        },
      })
    ).rejects.toThrow('Room.attachRelatedRoom.relatedRoom.objectTypeId must be "Room"')
  })

  test("rejects object ref params without a string primary id", async () => {
    const sixb = new Sixb({
      id: "action-ref-test",
      ontology: [Room],
      actions: [actionDefinition(attachRelatedRoom)],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "attachRelatedRoom",
        params: {
          relatedRoom: { objectTypeId: "Room" },
        },
      })
    ).rejects.toThrow("Room.attachRelatedRoom.relatedRoom.primaryId must be a string")
  })

  test("rejects object ref params with unknown fields", async () => {
    const sixb = new Sixb({
      id: "action-ref-test",
      ontology: [Room],
      actions: [actionDefinition(attachRelatedRoom)],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "attachRelatedRoom",
        params: {
          relatedRoom: { objectTypeId: "Room", primaryId: "room:2", label: "Room 2" },
        },
      })
    ).rejects.toThrow("Unknown field 'Room.attachRelatedRoom.relatedRoom.label'")
  })

  test("queues object actions without loading the target object request-side", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...runtimeDeps,
    })

    const result = await sixb.objects(Room).requestAction({
      id: "room:missing",
      actionId: "setTemperature",
      params: { target: 72 },
    })

    const run = await runtimeDeps.storage.actionRuns!.getById({
      projectId: "action-test",
      id: result.runId,
    })
    expect(run?.status).toBe("queued")
  })

  test("emits action.requested event on success without invoking phases", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    let invoked = 0
    const counted = defineAction("counted")
      .on(Room)
      .params({})
      .writeback(() => {
        invoked += 1
      })
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(counted)],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const result = await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "counted",
    })

    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(invoked).toBe(0)
    expect(result.runId.startsWith("act_")).toBe(true)
    expect(result.created).toBe(true)
    expect(new Date(result.queuedAt).toISOString()).toBe(result.queuedAt)
    const run = await runtimeDeps.storage.actionRuns!.getById({
      projectId: "action-test",
      id: result.runId,
    })
    expect(run).toMatchObject({
      id: result.runId,
      actionId: "counted",
      status: "queued",
      phase: "request",
      subject: {
        kind: "object",
        objectTypeId: "Room",
        primaryId: "room:1",
      },
      params: {},
      idempotencyKey: `action:action-test:${result.runId}`,
    })
    const jobs = await runtimeDeps.queues.actions.claim({
      projectId: "action-test",
      workerId: "test-worker",
      limit: 1,
    })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].job.payload).toEqual({
      actionId: "counted",
      runId: result.runId,
    })
    expect(events.length).toBe(1)
    expect(events[0].type).toBe("action.requested")
    if (events[0].type === "action.requested") {
      expect(events[0].payload.subject).toEqual({
        kind: "object",
        objectTypeId: "Room",
        primaryId: "room:1",
      })
      expect(events[0].payload.actionId).toBe("counted")
      expect(events[0].payload.params).toEqual({})
      expect(events[0].payload.runId).toBe(result.runId)
    }
  })

  test("keeps a queued run when the action.requested observation event fails", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "action-event-best-effort-test",
      ontology: [Room],
      actions: [actionDefinition(createRoom)],
      ...runtimeDeps,
    })
    const originalAppend = sixb.events.append.bind(sixb.events)
    const originalConsoleError = console.error

    sixb.events.append = async (input) => {
      if (input.events.some((event) => event.type === "action.requested")) {
        throw new Error("event store unavailable")
      }

      return originalAppend(input)
    }
    console.error = () => {}

    try {
      const result = await sixb.actions.request({
        actionId: "createRoom",
        params: { id: "room:1", name: "Room 1" },
        runId: "act_event_failure",
      })

      expect(result).toMatchObject({
        runId: "act_event_failure",
        created: true,
      })

      const run = await runtimeDeps.storage.actionRuns!.getById({
        projectId: "action-event-best-effort-test",
        id: "act_event_failure",
      })
      expect(run?.status).toBe("queued")

      const jobs = await runtimeDeps.queues.actions.claim({
        projectId: "action-event-best-effort-test",
        workerId: "test-worker",
        limit: 1,
      })
      expect(jobs[0]?.job.payload).toEqual({
        actionId: "createRoom",
        runId: "act_event_failure",
      })

      const events = await sixb.events.read({
        types: ["action.requested"],
      })
      expect(events).toHaveLength(0)
    } finally {
      sixb.events.append = originalAppend
      console.error = originalConsoleError
    }
  })

  test("reuses a matching run id and rejects conflicting payloads", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "action-idempotency-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const first = await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "setTemperature",
      params: { target: 72 },
      runId: "act_fixed",
    })
    const second = await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "setTemperature",
      params: { target: 72 },
      runId: "act_fixed",
    })

    expect(first.created).toBe(true)
    expect(second).toEqual({
      runId: "act_fixed",
      queuedAt: first.queuedAt,
      created: false,
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: { target: 73 },
        runId: "act_fixed",
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })

  test("retries enqueue failures for the same run id and payload", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const enqueue = runtimeDeps.queues.actions.enqueue.bind(runtimeDeps.queues.actions)
    let shouldFailEnqueue = true
    runtimeDeps.queues.actions.enqueue = async (input) => {
      if (shouldFailEnqueue) {
        shouldFailEnqueue = false
        throw new Error("queue unavailable")
      }

      return enqueue(input)
    }

    const sixb = new Sixb({
      id: "action-enqueue-retry-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: { target: 72 },
        runId: "act_enqueue_retry",
      })
    ).rejects.toThrow("queue unavailable")

    const failed = await runtimeDeps.storage.actionRuns!.getById({
      projectId: "action-enqueue-retry-test",
      id: "act_enqueue_retry",
    })
    expect(failed).toMatchObject({
      status: "failed",
      phase: "enqueue",
      error: {
        name: "Error",
        message: "queue unavailable",
        phase: "enqueue",
      },
    })

    const retry = await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "setTemperature",
      params: { target: 72 },
      runId: "act_enqueue_retry",
    })

    expect(retry.created).toBe(false)
    expect(retry.jobId).toBeTruthy()
    const queued = await runtimeDeps.storage.actionRuns!.getById({
      projectId: "action-enqueue-retry-test",
      id: "act_enqueue_retry",
    })
    expect(queued).toMatchObject({
      status: "queued",
      phase: "request",
      error: undefined,
      finishedAt: undefined,
    })

    const jobs = await runtimeDeps.queues.actions.claim({
      projectId: "action-enqueue-retry-test",
      workerId: "test-worker",
      limit: 1,
    })
    expect(jobs[0]?.job.payload).toEqual({
      actionId: "setTemperature",
      runId: "act_enqueue_retry",
    })
  })

  test("queues custom validation for the worker phase", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const result = await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "setTemperature",
      params: { target: 5 },
    })

    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(result.created).toBe(true)
    expect(events).toHaveLength(1)
  })

  test("allows inherited actions on subtypes", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "action-test",
      ontology: [Room, SuiteRoom],
      actions: [actionDefinition(setTemperature)],
      ...runtimeDeps,
    })

    await sixb.objects(SuiteRoom).upsert({
      properties: { id: "suite:1", externalId: "S1", name: "Suite 1", tier: "vip" },
    })

    await sixb.objects(SuiteRoom).requestAction({
      id: "suite:1",
      actionId: "setTemperature",
      params: { target: 72 },
    })

    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(events.length).toBe(1)
    if (events[0].type === "action.requested") {
      expect(events[0].payload.subject).toEqual({
        kind: "object",
        objectTypeId: "SuiteRoom",
        primaryId: "suite:1",
      })
      expect(events[0].payload.actionId).toBe("setTemperature")
    }
  })

  test("requests global actions through sixb.actions", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "global-action-test",
      ontology: [Room],
      actions: [actionDefinition(createRoom)],
      ...runtimeDeps,
    })

    const result = await sixb.actions.request({
      actionId: "createRoom",
      params: { id: "room:1", name: "Room 1" },
    })

    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(result.runId.startsWith("act_")).toBe(true)
    expect(events.length).toBe(1)
    if (events[0].type === "action.requested") {
      expect(events[0].payload).toEqual({
        actionId: "createRoom",
        subject: { kind: "none" },
        params: { id: "room:1", name: "Room 1" },
        runId: result.runId,
      })
    }
  })

  test("rejects invalid global action param schemas before emitting an event", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      id: "global-action-test",
      ontology: [Room],
      actions: [actionDefinition(createRoom)],
      ...runtimeDeps,
    })

    await expect(
      sixb.actions.request({
        actionId: "createRoom",
        params: { id: "room:1", name: 42 },
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)

    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(events).toHaveLength(0)
  })

  test("rejects object-scoped actions without an object subject", async () => {
    const sixb = new Sixb({
      id: "global-action-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb.actions.request({
        actionId: "setTemperature",
        params: { target: 72 },
      })
    ).rejects.toThrow("Action 'setTemperature' requires an object subject.")
  })

  test("rejects global actions with an object subject", async () => {
    const sixb = new Sixb({
      id: "global-action-test",
      ontology: [Room],
      actions: [actionDefinition(createRoom)],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb.actions.request({
        actionId: "createRoom",
        subject: { kind: "object", objectTypeId: "Room", primaryId: "room:1" },
        params: { id: "room:2", name: "Room 2" },
      })
    ).rejects.toThrow("Action 'createRoom' does not accept an object subject.")
  })
})
