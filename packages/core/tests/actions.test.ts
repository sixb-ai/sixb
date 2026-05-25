import { describe, expect, test } from "bun:test"
import {
  ActionDefinitionError,
  ActionValidationError,
  actionParam,
  defineAction,
  defineObjectType,
  ObjectNotFoundError,
  OntologyValidationError,
  Pario,
  prop,
  ref,
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
  .params({ target: actionParam("double", { required: true }) })
  .validate(({ params }) => {
    if (params.target < 10) {
      return { error: "Target is too low" }
    }
  })
  .run(async () => {})

const reboot = defineAction("reboot")
  .target(Room)
  .params({})
  .run(async () => {})

const createRoom = defineAction("createRoom")
  .params({
    id: actionParam("string", { required: true }),
    name: actionParam("string", { required: true }),
  })
  .validate(({ params }) => {
    if (!params.id.startsWith("room:")) {
      return { error: "Room id must start with room:" }
    }
  })
  .run(async () => {})

const prepareSuite = defineAction("prepareSuite")
  .target(SuiteRoom)
  .params({ note: actionParam("string") })
  .run(async () => {})

const attachRelatedRoom = defineAction("attachRelatedRoom")
  .target(Room)
  .params({
    relatedRoom: actionParam(ref(Room), { required: true }),
  })
  .run(async () => {})

describe("defineAction", () => {
  test("builds an inert typed action definition", () => {
    expect(setTemperature.kind).toBe("action")
    expect(setTemperature.binding.kind).toBe("object")
    expect(setTemperature.id).toBe("setTemperature")
    expect(setTemperature.target.id).toBe("Room")
    expect(setTemperature.params.target.schema).toBe("double")
    expect(setTemperature.params.target.required).toBe(true)
    expect(setTemperature.validators).toHaveLength(1)
    expect(typeof setTemperature.handler).toBe("function")
    expect(setTemperature.description).toBe("Set room temperature.")
  })

  test("builds global action definitions without a target", () => {
    expect(createRoom.kind).toBe("action")
    expect(createRoom.binding.kind).toBe("global")
    expect(createRoom.target).toBeUndefined()
    expect(createRoom.params.id.required).toBe(true)
    expect(createRoom.validators).toHaveLength(1)
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
    const pario = new Pario({
      id: "action-registry-test",
      ontology: [Room, SuiteRoom],
      actions: [setTemperature, reboot, prepareSuite, createRoom],
      ...createTestRuntimeDeps(),
    })

    expect(pario.getActionDefinitions().map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
      "prepareSuite",
      "createRoom",
    ])
    expect(pario.getActionById("reboot")?.id).toBe(reboot.id)
    expect(pario.getGlobalActions().map((action) => action.id)).toEqual(["createRoom"])
    expect(pario.getActionsForType(Room).map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
    ])
    expect(pario.getActionsForType(SuiteRoom).map((action) => action.id)).toEqual([
      "setTemperature",
      "reboot",
      "prepareSuite",
    ])
  })

  test("rejects duplicate action ids", () => {
    const duplicate = defineAction("reboot")
      .target(Room)
      .params({})
      .run(async () => {})

    expect(() => {
      new Pario({
        ontology: [Room],
        actions: [reboot, duplicate],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
    expect(() => {
      new Pario({
        ontology: [Room],
        actions: [reboot, duplicate],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('Duplicate action id "reboot"')
  })

  test("rejects duplicate action ids in inheritance chains with a precise error", () => {
    const suiteOverride = defineAction("setTemperature")
      .target(SuiteRoom)
      .params({})
      .run(async () => {})

    expect(() => {
      new Pario({
        ontology: [Room, SuiteRoom],
        actions: [setTemperature, suiteOverride],
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
      .target(Unknown)
      .params({})
      .run(async () => {})

    expect(() => {
      new Pario({
        ontology: [Room],
        actions: [unknownAction],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(ActionDefinitionError)
  })
})

describe("requestAction", () => {
  test("rejects unknown action", async () => {
    const pario = new Pario({
      id: "action-test",
      ontology: [Room],
      actions: [setTemperature, reboot],
      ...createTestRuntimeDeps(),
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "nonexistent",
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "nonexistent",
      })
    ).rejects.toThrow("Unknown action 'nonexistent'")
  })

  test("rejects actions that are not valid for the object type", async () => {
    const pario = new Pario({
      id: "action-test",
      ontology: [Room, SuiteRoom],
      actions: [setTemperature, prepareSuite],
      ...createTestRuntimeDeps(),
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "prepareSuite",
      })
    ).rejects.toThrow("Action 'prepareSuite' is not valid for object type 'Room'")
  })

  test("rejects missing required param", async () => {
    const pario = new Pario({
      id: "action-test",
      ontology: [Room],
      actions: [setTemperature],
      ...createTestRuntimeDeps(),
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: {},
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: {},
      })
    ).rejects.toThrow("Missing required param 'target'")
  })

  test("rejects unknown param", async () => {
    const pario = new Pario({
      id: "action-test",
      ontology: [Room],
      actions: [setTemperature],
      ...createTestRuntimeDeps(),
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: { target: 72, bogus: "nope" },
      })
    ).rejects.toThrow("Unknown param 'bogus'")
  })

  test("accepts object ref params", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "action-ref-test",
      ontology: [Room],
      actions: [attachRelatedRoom],
      ...runtimeDeps,
    })

    expect(attachRelatedRoom.params.relatedRoom.schema).toEqual({
      type: "objectRef",
      objectTypeId: "Room",
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await pario.objects(Room).requestAction({
      id: "room:1",
      actionId: "attachRelatedRoom",
      params: {
        relatedRoom: { objectTypeId: "Room", primaryId: "room:2" },
      },
    })

    const events = await pario.events.read({
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
    const pario = new Pario({
      id: "action-ref-test",
      ontology: [Room],
      actions: [attachRelatedRoom],
      ...createTestRuntimeDeps(),
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "attachRelatedRoom",
        params: {
          relatedRoom: { objectTypeId: "SuiteRoom", primaryId: "suite:1" },
        },
      })
    ).rejects.toThrow('Room.attachRelatedRoom.relatedRoom.objectTypeId must be "Room"')
  })

  test("rejects object ref params without a string primary id", async () => {
    const pario = new Pario({
      id: "action-ref-test",
      ontology: [Room],
      actions: [attachRelatedRoom],
      ...createTestRuntimeDeps(),
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "attachRelatedRoom",
        params: {
          relatedRoom: { objectTypeId: "Room" },
        },
      })
    ).rejects.toThrow("Room.attachRelatedRoom.relatedRoom.primaryId must be a string")
  })

  test("rejects object ref params with unknown fields", async () => {
    const pario = new Pario({
      id: "action-ref-test",
      ontology: [Room],
      actions: [attachRelatedRoom],
      ...createTestRuntimeDeps(),
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "attachRelatedRoom",
        params: {
          relatedRoom: { objectTypeId: "Room", primaryId: "room:2", label: "Room 2" },
        },
      })
    ).rejects.toThrow("Unknown field 'Room.attachRelatedRoom.relatedRoom.label'")
  })

  test("rejects missing object", async () => {
    const pario = new Pario({
      id: "action-test",
      ontology: [Room],
      actions: [setTemperature],
      ...createTestRuntimeDeps(),
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:missing",
        actionId: "setTemperature",
        params: { target: 72 },
      })
    ).rejects.toBeInstanceOf(ObjectNotFoundError)
    await expect(
      pario.objects(Room).requestAction({
        id: "room:missing",
        actionId: "setTemperature",
        params: { target: 72 },
      })
    ).rejects.toThrow("Object not found")
  })

  test("emits action.requested event on success without invoking the handler", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    let invoked = 0
    const counted = defineAction("counted")
      .target(Room)
      .params({})
      .run(() => {
        invoked += 1
      })
    const pario = new Pario({
      id: "action-test",
      ontology: [Room],
      actions: [counted],
      ...runtimeDeps,
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const result = await pario.objects(Room).requestAction({
      id: "room:1",
      actionId: "counted",
    })

    const events = await pario.events.read({
      types: ["action.requested"],
    })
    expect(invoked).toBe(0)
    expect(result.runId.startsWith("act_")).toBe(true)
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

  test("runs validators request-side and emits no event when validation fails", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "action-test",
      ontology: [Room],
      actions: [setTemperature],
      ...runtimeDeps,
    })

    await pario.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    await expect(
      pario.objects(Room).requestAction({
        id: "room:1",
        actionId: "setTemperature",
        params: { target: 5 },
      })
    ).rejects.toBeInstanceOf(ActionValidationError)

    const events = await pario.events.read({
      types: ["action.requested"],
    })
    expect(events).toHaveLength(0)
  })

  test("allows inherited actions on subtypes", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "action-test",
      ontology: [Room, SuiteRoom],
      actions: [setTemperature],
      ...runtimeDeps,
    })

    await pario.objects(SuiteRoom).upsert({
      properties: { id: "suite:1", externalId: "S1", name: "Suite 1", tier: "vip" },
    })

    await pario.objects(SuiteRoom).requestAction({
      id: "suite:1",
      actionId: "setTemperature",
      params: { target: 72 },
    })

    const events = await pario.events.read({
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

  test("requests global actions through pario.actions", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "global-action-test",
      ontology: [Room],
      actions: [createRoom],
      ...runtimeDeps,
    })

    const result = await pario.actions.request({
      actionId: "createRoom",
      params: { id: "room:1", name: "Room 1" },
    })

    const events = await pario.events.read({
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

  test("rejects invalid global action params before emitting an event", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const pario = new Pario({
      id: "global-action-test",
      ontology: [Room],
      actions: [createRoom],
      ...runtimeDeps,
    })

    await expect(
      pario.actions.request({
        actionId: "createRoom",
        params: { id: "bad", name: "Room 1" },
      })
    ).rejects.toBeInstanceOf(ActionValidationError)

    const events = await pario.events.read({
      types: ["action.requested"],
    })
    expect(events).toHaveLength(0)
  })

  test("rejects object-scoped actions without an object subject", async () => {
    const pario = new Pario({
      id: "global-action-test",
      ontology: [Room],
      actions: [setTemperature],
      ...createTestRuntimeDeps(),
    })

    await expect(
      pario.actions.request({
        actionId: "setTemperature",
        params: { target: 72 },
      })
    ).rejects.toThrow("Action 'setTemperature' requires an object subject.")
  })

  test("rejects global actions with an object subject", async () => {
    const pario = new Pario({
      id: "global-action-test",
      ontology: [Room],
      actions: [createRoom],
      ...createTestRuntimeDeps(),
    })

    await expect(
      pario.actions.request({
        actionId: "createRoom",
        subject: { kind: "object", objectTypeId: "Room", primaryId: "room:1" },
        params: { id: "room:2", name: "Room 2" },
      })
    ).rejects.toThrow("Action 'createRoom' does not accept an object subject.")
  })
})
