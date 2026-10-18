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
import { ActionRunError, type ActionRunStorage } from "../src/storage"
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
  test("builds inert typed action definitions", () => {
    expect(setTemperature.kind).toBe("action")
    expect(setTemperature.binding.kind).toBe("object")
    expect(setTemperature.id).toBe("setTemperature")
    expect(setTemperature.binding.objectType.id).toBe("Room")
    expect(setTemperature.params.target.schema).toBe("double")
    expect(setTemperature.params.target.required).toBe(true)
    expect(setTemperature.phases.validate).toHaveLength(1)
    expect(typeof setTemperature.phases.writeback).toBe("function")
    expect(setTemperature.description).toBe("Set room temperature.")

    expect(createRoom.binding.kind).toBe("global")
    expect(createRoom.params.id.required).toBe(true)
    expect(typeof createRoom.phases.edits).toBe("function")

    expect(updateRoomCategory.params.category).toMatchObject({ required: false, nullable: true })
    expect(attachRelatedRoom.params.relatedRoom.schema).toEqual({
      type: "objectRef",
      objectTypeId: "Room",
    })
    expect(
      optional(
        param("double", {
          description: "Requested temperature",
          semanticType: "Temperature",
          nullable: true,
        })
      )
    ).toEqual({
      schema: "double",
      required: false,
      description: "Requested temperature",
      semanticType: "Temperature",
      nullable: true,
    })
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

  const Unregistered = defineObjectType({
    id: "Unknown",
    name: "Unknown",
    properties: [prop("id", "string", { required: true, primary: true })],
  })

  test.each([
    {
      name: "a duplicate id",
      ontology: [Room],
      actions: [
        reboot,
        defineAction("reboot")
          .on(Room)
          .params({})
          .writeback(async () => {}),
      ],
      message: 'Duplicate action id "reboot" declared in multiple files.',
    },
    {
      name: "a duplicate id in an inheritance chain",
      ontology: [Room, SuiteRoom],
      actions: [
        setTemperature,
        defineAction("setTemperature")
          .on(SuiteRoom)
          .params({})
          .writeback(async () => {}),
      ],
      message:
        'Duplicate action id "setTemperature" in inheritance chain of "SuiteRoom": defined on both "Room" and "SuiteRoom".',
    },
    {
      name: "an unregistered target type",
      ontology: [Room],
      actions: [
        defineAction("unknown")
          .on(Unregistered)
          .params({})
          .writeback(async () => {}),
      ],
      message: 'Action "unknown" targets unknown object type "Unknown".',
    },
    {
      name: "no writeback or edits",
      ontology: [Room],
      actions: [
        {
          kind: "action",
          id: "noMutation",
          binding: { kind: "global" },
          params: {},
          phases: { validate: [] },
        },
      ],
      message: 'Action "noMutation" must declare .writeback(...) or .edits(...).',
    },
    {
      name: "effects but no edits",
      ontology: [Room],
      actions: [
        {
          kind: "action",
          id: "effectsOnly",
          binding: { kind: "global" },
          params: {},
          phases: { validate: [], writeback: () => {}, effects: () => {} },
        },
      ],
      message: 'Action "effectsOnly" cannot declare .effects(...) without .edits(...).',
    },
  ])("rejects an action with $name", ({ ontology, actions, message }) => {
    const register = () =>
      createTestSixb({
        ontology,
        actions: actions.map(actionDefinition),
        ...createTestRuntimeDeps(),
      })

    expect(register).toThrow(ActionDefinitionError)
    expect(register).toThrow(message)
  })
})

describe("requestAction", () => {
  const room1 = { kind: "object", objectTypeId: "Room", primaryId: "room:1" } as const

  test.each([
    {
      name: "an unknown action",
      request: { actionId: "nonexistent", subject: room1 },
      message: "Unknown action 'nonexistent'",
    },
    {
      name: "an action that is not valid for the object type",
      request: { actionId: "prepareSuite", subject: room1 },
      message: "Action 'prepareSuite' is not valid for object type 'Room'",
    },
    {
      name: "an object action without an object subject",
      request: { actionId: "setTemperature", params: { target: 72 } },
      message: "Action 'setTemperature' requires an object subject.",
    },
    {
      name: "a global action with an object subject",
      request: { actionId: "createRoom", subject: room1, params: { id: "room:2", name: "Room 2" } },
      message: "Action 'createRoom' does not accept an object subject.",
    },
    {
      name: "a missing required param",
      request: { actionId: "setTemperature", subject: room1, params: {} },
      message: "Missing required param 'target'",
    },
    {
      name: "a missing required nullable param",
      request: { actionId: "recordNullableNote", params: {} },
      message: "Missing required param 'note'",
    },
    {
      name: "an unknown param",
      request: {
        actionId: "setTemperature",
        subject: room1,
        params: { target: 72, bogus: "nope" },
      },
      message: "Unknown param 'bogus'",
    },
    {
      name: "a null non-nullable param",
      request: { actionId: "setTemperature", subject: room1, params: { target: null } },
      message: "Action param Room.setTemperature.target cannot be null",
    },
    {
      name: "a param of the wrong type",
      request: { actionId: "createRoom", params: { id: "room:1", name: 42 } },
      message: "Property createRoom.name must be a string",
    },
    {
      name: "an enum param outside its values",
      request: {
        actionId: "updateRoomCategory",
        subject: room1,
        params: { category: "unsupported" },
      },
      message: "must be one of: general_services, construction",
    },
    {
      name: "a JS number for a decimal param",
      request: { actionId: "recordExactAmount", params: { amount: 1.1 } },
      message: "must be an exact decimal string",
    },
    {
      name: "an object ref param of the wrong object type",
      request: {
        actionId: "attachRelatedRoom",
        subject: room1,
        params: { relatedRoom: { objectTypeId: "SuiteRoom", primaryId: "suite:1" } },
      },
      message: 'Room.attachRelatedRoom.relatedRoom.objectTypeId must be "Room"',
    },
    {
      name: "an object ref param without a string primary id",
      request: {
        actionId: "attachRelatedRoom",
        subject: room1,
        params: { relatedRoom: { objectTypeId: "Room" } },
      },
      message: "Room.attachRelatedRoom.relatedRoom.primaryId must be a string",
    },
    {
      name: "an object ref param with unknown fields",
      request: {
        actionId: "attachRelatedRoom",
        subject: room1,
        params: { relatedRoom: { objectTypeId: "Room", primaryId: "room:2", label: "Room 2" } },
      },
      message: "Unknown field 'Room.attachRelatedRoom.relatedRoom.label'",
    },
  ])("rejects $name before recording a run", async ({ request, message }) => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "action-request-test",
      ontology: [Room, SuiteRoom],
      actions: [
        setTemperature,
        prepareSuite,
        createRoom,
        attachRelatedRoom,
        updateRoomCategory,
        recordNullableNote,
        recordExactAmount,
      ].map(actionDefinition),
      ...runtimeDeps,
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })

    const rejected = sixb.actions.request(request as Parameters<typeof sixb.actions.request>[0])

    await expect(rejected).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(rejected).rejects.toThrow(message)
    const { runs } = await runtimeDeps.storage.actionRuns.list({ projectId: "action-request-test" })
    expect(runs).toHaveLength(0)
  })

  test("stores accepted params in their canonical form", async () => {
    const sixb = createTestSixb({
      id: "action-params-test",
      ontology: [Room],
      actions: [attachRelatedRoom, recordNullableNote, recordExactAmount].map(actionDefinition),
      ...createTestRuntimeDeps(),
    })
    await sixb.objects(Room).upsert({
      properties: { id: "room:1", externalId: "R1", name: "Room 1" },
    })
    const relatedRoom = { objectTypeId: "Room", primaryId: "room:2" }

    await expect(
      sixb.actions.request({ actionId: "recordNullableNote", params: { note: null } })
    ).resolves.toMatchObject({ status: "succeeded", params: { note: null } })
    await expect(
      sixb.actions.request({
        actionId: "recordExactAmount",
        params: { amount: "+009007199254740993.0100" } as never,
      })
    ).resolves.toMatchObject({ status: "succeeded", params: { amount: "9007199254740993.01" } })
    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        actionId: "attachRelatedRoom",
        params: { relatedRoom },
      })
    ).resolves.toMatchObject({ status: "succeeded", params: { relatedRoom } })
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

    await expect(
      sixb.objects(Room).requestAction({
        id: "room:1",
        action: updateRoomCategory,
        params: { category: null },
        runId: omitted.id,
      })
    ).rejects.toThrow("different request payload")
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

  test("runs the Action under its own execution", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    let invoked = 0
    const counted = defineAction("counted")
      .on(Room)
      .params({})
      .writeback(() => {
        invoked += 1
      })
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
  })

  // Guard proof: drop the `executing` check from `ActionRunExecutor.request`
  // (`actions/run/executor.ts`), and the second request runs the writeback a second time.
  test("refuses a run id while its run is executing, then answers with its outcome", async () => {
    let writebacks = 0
    let releaseWriteback = () => {}
    const writebackStarted = Promise.withResolvers<void>()
    const slow = defineAction("slow")
      .params({})
      .writeback(async () => {
        writebacks += 1
        // Only the first execution waits, so a second one ends the test instead of hanging it.
        if (writebacks > 1) return
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

  // Neither request finds a record when it starts: this process knows the run id is executing, and
  // refuses the one that comes second. Guard proof: as for the test above.
  test("executes a run id once when two requests race for it", async () => {
    let writebacks = 0
    const release = Promise.withResolvers<void>()
    const slow = defineAction("slow")
      .params({})
      .writeback(async () => {
        writebacks += 1
        // Only the first execution waits, so a second one ends the test instead of hanging it.
        if (writebacks === 1) await release.promise
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

  // Requests on two hosts that share storage stand for two processes: neither knows the other is
  // executing the run id. Guard proof: refuse every `ActionRunError` from `record` in `recordRun`
  // (`actions/run/run-action.ts`), and the request that records second rejects.
  test("answers both requests with one record when two processes run the same run id", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const release = Promise.withResolvers<void>()
    let writebacks = 0
    const slow = defineAction("slow")
      .params({})
      .writeback(async () => {
        started[writebacks]?.resolve()
        writebacks += 1
        await release.promise
        return { writeback: writebacks }
      })
      .edits(() => {})
    const hosts = ["first", "second"].map(
      () =>
        new SixbHost({
          id: "action-two-process-test",
          ontology: [Room],
          actions: [actionDefinition(slow)],
          ...runtimeDeps,
        })
    )

    const requests = hosts.map((host, index) =>
      createTestSixb(host, {
        executionId: `exec_request_${index}`,
        requestId: `request_${index}`,
        correlationId: `correlation_${index}`,
      }).actions.request({ actionId: "slow", runId: "act_shared" })
    )
    await Promise.all(started.map((deferred) => deferred.promise))
    release.resolve()
    const [first, second] = await Promise.all(requests)

    // Both writebacks ran: that is what `run.idempotencyKey` is for.
    expect(writebacks).toBe(2)
    expect(second).toEqual(first)
    const listed = await runtimeDeps.storage.actionRuns.list({
      projectId: "action-two-process-test",
    })
    expect(listed.runs).toEqual([first])
    const commits = await runtimeDeps.storage.ontology.commits.list({
      projectId: "action-two-process-test",
      run: { kind: "action", id: "act_shared" },
    })
    expect(commits.commits).toHaveLength(1)
  })

  // Guard proof: compare the payload in `findRecordedRun` (`actions/run/run-action.ts`) again, and
  // the second request fails as `internal.unexpected`, reported to `onError`, for a run that
  // succeeded.
  test("refuses a run id that another process recorded first for another request", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const release = Promise.withResolvers<void>()
    let writebacks = 0
    const slow = defineAction("slow")
      .params({ n: param("double") })
      .writeback(async () => {
        started[writebacks]?.resolve()
        writebacks += 1
        await release.promise
      })
    const reports: string[] = []
    const hosts = [0, 1].map(
      () =>
        new SixbHost({
          id: "action-two-process-payload-test",
          ontology: [Room],
          actions: [actionDefinition(slow)],
          onError: (_error, context) => {
            reports.push(context.type)
          },
          ...runtimeDeps,
        })
    )
    const requests = hosts.map((host, index) =>
      createTestSixb(host, {
        executionId: `exec_request_${index}`,
        requestId: `request_${index}`,
        correlationId: `correlation_${index}`,
      })
        .actions.request({ actionId: "slow", params: { n: index }, runId: "act_shared" })
        .then(
          (run) => run,
          (error: unknown) => error
        )
    )
    await Promise.all(started.map((deferred) => deferred.promise))
    release.resolve()
    const outcomes = await Promise.all(requests)

    const recorded = outcomes.find((outcome) => !(outcome instanceof Error))
    const refused = outcomes.find((outcome) => outcome instanceof Error)
    expect(recorded).toMatchObject({ id: "act_shared", status: "succeeded" })
    expect(refused).toBeInstanceOf(ActionRunError)
    expect(refused instanceof Error ? refused.message : refused).toBe(
      "[Sixb] Action run 'act_shared' already exists with a different request payload."
    )
    await Promise.all(hosts.map((host) => flushSixbErrors(host)))
    expect(reports).toEqual([])
  })

  // Guard proof: answer `action.run_in_progress` from `joinHeldRunId`
  // (`actions/run/executor.ts`) without `assertCanReuseActionRun`, and the request for another
  // payload is refused as in progress instead.
  test("refuses another payload for a run id it is executing as it would a recorded one", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const slow = defineAction("slow")
      .params({ n: param("double") })
      .writeback(async () => {
        started.resolve()
        await release.promise
      })
    const sixb = createTestSixb({
      id: "action-in-progress-payload-test",
      ontology: [Room],
      actions: [actionDefinition(slow)],
      ...createTestRuntimeDeps(),
    })

    const first = sixb.actions.request({ actionId: "slow", params: { n: 1 }, runId: "act_held" })
    await started.promise
    const refused = await sixb.actions
      .request({ actionId: "slow", params: { n: 2 }, runId: "act_held" })
      .then(
        () => undefined,
        (error: unknown) => error
      )
    release.resolve()
    await first

    expect(refused).toBeInstanceOf(ActionRunError)
    expect(refused instanceof Error ? refused.message : refused).toBe(
      "[Sixb] Action run 'act_held' already exists with a different request payload."
    )
  })

  // Guard proof: in `ActionRunExecutor.dispatch` (`actions/run/executor.ts`), refuse a run id as
  // in progress as soon as a request holds it, and the second replay below gets
  // `action.run_in_progress` while the first one looks the record up.
  test("answers concurrent replays of a recorded run with its record", async () => {
    const quick = defineAction("quick")
      .params({})
      .writeback(() => {})
    const sixb = createTestSixb({
      id: "action-concurrent-replay-test",
      ontology: [Room],
      actions: [actionDefinition(quick)],
      ...createTestRuntimeDeps(),
    })
    const run = await sixb.actions.request({ actionId: "quick", runId: "act_replayed" })

    await expect(
      Promise.all([
        sixb.actions.request({ actionId: "quick", runId: "act_replayed" }),
        sixb.actions.request({ actionId: "quick", runId: "act_replayed" }),
      ])
    ).resolves.toEqual([run, run])
  })

  // Guard proof: answer `action.run_in_progress` from `joinHeldRunId`
  // (`actions/run/executor.ts`) without looking the record up, and the request that comes once the
  // run is recorded, while its request still holds the run id, is refused as in progress.
  test("answers with the record a request still holding the run id has written", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const quick = defineAction("quick")
      .params({})
      .writeback(() => {})
    const host = new SixbHost({
      id: "action-recorded-held-test",
      ontology: [Room],
      actions: [actionDefinition(quick)],
      ...runtimeDeps,
    })
    const sixb = createTestSixb(host)
    const actionRuns = runtimeDeps.storage.actionRuns
    const recorded = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // The request waits once its record is written, outside the storage lock that a decorated
    // storage method would hold.
    const holdingActionRuns: ActionRunStorage = {
      record: async (input) => {
        const stored = await actionRuns.record(input)
        recorded.resolve()
        await release.promise
        return stored
      },
      recordEffects: (input) => actionRuns.recordEffects(input),
      getById: (params) => actionRuns.getById(params),
      getByExecutionIds: (params) => actionRuns.getByExecutionIds(params),
      list: (input) => actionRuns.list(input),
    }
    Object.defineProperty(runtimeDeps.storage, "actionRuns", { value: holdingActionRuns })

    const first = sixb.actions.request({ actionId: "quick", runId: "act_held" })
    await recorded.promise
    const second = sixb.actions.request({ actionId: "quick", runId: "act_held" })
    const stored = await actionRuns.getById({ projectId: host.id, id: "act_held" })
    if (!stored) throw new Error("The run is recorded before its request releases the run id.")
    await expect(second).resolves.toEqual(stored)
    release.resolve()
    await expect(first).resolves.toEqual(stored)
  })

  // Guard proof: drop the catch around `onRequested` in `ActionRunExecutor.execute`
  // (`actions/run/executor.ts`), and the request rejects with the hook's own, uncoded error.
  test("calls onRequested before the run executes, and starts nothing when it throws", async () => {
    const calls: string[] = []
    const recorded = defineAction("recorded")
      .params({})
      .writeback(() => {
        calls.push("writeback")
      })
    const reports: string[] = []
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = createTestSixb({
      id: "action-on-requested-test",
      ontology: [Room],
      actions: [actionDefinition(recorded)],
      onError: (_error, context) => {
        reports.push(context.type)
      },
      ...runtimeDeps,
    })
    const hookError = new Error("caller withdrew")

    await expect(
      sixb.actions.request({
        actionId: "recorded",
        runId: "act_hooked",
        onRequested: () => {
          throw hookError
        },
      })
    ).rejects.toMatchObject({
      code: "internal.unexpected",
      message:
        "[Sixb] Action run 'act_hooked' did not start: its requester failed before it executed.",
      cause: hookError,
    })
    expect(calls).toEqual([])
    expect(
      await runtimeDeps.storage.actionRuns.getById({
        projectId: "action-on-requested-test",
        id: "act_hooked",
      })
    ).toBeNull()

    // Nothing was recorded, so the same run id runs once requested again, after its hook.
    const run = await sixb.actions.request({
      actionId: "recorded",
      runId: "act_hooked",
      onRequested: async (runId) => {
        const stored = await runtimeDeps.storage.actionRuns.getById({
          projectId: "action-on-requested-test",
          id: runId,
        })
        calls.push(`requested:${runId}:${stored === null ? "unrecorded" : stored.status}`)
      },
    })

    expect(run.status).toBe("succeeded")
    expect(calls).toEqual(["requested:act_hooked:unrecorded", "writeback"])
    await flushSixbErrors(sixb)
    expect(reports).toEqual([])
  })

  // Guard proofs: drop the catch that calls `failRequest` in `ActionRunExecutor.execute`
  // (`actions/run/executor.ts`), and the request rejects uncoded, a 400 over HTTP, with nothing
  // reported. Throw the storage error from `recordRun` (`actions/run/run-action.ts`) instead of an
  // `UnrecordedActionRunError`, and the report loses the phase the run failed in. Give the record
  // that error carries another phase, and the run that succeeded reports that phase instead.
  test("fails the request as internal.unexpected when a run's outcome cannot be recorded", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const leaky = defineAction("leaky")
      .params({})
      .writeback(() => {
        throw new Error("secret-token-123 rejected by upstream")
      })
    const complete = defineAction("complete")
      .params({})
      .writeback(() => ({ ok: true }))
    const reports: SixbErrorContext[] = []
    const sixb = createTestSixb({
      id: "action-unrecorded-test",
      ontology: [Room],
      actions: [actionDefinition(leaky), actionDefinition(complete)],
      onError: (_error, context) => {
        reports.push(context)
      },
      ...runtimeDeps,
    })
    const restore = decorateOperationScopedMethodForTesting(
      runtimeDeps.storage.actionRuns,
      "record",
      () => async () => {
        throw new Error("storage unavailable")
      }
    )

    let failure: unknown
    let succeededFailure: unknown
    try {
      failure = await sixb.actions.request({ actionId: "leaky", runId: "act_unrecorded" }).then(
        () => undefined,
        (error: unknown) => error
      )
      succeededFailure = await sixb.actions
        .request({ actionId: "complete", runId: "act_unrecorded_success" })
        .then(
          () => undefined,
          (error: unknown) => error
        )
    } finally {
      restore()
    }

    expect(failure).toMatchObject({
      code: "internal.unexpected",
      message:
        "[Sixb] Action run 'act_unrecorded' was requested, but its record could not be written. " +
        "Requesting it again with the same runId returns its record if it was written, and runs " +
        "it again otherwise.",
      details: { actionId: "leaky", runId: "act_unrecorded" },
    })
    expect(
      await runtimeDeps.storage.actionRuns.getById({
        projectId: "action-unrecorded-test",
        id: "act_unrecorded",
      })
    ).toBeNull()
    expect(succeededFailure).toMatchObject({ code: "internal.unexpected" })
    await flushSixbErrors(sixb)
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({
      type: "run.failed",
      run: { actionId: "leaky", runId: "act_unrecorded" },
      failure: { code: "action.phase_failed", details: { phase: "writeback" } },
    })
    // The run succeeded, so the report names the phase it succeeded in, not the one it started in.
    expect(reports[1]).toMatchObject({
      type: "run.failed",
      run: { actionId: "complete", runId: "act_unrecorded_success" },
      failure: { code: "internal.unexpected", details: { phase: "writeback" } },
    })
  })

  test("starts nothing for a caller that has already aborted", async () => {
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

    const run = await sixb.objects(SuiteRoom).requestAction({
      id: "suite:1",
      actionId: "setTemperature",
      params: { target: 72 },
    })

    expect(run).toMatchObject({
      actionId: "setTemperature",
      status: "succeeded",
      subject: { kind: "object", objectTypeId: "SuiteRoom", primaryId: "suite:1" },
    })
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

    expect(result).toMatchObject({
      actionId: "createRoom",
      status: "succeeded",
      subject: { kind: "none" },
      params: { id: "room:1", name: "Room 1" },
    })
  })
})

describe("drainActionRuns", () => {
  function createDrainHost(id: string, actions: readonly ActionDefinition[]) {
    const runtimeDeps = createTestRuntimeDeps()
    const host = new SixbHost({ id, ontology: [Room], actions, ...runtimeDeps })
    return { host, storage: runtimeDeps.storage, sixb: createTestSixb(host) }
  }

  // Guard proof: in `ActionRunExecutor.request` (`actions/run/executor.ts`), track a request only
  // once `persist` resolves, and the drain returns while the request is still looking up its run.
  test("waits for a request that is still looking up its run id", async () => {
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
      "getById",
      (getById) => async (input) => {
        persisting.resolve()
        await release.promise
        return getById(input)
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
      await drainActionRuns(host, 0)
      expect(consoleError).toHaveBeenCalledWith(
        "[Sixb] Stopped waiting after 0 ms for 1 in-flight Action run(s)."
      )
    } finally {
      consoleError.mockRestore()
    }

    release.resolve()
    await expect(request).resolves.toMatchObject({ status: "succeeded" })
  })

  // Guard proof: in `ActionRunExecutor.drain` (`actions/run/executor.ts`), wait once for the
  // requests in flight instead of until nothing is left, and the drain returns before the effects
  // that the request it waited for started.
  test("waits for the effects a request starts while draining", async () => {
    const calls: string[] = []
    const editsStarted = Promise.withResolvers<void>()
    const releaseEdits = Promise.withResolvers<void>()
    const effectsStarted = Promise.withResolvers<void>()
    const releaseEffects = Promise.withResolvers<void>()
    const notify = defineAction("notify")
      .params({})
      .edits(async () => {
        editsStarted.resolve()
        await releaseEdits.promise
      })
      .effects(async () => {
        effectsStarted.resolve()
        await releaseEffects.promise
        calls.push("effects")
      })
    const { host, sixb } = createDrainHost("action-drain-effects-test", [actionDefinition(notify)])

    const request = sixb.actions.request({ actionId: "notify", runId: "act_notify" })
    await editsStarted.promise
    const drained = drainActionRuns(host, 5_000).then(() => {
      calls.push("drained")
    })
    releaseEdits.resolve()
    await expect(request).resolves.toMatchObject({ status: "succeeded" })
    await effectsStarted.promise
    // Let every pending continuation run: a drain that stopped at the request returns here.
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toEqual([])

    releaseEffects.resolve()
    await drained
    expect(calls).toEqual(["effects", "drained"])
  })

  test("names what it was given when that is not a host", async () => {
    await expect(drainActionRuns({}, 0)).rejects.toThrow(
      "[Sixb] Cannot drain Action runs: this object is not a SixbHost."
    )
  })
})

describe("Action effects", () => {
  // Guard proof: await `outcome.effects()` in `ActionRunExecutor.execute`
  // (`actions/run/executor.ts`): the request then waits for effects that wait for the test, which
  // times out.
  test("returns the run before its effects end, then records how they ended", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const effectsStarted = Promise.withResolvers<void>()
    const releaseEffects = Promise.withResolvers<void>()
    const effectsError = new Error("Slack is down")
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const notify = defineAction("notify")
      .params({ fail: param("boolean") })
      .edits(({ objects }) => {
        objects(Room).create({ id: "room:notified", externalId: "R", name: "Notified" })
      })
      .effects(async ({ params, commit }) => {
        expect(commit.created).toBe(true)
        effectsStarted.resolve()
        await releaseEffects.promise
        if (params.fail) throw effectsError
      })
    const host = new SixbHost({
      id: "action-effects-test",
      ontology: [Room],
      actions: [actionDefinition(notify)],
      onError: (error, context) => {
        reports.push({ error, context })
      },
      ...runtimeDeps,
    })
    const sixb = createTestSixb(host)

    const run = await sixb.actions.request({
      actionId: "notify",
      params: { fail: true },
      runId: "act_notify",
    })
    await effectsStarted.promise

    expect(run).toMatchObject({ status: "succeeded", phase: "commit" })
    expect(run.effects).toBeUndefined()

    releaseEffects.resolve()
    await drainActionRuns(host, 5_000)
    const recorded = await runtimeDeps.storage.actionRuns.getById({
      projectId: "action-effects-test",
      id: "act_notify",
    })
    expect(recorded).toMatchObject({
      status: "succeeded",
      phase: "effects",
      effects: {
        status: "failed",
        error: { code: "action.phase_failed", details: { phase: "effects" } },
      },
    })
    expect(recorded?.error).toBeUndefined()
    await flushSixbErrors(host)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toBe(effectsError)
    expect(reports[0]?.context).toMatchObject({
      type: "action.phase.failed",
      runId: "act_notify",
      phase: "effects",
      failure: recorded?.effects?.error,
      occurredAt: recorded?.effects?.error?.at,
    })
  })

  test("runs no effects for a run that committed no edits", async () => {
    let effects = 0
    const notify = defineAction("notify")
      .params({})
      .validate(() => ({ error: "Not now" }))
      .edits(() => {})
      .effects(() => {
        effects += 1
      })
    const runtimeDeps = createTestRuntimeDeps()
    const host = new SixbHost({
      id: "action-effects-skipped-test",
      ontology: [Room],
      actions: [actionDefinition(notify)],
      onError: () => {},
      ...runtimeDeps,
    })

    const run = await createTestSixb(host).actions.request({ actionId: "notify" })
    await drainActionRuns(host, 5_000)

    expect(run).toMatchObject({ status: "failed", phase: "validation" })
    expect(effects).toBe(0)
  })
})
