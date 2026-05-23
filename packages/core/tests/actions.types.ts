import {
  actionParam,
  defineAction,
  defineObjectType,
  type InferActionParams,
  type InferSchemaOrRef,
  type ObjectRef,
  type ObjectRefSchema,
  prop,
  ref,
  Sixb,
  stringEnum,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
  ],
})

const RoomRefSchema = ref(Room)
type _roomRefSchema = Expect<Equal<typeof RoomRefSchema, ObjectRefSchema<"Room">>>
type _roomRefValue = Expect<Equal<InferSchemaOrRef<typeof RoomRefSchema>, ObjectRef<"Room">>>

const setTemperature = defineAction("setTemperature")
  .on(Room)
  .params({
    target: actionParam("double", { required: true }),
    mode: actionParam(stringEnum(["heat", "cool", "auto"])),
  })
  .validate(({ params, target }) => {
    const targetValue: number = params.target
    const mode: "heat" | "cool" | "auto" | undefined = params.mode
    const primaryId: string = target.primaryId
    void targetValue
    void mode
    void primaryId
  })
  .run(async ({ params, target, sixb }) => {
    const targetValue: number = params.target
    const name: string = target.properties.name
    const objectTypeId: string = target.objectTypeId
    sixb.objects(Room)

    // @ts-expect-error "bogus" does not exist on params
    const bogus = params.bogus

    void targetValue
    void name
    void objectTypeId
    void bogus
  })

const reboot = defineAction("reboot")
  .target(Room)
  .params({})
  .run(({ params }) => {
    // @ts-expect-error empty params do not expose arbitrary keys
    const force = params.force
    void force
  })

const setRequestTemperature = defineAction("setRequestTemperature")
  .on(Room)
  .params({
    target: actionParam("double", { required: true }),
  })
  .run(async () => {})

const assignRelatedRoom = defineAction("assignRelatedRoom")
  .on(Room)
  .params({
    relatedRoom: actionParam(RoomRefSchema, { required: true }),
    fallbackRoom: actionParam(ref(Room)),
  })
  .run(({ params }) => {
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
    id: actionParam("string", { required: true }),
    name: actionParam("string", { required: true }),
  })
  .validate(({ params }) => {
    const id: string = params.id

    // @ts-expect-error global validators do not expose target
    const primaryId = target.primaryId

    void id
    void primaryId
  })
  .run(({ params, sixb }) => {
    const id: string = params.id
    const name: string = params.name
    sixb.objects(Room)

    // @ts-expect-error global action handlers do not expose target
    const primaryId = target.primaryId

    void id
    void name
    void primaryId
  })

const sixb = new Sixb({
  ontology: [Room],
  actions: [setTemperature, reboot, setRequestTemperature, assignRelatedRoom, createRoom],
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
