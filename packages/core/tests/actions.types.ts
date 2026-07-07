import {
  type ActionDefinition,
  defineAction,
  defineObjectType,
  type InferActionParams,
  type InferSchemaOrRef,
  link,
  type ObjectRef,
  type ObjectRefSchema,
  optional,
  param,
  prop,
  ref,
  Sixb,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

function actionDefinition(action: unknown): ActionDefinition {
  return action as ActionDefinition
}

const Building = defineObjectType({
  id: "Building",
  name: "Building",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link("building", Building, { cardinality: "one" })],
})

const RoomRefSchema = ref(Room)
type _roomRefSchema = Expect<Equal<typeof RoomRefSchema, ObjectRefSchema<"Room">>>
type _roomRefValue = Expect<Equal<InferSchemaOrRef<typeof RoomRefSchema>, ObjectRef<"Room">>>

const setTemperature = actionDefinition(
  defineAction("setTemperature")
    .on(Room)
    .params({
      target: param("double"),
      mode: optional(param("string")),
    })
    .writeback(({ params, target }) => {
      const targetValue: number = params.target
      const mode: string | undefined = params.mode
      const name: string = target.properties.name
      const objectTypeId: string = target.objectTypeId

      // @ts-expect-error "bogus" does not exist on params
      const bogus = params.bogus

      void targetValue
      void mode
      void name
      void objectTypeId
      void bogus
    })
)

defineAction("validateTemperature")
  .on(Room)
  .params({
    target: param("double"),
  })
  .validate(({ params }) => {
    const targetValue: number = params.target
    void targetValue
  })
  .writeback(() => {})

const reboot = defineAction("reboot")
  .on(Room)
  .params({})
  .writeback(({ params }) => {
    // @ts-expect-error empty params do not expose arbitrary keys
    const force = params.force
    void force
  })

const runtimeFacade = defineAction("runtimeFacade")
  .on(Room)
  .params({})
  .writeback(({ sixb, read }) => {
    sixb.objects(Room).appendTelemetryBatch([{ id: "room:1", properties: {}, at: new Date() }])

    // @ts-expect-error the runtime (telemetry) facade cannot perform local object writes
    sixb.objects(Room).upsert({ properties: { id: "room:1" } })

    // @ts-expect-error the runtime (telemetry) facade cannot perform local object reads
    sixb.objects(Room).get("room:1")

    // writeback can enrich its external payload with side-effect-free reads
    read.objects(Room).get("room:1")
    read.objects(Room).query()
  })

defineAction("targetAlias")
  // @ts-expect-error object-scoped actions use .on(ObjectType), not .target(ObjectType)
  .target(Room)
  .params({})
  .writeback(() => {})

const setRequestTemperature = defineAction("setRequestTemperature")
  .on(Room)
  .params({
    target: param("double"),
  })
  .writeback(async () => {})

const assignRelatedRoom = defineAction("assignRelatedRoom")
  .on(Room)
  .params({
    relatedRoom: param(RoomRefSchema),
    fallbackRoom: optional(param(ref(Room))),
  })
  .writeback(({ params }) => {
    const relatedRoom: ObjectRef<"Room"> = params.relatedRoom
    const relatedRoomType: "Room" = params.relatedRoom.objectTypeId
    const fallbackRoom: ObjectRef<"Room"> | undefined = params.fallbackRoom

    // @ts-expect-error relatedRoom is a Room ref, not a SuiteRoom ref
    const suiteRoomRef: ObjectRef<"SuiteRoom"> = params.relatedRoom

    void relatedRoom
    void relatedRoomType
    void fallbackRoom
    void suiteRoomRef
  })

const createRoom = defineAction("createRoom")
  .params({
    id: param("string"),
    name: param("string"),
  })
  .validate(({ params }) => {
    const id: string = params.id

    // @ts-expect-error global validators do not expose target
    const primaryId = target.primaryId

    void id
    void primaryId
  })
  .edits(({ params, objects }) => {
    const id: string = params.id
    const name: string = params.name
    objects(Room).create({ id, name, externalId: id })

    // @ts-expect-error global action edits do not expose target
    const primaryId = target.primaryId

    void id
    void name
    void primaryId
  })

const createInvoice = defineAction("createInvoice")
  .params({
    amount: param("double"),
    note: optional(param("string")),
  })
  .writeback(async ({ params }) => {
    const amount: number = params.amount
    const note: string | undefined = params.note
    void amount
    void note
    return { externalId: "ext_1" }
  })
  .edits(({ objects, writeback }) => {
    const externalId: string = writeback.externalId
    objects(Room).byId("room:1").update({ name: externalId })
  })
  .effects(({ commit, writeback }) => {
    const externalId: string = writeback.externalId
    const changedObjects = commit.diff.objects
    void externalId
    void changedObjects
  })

defineAction("inspectRoomLinks")
  .on(Room)
  .params({})
  .edits(async ({ read, subject }) => {
    await read.objects(Room).byId(subject.primaryId).listLinks(Room.l.building)

    // @ts-expect-error action read listLinks requires a link token, not a plain id object
    await read.objects(Room).byId(subject.primaryId).listLinks({ id: "building" })
  })

defineAction("writebackOnly")
  .params({})
  .writeback(async () => {})

defineAction("editsOnly")
  .params({})
  .edits(({ objects }) => {
    objects(Room).create({ id: "room:1", externalId: "R1", name: "Room 1" })
  })

defineAction("badEditsReturn")
  .params({})
  // @ts-expect-error edits handlers must record through objects and cannot return an EditBatch
  .edits(() => ({
    version: 1,
    operations: [],
  }))

defineAction("badEditsContext")
  .params({})
  // @ts-expect-error edits do not expose the full runtime
  .edits(({ sixb }) => {
    void sixb
  })

defineAction("legacy")
  .params({})
  // @ts-expect-error .run(...) is not part of Actions V2 authoring
  .run(async () => {})

defineAction("effectsWithoutEdits")
  .params({})
  // @ts-expect-error effects require edits
  .effects(async () => {})

const sixb = new Sixb({
  ontology: [Room],
  actions: [
    actionDefinition(setTemperature),
    actionDefinition(reboot),
    actionDefinition(runtimeFacade),
    actionDefinition(setRequestTemperature),
    actionDefinition(assignRelatedRoom),
    actionDefinition(createRoom),
    actionDefinition(createInvoice),
  ],
  ...createTestRuntimeDeps(),
})

type AssignRelatedRoomParams = InferActionParams<(typeof assignRelatedRoom)["params"]>

const validAssignRelatedRoomParams: AssignRelatedRoomParams = {
  relatedRoom: { objectTypeId: "Room", primaryId: "room:2" },
}

const invalidAssignRelatedRoomParams: AssignRelatedRoomParams = {
  relatedRoom: {
    // @ts-expect-error objectTypeId must match ref(Room)
    objectTypeId: "SuiteRoom",
    primaryId: "suite:1",
  },
}

void sixb
sixb.actions.request({
  actionId: "createRoom",
  params: {
    id: "room:1",
    name: "Room 1",
  },
})
sixb.actions.request({
  actionId: "setTemperature",
  subject: { kind: "object", objectTypeId: "Room", primaryId: "room:1" },
  params: { target: 22 },
})
sixb.actions.request({
  // @ts-expect-error global action request API is actionId-based
  action: createRoom,
  params: {
    id: "room:1",
  },
})
sixb
  .objects(Room)
  .byId("room:1")
  .requestAction({
    action: setRequestTemperature,
    params: { target: 22 },
  })
sixb.objects(Room).requestAction({
  id: "room:1",
  action: setRequestTemperature,
  params: { target: 22 },
})

const invalidRequestTemperatureParams: InferActionParams<(typeof setRequestTemperature)["params"]> =
  {
    // @ts-expect-error target must be numeric
    target: "22",
  }

void validAssignRelatedRoomParams
void invalidAssignRelatedRoomParams
void invalidRequestTemperatureParams
