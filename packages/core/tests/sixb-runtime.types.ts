import { defineObjectType, defineOntology, link, prop, Sixb } from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("currentTemperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
  ],
  links: [link("hasThermostat", "Thermostat", { cardinality: "one" })],
})

const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
  ],
})

const Buildings = defineOntology({
  id: "buildings",
  version: "1.0.0",
  objectTypes: [Room, Thermostat],
})

const sixb = new Sixb({ ontology: [Buildings], ...createTestRuntimeDeps() })

async function contract(): Promise<void> {
  await sixb.objects(Room).upsert({
    properties: {
      id: "room:101",
      externalId: "RM-101",
      name: "Conference 101",
    },
  })

  await sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
    value: 22.4,
    unit: "degreeCelsius",
    at: new Date(),
  })

  const room = await sixb
    .objects(Room)
    .query()
    .where((r) => r.p.externalId.eq("RM-101"))
    .first()

  void room

  const roomQuery = sixb
    .objects(Room)
    .query()
    .where((r) => r.and(r.p.externalId.eq("RM-101"), r.p.name.contains("Conference")))
    .search("conference", { fields: [Room.p.name, Room.p.externalId] })
    .orderBy(Room.p.name, "asc")
    .limit(10)

  void roomQuery.ir

  sixb
    .objects(Room)
    .query()
    .where((r) => r.p.name.eq("Conference 101"))
    .validate()

  sixb.objects(Room).query().search("conference").explain()

  sixb.objects(Room).query().limit(10).formatExplanation()

  sixb
    .objects(Room)
    .query()
    // @ts-expect-error search fields accept only property tokens from the current object type
    .search("conference", { fields: [Thermostat.p.name] })

  sixb.objects(Room).list({
    // @ts-expect-error list is storage browsing; use query().where(...).list()
    where: (r) => r.p.name.eq("Conference 101"),
  })

  await sixb
    .objects(Room)
    .query()
    .where((r) =>
      r.and(
        r.p.externalId.eq("RM-101"),
        r.or(r.p.name.contains("Conference"), r.p.name.in(["Conference 101"])),
        r.not(r.p.externalId.neq("RM-404")),
        r.p.currentTemperature.gt(20)
      )
    )
    .first()

  await sixb
    .objects(Room)
    .query()
    // @ts-expect-error contains on string properties requires a string
    .where((r) => r.p.name.contains(123))
    .first()

  await sixb
    .objects(Room)
    .query()
    // @ts-expect-error contains is not valid for numeric properties
    .where((r) => r.p.currentTemperature.contains(22))
    .first()

  const tstatQuery = sixb
    .objects(Room)
    .query()
    .where((r) => r.and(r.p.externalId.eq("RM-101"), r.p.name.contains("Conference")))
    .traverse(Room.l.hasThermostat)
    .where((t) => t.p.externalId.eq("device-123"))

  const tstatFromQuery = await tstatQuery.first()
  const _thermostatObjectTypeId: "Thermostat" | undefined = tstatFromQuery?.objectTypeId
  void _thermostatObjectTypeId

  const tstat = await sixb.objects(Thermostat).upsert({
    properties: {
      id: "tstat:abc",
      externalId: "device-123",
      name: "Tstat 101",
    },
  })

  await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

  await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, {
    // @ts-expect-error hasThermostat must point to Thermostat
    objectTypeId: "Room",
    primaryId: "room:999",
  })

  // @ts-expect-error non-telemetry properties are not valid telemetry tokens
  sixb.objects(Room).byId("room:101").telemetry(Room.p.name)

  await sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
    // @ts-expect-error currentTemperature expects numeric values
    value: "hot",
    unit: "degreeCelsius",
    at: new Date(),
  })
}

void contract
