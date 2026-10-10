import { describe, expect, spyOn, test } from "bun:test"
import {
  type ActionDefinition,
  ActionDefinitionError,
  defineAction,
  defineObjectType,
  OntologyValidationError,
  optional,
  param,
  prop,
  ref,
  type SixbErrorContext,
  SixbHost,
  stringEnum,
} from "../src"
import { drainActionRuns } from "../src/actions"
import { flushSixbErrors } from "../src/error-reporting/internal"
import { ActionRunError } from "../src/storage"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { createTestSixb } from "../src/testing"
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

const updateRoomCategory = defineAction("updateRoomCategory")
  .on(Room)
  .params({
    category: optional(param(stringEnum(["general_services", "construction"]), { nullable: true })),
    relatedRoom: optional(param(ref(Room), { nullable: true })),
    reviewedAt: optional(param("timestamp", { nullable: true })),
  })
  .writeback(async () => {})

const recordNullableNote = defineAction("recordNullableNote")
  .params({ note: param("string", { nullable: true }) })
  .writeback(async () => {})

const recordExactAmount = defineAction("recordExactAmount")
  .params({ amount: param("decimal") })
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

  test("preserves nullable action param metadata", () => {
    expect(updateRoomCategory.params.category).toMatchObject({
      required: false,
      nullable: true,
    })
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

  test("rejects .effects(...) without .edits(...) at runtime", () => {
    const definition = defineAction("effectsWithoutEdits")
      .params({})
      .writeback(() => {}) as unknown as {
      effects(handler: () => void): unknown
    }

    expect(() => {
      definition.effects(() => {})
    }).toThrow(ActionDefinitionError)
    expect(() => {
      definition.effects(() => {})
    }).toThrow('Action "effectsWithoutEdits" cannot declare .effects(...) without .edits(...).')
  })
})

describe("ActionRegistry", () => {
  test("lists actions by id and by inherited target type", () => {
    const sixb = createTestSixb({
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

    expect(sixb.actions.list().map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
      "prepareSuite",
      "createRoom",
    ])
    expect(sixb.actions.getById("reboot")?.id).toBe(reboot.id)
    expect(sixb.actions.listGlobal().map((action) => action.id)).toEqual(["createRoom"])
    expect(sixb.actions.listForType(Room).map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
    ])
    expect(sixb.actions.listForType(SuiteRoom).map((action) => action.id)).toEqual([
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
      createTestSixb({
        ontology: [Room],
        actions: [actionDefinition(reboot), actionDefinition(duplicate)],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
    expect(() => {
      createTestSixb({
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
      createTestSixb({
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
      createTestSixb({
        ontology: [Room],
        actions: [actionDefinition(unknownAction)],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
  })

  test("rejects action definitions without writeback or edits", () => {
    const invalidAction = {
      kind: "action",
      id: "noMutation",
      binding: { kind: "global" },
      params: {},
      phases: { validate: [] },
    } as unknown as ActionDefinition

    expect(() => {
      createTestSixb({
        ontology: [Room],
        actions: [invalidAction],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
    expect(() => {
      createTestSixb({
        ontology: [Room],
        actions: [invalidAction],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Action "noMutation" must declare .writeback(...) or .edits(...).')
  })

  test("rejects action definitions with effects but no edits", () => {
    const invalidAction = {
      kind: "action",
      id: "effectsOnly",
      binding: { kind: "global" },
      params: {},
      phases: {
        validate: [],
        writeback: () => {},
        effects: () => {},
      },
    } as unknown as ActionDefinition

    expect(() => {
      createTestSixb({
        ontology: [Room],
        actions: [invalidAction],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
    expect(() => {
      createTestSixb({
        ontology: [Room],
        actions: [invalidAction],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Action "effectsOnly" cannot declare .effects(...) without .edits(...).')
  })
})

describe("requestAction", () => {
  test("rejects unknown action", async () => {
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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

  test("preserves omitted and null params as distinct values", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "nullable-action-test",
      ontology: [Room],
      actions: [actionDefinition(updateRoomCategory)],
      ...runtimeDeps,
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const omitted = await sixb.objects(Room).requestAction({
      id: "room:1",
      action: updateRoomCategory,
      params: {},
      runId: "act_nullable_omitted",
    })
    const cleared = await sixb.objects(Room).requestAction({
      id: "room:1",
      action: updateRoomCategory,
      params: { category: null, relatedRoom: null, reviewedAt: null },
      runId: "act_nullable_cleared",
    })

    const events = await sixb.events.read({ types: ["action.requested"] })

    expect(omitted.params).toEqual({})
    expect(cleared.params).toEqual({
      category: null,
      relatedRoom: null,
      reviewedAt: null,
    })
    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        action: updateRoomCategory,
        params: { category: null, relatedRoom: null, reviewedAt: null },
        runId: cleared.id,
      })
    ).resolves.toEqual(cleared)
    expect(
      events.map((event) => (event.type === "action.requested" ? event.payload.params : null))
    ).toEqual([{}, { category: null, relatedRoom: null, reviewedAt: null }])

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        action: updateRoomCategory,
        params: { category: null },
        runId: omitted.id,
      })
    ).rejects.toThrow("different request payload")
  })

  test("enforces required and nullable validation independently", async () => {
    const sixb = createTestSixb({
      id: "nullable-action-test",
      ontology: [Room],
      actions: [
        actionDefinition(setTemperature),
        actionDefinition(updateRoomCategory),
        actionDefinition(recordNullableNote),
      ],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb.actions.request({ actionId: "recordNullableNote", params: {} })
    ).rejects.toThrow("Missing required param 'note'")

    await expect(
      sixb.actions.request({ actionId: "recordNullableNote", params: { note: null } })
    ).resolves.toMatchObject({ status: "succeeded", params: { note: null } })

    await expect(
      sixb.actions.request({
        actionId: "setTemperature",
        subject: { kind: "object", objectTypeId: "Room", primaryId: "room:1" },
        params: { target: null },
      })
    ).rejects.toThrow("Action param Room.setTemperature.target cannot be null")

    await expect(
      sixb.actions.request({
        actionId: "updateRoomCategory",
        subject: { kind: "object", objectTypeId: "Room", primaryId: "room:1" },
        params: { category: "unsupported" },
      })
    ).rejects.toThrow("must be one of: general_services, construction")
  })

  test("canonicalizes exact decimal params and rejects JS numbers", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "decimal-action-test",
      ontology: [],
      actions: [actionDefinition(recordExactAmount)],
      ...runtimeDeps,
    })

    const requested = await sixb.actions.request({
      actionId: "recordExactAmount",
      params: { amount: "+009007199254740993.0100" } as never,
    })

    expect(requested.params).toEqual({ amount: "9007199254740993.01" })
    await expect(
      sixb.actions.request({
        actionId: "recordExactAmount",
        params: { amount: 1.1 } as never,
      })
    ).rejects.toThrow("must be an exact decimal string")
  })

  test("accepts object ref params", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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

  test("fails the run, not the request, when the target object is missing", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      onError: () => {},
      ...runtimeDeps,
    })

    const run = await sixb.objects(Room).requestAction({
      id: "room:missing",
      actionId: "setTemperature",
      params: { target: 72 },
    })

    expect(run).toMatchObject({
      status: "failed",
      phase: "validation",
      error: { code: "action.phase_failed", details: { phase: "validation" } },
    })
  })

  test("runs the Action under its own execution and announces its lifecycle", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    let invoked = 0
    const counted = defineAction("counted")
      .on(Room)
      .params({})
      .writeback(() => {
        invoked += 1
      })
    let enqueued = 0
    const enqueue = runtimeDeps.queues.actions.enqueue.bind(runtimeDeps.queues.actions)
    runtimeDeps.queues.actions.enqueue = async (input) => {
      enqueued += 1
      return enqueue(input)
    }
    const sixb = createTestSixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(counted)],
      ...runtimeDeps,
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const run = await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "counted",
    })

    expect(invoked).toBe(1)
    expect(enqueued).toBe(0)
    expect(run.id.startsWith("act_")).toBe(true)
    expect(run).toMatchObject({
      actionId: "counted",
      status: "succeeded",
      subject: {
        kind: "object",
        objectTypeId: "Room",
        primaryId: "room:1",
      },
      params: {},
      idempotencyKey: `action:action-test:${run.id}`,
      writeback: { status: "succeeded", result: null },
    })
    expect(
      await runtimeDeps.storage.actionRuns!.getById({ projectId: "action-test", id: run.id })
    ).toEqual(run)
    expect(
      await runtimeDeps.storage.executions.getById({
        projectId: "action-test",
        id: run.executionId,
      })
    ).toMatchObject({
      executor: { type: "primitive", kind: "action", runId: run.id },
      source: { type: "execution", executionId: sixb.execution.id },
      correlationId: sixb.execution.correlationId,
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "action", id: "counted", runId: run.id },
      },
    })
    expect(
      await runtimeDeps.storage.executions.getById({
        projectId: "action-test",
        id: sixb.execution.id,
      })
    ).toMatchObject({
      id: sixb.execution.id,
      correlationId: sixb.execution.correlationId,
    })

    const events = await sixb.events.read({ types: ["action.requested", "action.completed"] })
    expect(events.map((event) => [event.type, event.correlationId])).toEqual([
      ["action.requested", sixb.execution.correlationId],
      ["action.completed", sixb.execution.correlationId],
    ])
    expect(events[0]?.payload).toEqual({
      actionId: "counted",
      subject: { kind: "object", objectTypeId: "Room", primaryId: "room:1" },
      params: {},
      runId: run.id,
    })
    expect(events[1]).toMatchObject({
      idempotencyKey: `action.completed:${run.id}`,
      payload: { actionId: "counted", runId: run.id, finishedAt: run.finishedAt?.toISOString() },
    })
  })

  test("rolls back the Action execution when run persistence fails", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "action-atomic-dispatch-test",
      ontology: [Room],
      actions: [actionDefinition(setTemperature)],
      ...runtimeDeps,
    })
    let childExecutionId: string | undefined
    const restore = decorateOperationScopedMethodForTesting(
      runtimeDeps.storage.actionRuns,
      "queue",
      (queue) => async (input) => {
        childExecutionId = input.executionId
        await queue(input)
        throw new Error("injected Action run persistence failure")
      }
    )

    try {
      await expect(
        sixb.objects(Room).requestAction({
          id: "room:1",
          actionId: "setTemperature",
          params: { target: 72 },
          runId: "act_atomic_failure",
        })
      ).rejects.toThrow("injected Action run persistence failure")
    } finally {
      restore()
    }

    expect(childExecutionId).toBeString()
    expect(
      await runtimeDeps.storage.actionRuns.getById({
        projectId: "action-atomic-dispatch-test",
        id: "act_atomic_failure",
      })
    ).toBeNull()
    expect(
      childExecutionId
        ? await runtimeDeps.storage.executions.getById({
            projectId: "action-atomic-dispatch-test",
            id: childExecutionId,
          })
        : undefined
    ).toBeNull()
  })

  test("runs the Action when the action.requested observation event fails", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const host = new SixbHost({
      id: "action-event-best-effort-test",
      ontology: [Room],
      actions: [actionDefinition(createRoom)],
      onError: () => {},
      ...runtimeDeps,
    })
    const sixb = createTestSixb(host)
    const originalAppend = host.events.append.bind(host.events)

    host.events.append = async (input) => {
      if (input.events.some((event) => event.type === "action.requested")) {
        throw new Error("event store unavailable")
      }

      return originalAppend(input)
    }

    try {
      const run = await sixb.actions.request({
        actionId: "createRoom",
        params: { id: "room:1", name: "Room 1" },
        runId: "act_event_failure",
      })

      expect(run).toMatchObject({ id: "act_event_failure", status: "succeeded" })
      expect(await sixb.objects(Room).get("room:1")).not.toBeNull()
      expect(await sixb.events.read({ types: ["action.requested"] })).toHaveLength(0)
      expect(await sixb.events.read({ types: ["action.completed"] })).toHaveLength(1)
    } finally {
      host.events.append = originalAppend
    }
  })

  test("answers a reused run id with its terminal run and rejects conflicting payloads", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    let writebacks = 0
    const countedTemperature = defineAction("setTemperature")
      .on(Room)
      .params({ target: param("double") })
      .writeback(() => {
        writebacks += 1
      })
    const sixb = createTestSixb({
      id: "action-idempotency-test",
      ontology: [Room],
      actions: [actionDefinition(countedTemperature)],
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

    expect(first).toMatchObject({ id: "act_fixed", status: "succeeded" })
    expect(second).toEqual(first)
    expect(writebacks).toBe(1)
    expect(await sixb.events.read({ types: ["action.requested"] })).toHaveLength(1)

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: { target: 73 },
        runId: "act_fixed",
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })

  // Guard proof: return the existing run from `reuseActionRun` in `actions/run-persistence.ts`
  // whatever its status, and the second request resolves with a run that is still executing.
  test("refuses a run id while its run is executing, then answers with its outcome", async () => {
    let writebacks = 0
    let releaseWriteback = () => {}
    const writebackStarted = Promise.withResolvers<void>()
    const slow = defineAction("slow")
      .params({})
      .writeback(async () => {
        writebacks += 1
        writebackStarted.resolve()
        await new Promise<void>((resolve) => {
          releaseWriteback = resolve
        })
      })
    const sixb = createTestSixb({
      id: "action-in-progress-test",
      ontology: [Room],
      actions: [actionDefinition(slow)],
      ...createTestRuntimeDeps(),
    })

    const first = sixb.actions.request({ actionId: "slow", runId: "act_shared" })
    await writebackStarted.promise
    await expect(
      sixb.actions.request({ actionId: "slow", runId: "act_shared" })
    ).rejects.toMatchObject({
      code: "action.run_in_progress",
      retryable: true,
      message: "[Sixb] Action run 'act_shared' is already in progress.",
    })

    releaseWriteback()
    const finished = await first
    expect(finished).toMatchObject({ id: "act_shared", status: "succeeded" })
    await expect(sixb.actions.request({ actionId: "slow", runId: "act_shared" })).resolves.toEqual(
      finished
    )
    expect(writebacks).toBe(1)
  })

  // Both requests may persist before either sees the other: the serializable insert lets one win,
  // and the other then finds a run that is still executing.
  test("executes a run id once when two requests race for it", async () => {
    let writebacks = 0
    const release = Promise.withResolvers<void>()
    const slow = defineAction("slow")
      .params({})
      .writeback(async () => {
        writebacks += 1
        await release.promise
      })
    const sixb = createTestSixb({
      id: "action-race-test",
      ontology: [Room],
      actions: [actionDefinition(slow)],
      ...createTestRuntimeDeps(),
    })

    const requests = [
      sixb.actions.request({ actionId: "slow", runId: "act_raced" }),
      sixb.actions.request({ actionId: "slow", runId: "act_raced" }),
    ]
    // The winner holds its writeback open, so the request that settles first is the refused one.
    const refused = await Promise.race(requests.map((request) => request.catch((error) => error)))
    expect(refused).toMatchObject({ code: "action.run_in_progress" })

    release.resolve()
    const outcomes = await Promise.allSettled(requests)
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(outcomes.find((outcome) => outcome.status === "fulfilled")).toMatchObject({
      value: { id: "act_raced", status: "succeeded" },
    })
    expect(writebacks).toBe(1)
  })

  test("calls onRequested once the run is durable and before it executes", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const calls: string[] = []
    const recorded = defineAction("recorded")
      .params({})
      .writeback(() => {
        calls.push("writeback")
      })
    const sixb = createTestSixb({
      id: "action-on-requested-test",
      ontology: [Room],
      actions: [actionDefinition(recorded)],
      ...runtimeDeps,
    })

    const run = await sixb.actions.request({
      actionId: "recorded",
      runId: "act_hooked",
      onRequested: async (runId) => {
        const stored = await runtimeDeps.storage.actionRuns.getById({
          projectId: "action-on-requested-test",
          id: runId,
        })
        calls.push(`requested:${runId}:${stored?.status}`)
      },
    })

    expect(run.status).toBe("succeeded")
    expect(calls).toEqual(["requested:act_hooked:queued", "writeback"])
  })

  // Guard proof: drop `failUnexecuted` from `actions/run/executor.ts` and the run stays queued, so
  // its id is refused as in progress forever.
  test("fails a run unexecuted when onRequested throws", async () => {
    let writebacks = 0
    const recorded = defineAction("recorded")
      .params({})
      .writeback(() => {
        writebacks += 1
      })
    const reports: string[] = []
    const sixb = createTestSixb({
      id: "action-on-requested-failure-test",
      ontology: [Room],
      actions: [actionDefinition(recorded)],
      onError: (_error, context) => {
        reports.push(context.type)
      },
      ...createTestRuntimeDeps(),
    })
    const hookError = new Error("caller withdrew")

    await expect(
      sixb.actions.request({
        actionId: "recorded",
        runId: "act_withdrawn",
        onRequested: () => {
          throw hookError
        },
      })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      message: expect.stringContaining("Action run 'act_withdrawn' was requested"),
      cause: hookError,
    })

    await expect(
      sixb.actions.request({ actionId: "recorded", runId: "act_withdrawn" })
    ).resolves.toMatchObject({
      status: "failed",
      phase: "request",
      error: { code: "internal.unexpected", details: { phase: "request" } },
    })
    expect(writebacks).toBe(0)
    expect(await sixb.events.read({ types: ["action.requested"] })).toHaveLength(0)
    await flushSixbErrors(sixb)
    expect(reports).toEqual(["run.failed"])
  })

  // Guard proofs: drop the catch that calls `failRequest` in `ActionRunExecutor.execute`
  // (`actions/run/executor.ts`), and the request rejects uncoded, a 400 over HTTP, with nothing
  // reported. Throw the handler's error from `runAction` (`actions/run/run-action.ts`) instead of
  // an `UnrecordedActionRunError`, and the report loses the phase the run failed in.
  test("fails the request as internal.unexpected when a run's outcome cannot be recorded", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const leaky = defineAction("leaky")
      .params({})
      .writeback(() => {
        throw new Error("secret-token-123 rejected by upstream")
      })
    const reports: SixbErrorContext[] = []
    const sixb = createTestSixb({
      id: "action-unrecorded-test",
      ontology: [Room],
      actions: [actionDefinition(leaky)],
      onError: (_error, context) => {
        reports.push(context)
      },
      ...runtimeDeps,
    })
    const restore = decorateOperationScopedMethodForTesting(
      runtimeDeps.storage.actionRuns,
      "finish",
      () => async () => {
        throw new Error("storage unavailable")
      }
    )

    let failure: unknown
    try {
      failure = await sixb.actions.request({ actionId: "leaky", runId: "act_unrecorded" }).then(
        () => undefined,
        (error: unknown) => error
      )
    } finally {
      restore()
    }

    expect(failure).toMatchObject({
      code: "internal.unexpected",
      message:
        "[Sixb] Action run 'act_unrecorded' was requested, but its record could not be " +
        "returned. Request it again with the same runId to get it.",
      details: { actionId: "leaky", runId: "act_unrecorded" },
    })
    await flushSixbErrors(sixb)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      type: "run.failed",
      run: { actionId: "leaky", runId: "act_unrecorded" },
      failure: { code: "action.phase_failed", details: { phase: "writeback" } },
    })
  })

  test("persists nothing for a caller that has already aborted", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "action-aborted-caller-test",
      ontology: [Room],
      actions: [actionDefinition(createRoom)],
      ...runtimeDeps,
    })
    const reason = new Error("caller gave up")

    await expect(
      sixb.actions.request({
        actionId: "createRoom",
        params: { id: "room:1", name: "Room 1" },
        runId: "act_aborted",
        signal: AbortSignal.abort(reason),
      })
    ).rejects.toBe(reason)
    expect(
      await runtimeDeps.storage.actionRuns.getById({
        projectId: "action-aborted-caller-test",
        id: "act_aborted",
      })
    ).toBeNull()
  })

  test("fails the run when custom validation rejects it", async () => {
    let writebacks = 0
    const guardedTemperature = defineAction("setTemperature")
      .on(Room)
      .params({ target: param("double") })
      .validate(({ params }) => (params.target < 10 ? { error: "Target is too low" } : undefined))
      .writeback(() => {
        writebacks += 1
      })
    const sixb = createTestSixb({
      id: "action-test",
      ontology: [Room],
      actions: [actionDefinition(guardedTemperature)],
      onError: () => {},
      ...createTestRuntimeDeps(),
    })

    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const run = await sixb.objects(Room).requestAction({
      id: "room:1",
      actionId: "setTemperature",
      params: { target: 5 },
    })

    expect(run).toMatchObject({
      status: "failed",
      error: { code: "action.phase_failed", details: { phase: "validation" } },
    })
    expect(writebacks).toBe(0)
    expect(await sixb.events.read({ types: ["action.failed"] })).toMatchObject([
      { payload: { runId: run.id, error: run.error } },
    ])
  })

  test("allows inherited actions on subtypes", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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
    expect(result).toMatchObject({ status: "succeeded", subject: { kind: "none" } })
    expect(events.length).toBe(1)
    if (events[0].type === "action.requested") {
      expect(events[0].payload).toEqual({
        actionId: "createRoom",
        subject: { kind: "none" },
        params: { id: "room:1", name: "Room 1" },
        runId: result.id,
      })
    }
  })

  test("rejects invalid global action param schemas before emitting an event", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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
    const sixb = createTestSixb({
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

describe("drainActionRuns", () => {
  function createDrainHost(id: string, actions: readonly ActionDefinition[]) {
    const runtimeDeps = createTestRuntimeDeps()
    const host = new SixbHost({ id, ontology: [Room], actions, ...runtimeDeps })
    return { host, storage: runtimeDeps.storage, sixb: createTestSixb(host) }
  }

  // Guard proof: in `ActionRunExecutor.request` (`actions/run/executor.ts`), track a request only
  // once `persist` resolves, and the drain returns while the run is still being persisted.
  test("waits for a request that is still persisting its run", async () => {
    const calls: string[] = []
    const quick = defineAction("quick")
      .params({})
      .writeback(() => {
        calls.push("writeback")
      })
    const { host, storage, sixb } = createDrainHost("action-drain-persisting-test", [
      actionDefinition(quick),
    ])
    const persisting = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const restore = decorateOperationScopedMethodForTesting(
      storage.actionRuns,
      "queue",
      (queue) => async (input) => {
        persisting.resolve()
        await release.promise
        return queue(input)
      }
    )

    try {
      const request = sixb.actions.request({ actionId: "quick", runId: "act_persisting" })
      await persisting.promise
      const drained = drainActionRuns(host, 5_000).then(() => {
        calls.push("drained")
      })
      release.resolve()

      await expect(request).resolves.toMatchObject({ status: "succeeded" })
      await drained
    } finally {
      restore()
    }
    expect(calls).toEqual(["writeback", "drained"])
  })

  // Guard proof: drop the `stopping` check from `ActionRunExecutor.request`
  // (`actions/run/executor.ts`), and the stopping runtime persists and runs the request.
  test("refuses a request once draining started, before persisting anything", async () => {
    let writebacks = 0
    const quick = defineAction("quick")
      .params({})
      .writeback(() => {
        writebacks += 1
      })
    const { host, storage } = createDrainHost("action-drain-refusal-test", [
      actionDefinition(quick),
    ])
    const late = createTestSixb(host, {
      executionId: "exec_after_drain",
      requestId: "request_after_drain",
      correlationId: "correlation_after_drain",
    })

    await drainActionRuns(host, 1_000)

    await expect(
      late.actions.request({ actionId: "quick", runId: "act_after_drain" })
    ).rejects.toMatchObject({
      code: "runtime.stopping",
      retryable: true,
      message: "[Sixb] The runtime is stopping and starts no new Action run; retry the request.",
    })
    expect(writebacks).toBe(0)
    expect(
      await storage.actionRuns.getById({ projectId: host.id, id: "act_after_drain" })
    ).toBeNull()
    expect(
      await storage.executions.getById({ projectId: host.id, id: "exec_after_drain" })
    ).toBeNull()
  })

  // Guard proof: make `ActionRunExecutor.drain` (`actions/run/executor.ts`) wait for its runs
  // without a bound, and this test outlasts its own timeout.
  test("stops waiting at its timeout and says how many runs it leaves", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stuck = defineAction("stuck")
      .params({})
      .writeback(async () => {
        started.resolve()
        await release.promise
      })
    const { host, sixb } = createDrainHost("action-drain-timeout-test", [actionDefinition(stuck)])

    const request = sixb.actions.request({ actionId: "stuck", runId: "act_stuck" })
    await started.promise
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    try {
      await drainActionRuns(host, 10)
      expect(consoleError).toHaveBeenCalledWith(
        "[Sixb] Stopped waiting after 10 ms for 1 in-flight Action run(s)."
      )
    } finally {
      consoleError.mockRestore()
    }

    release.resolve()
    await expect(request).resolves.toMatchObject({ status: "succeeded" })
  })

  test("names what it was given when that is not a host", async () => {
    await expect(drainActionRuns({}, 0)).rejects.toThrow(
      "[Sixb] Cannot drain Action runs: this object is not a SixbHost."
    )
  })
})
