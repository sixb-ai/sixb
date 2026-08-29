import {
  type ActionDefinition,
  type ActionDescriptor,
  type DecimalValue,
  decimal,
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
  stringEnum,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

function assertActionDescriptorSchemaReadonly(descriptor: ActionDescriptor): void {
  const schema = descriptor.params.payload.schema
  if (typeof schema === "object" && schema.type === "object") {
    // @ts-expect-error descriptors expose a deeply immutable schema snapshot
    schema.properties.nested = { schema: "string" }
  }
  if (typeof schema === "object" && schema.type === "enum") {
    // @ts-expect-error descriptor enum values are immutable too
    schema.values.pop()
  }
}

void assertActionDescriptorSchemaReadonly

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
    sixb.blobs.put({
      body: new Uint8Array([1, 2, 3]),
      expectedSizeBytes: 3,
      fileName: "payload.bin",
    })
    sixb.blobs.open("blob_id")
    sixb.blobs.stat("blob_id")

    // @ts-expect-error action blob capabilities do not expose destructive operations
    sixb.blobs.delete("blob_id")

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

const updateRoomCategory = defineAction("updateRoomCategory")
  .on(Room)
  .params({
    requiredValue: param("string"),
    optionalValue: optional(param("string")),
    requiredNullable: param(stringEnum(["general_services", "construction"]), {
      nullable: true,
    }),
    optionalNullable: optional(param("timestamp", { nullable: true })),
    nullableRoom: optional(param(ref(Room), { nullable: true })),
  })
  .writeback(({ params }) => {
    const requiredValue: string = params.requiredValue
    const optionalValue: string | undefined = params.optionalValue
    const requiredNullable: "general_services" | "construction" | null = params.requiredNullable
    const optionalNullable: Date | null | undefined = params.optionalNullable
    const nullableRoom: ObjectRef<"Room"> | null | undefined = params.nullableRoom

    // @ts-expect-error non-nullable params cannot be null
    const invalidRequiredValue: null = params.requiredValue

    void requiredValue
    void optionalValue
    void requiredNullable
    void optionalNullable
    void nullableRoom
    void invalidRequiredValue
  })

type UpdateRoomCategoryParams = InferActionParams<(typeof updateRoomCategory)["params"]>
type _updateRoomCategoryParams = Expect<
  Equal<
    UpdateRoomCategoryParams,
    {
      requiredValue: string
      requiredNullable: "general_services" | "construction" | null
      optionalValue?: string
      optionalNullable?: Date | null
      nullableRoom?: ObjectRef<"Room"> | null
    }
  >
>

const maybeNullableOptions: { nullable: true } | undefined =
  Math.random() > 0.5 ? { nullable: true } : undefined
param("string", maybeNullableOptions)

const validNullableParams: UpdateRoomCategoryParams = {
  requiredValue: "required",
  requiredNullable: null,
  optionalNullable: null,
}

const missingRequiredNullable: UpdateRoomCategoryParams = {
  requiredValue: "required",
  // @ts-expect-error required nullable params may be null but cannot be omitted
  requiredNullable: undefined,
}

const invalidNonNullableParam: UpdateRoomCategoryParams = {
  // @ts-expect-error non-nullable params cannot be null
  requiredValue: null,
  requiredNullable: "general_services",
}

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
    const changedObjects = commit.changes.objects
    void externalId
    void changedObjects
  })

defineAction("createExactInvoice")
  .params({ amount: param("decimal") })
  .writeback(({ params }) => {
    const amount: DecimalValue = params.amount
    const sameAmount: typeof amount = decimal("9007199254740993.01")

    // @ts-expect-error Decimal params cannot be treated as JS numbers.
    const numberAmount: number = params.amount

    void sameAmount
    void numberAmount
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
  // @ts-expect-error action execution is defined through writeback
  .run(async () => {})

defineAction("effectsWithoutEdits")
  .params({})
  // @ts-expect-error effects require edits
  .effects(async () => {})

const sixb = createTestSixb({
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
void validNullableParams
void missingRequiredNullable
void invalidNonNullableParam
