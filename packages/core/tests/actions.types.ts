import {
  actionParam,
  defineAction,
  defineObjectType,
  type InferActionParams,
  type InferSchemaOrRef,
  type ObjectRef,
  type ObjectRefSchema,
  Pario,
  prop,
  ref,
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
  .target(Room)
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
  .run(async ({ params, target, pario }) => {
    const targetValue: number = params.target
    const name: string = target.properties.name
    const objectTypeId: string = target.objectTypeId
    pario.objects(Room)

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

const assignRelatedRoom = defineAction("assignRelatedRoom")
  .target(Room)
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

const pario = new Pario({
  ontology: [Room],
  actions: [setTemperature, reboot, assignRelatedRoom],
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

void pario
void validAssignRelatedRoomParams
void invalidAssignRelatedRoomParams
