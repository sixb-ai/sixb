import { defineObjectType, defineOntology, link, Pario, prop } from "../src"
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

const pario = new Pario({ ontology: [Buildings], ...createTestRuntimeDeps() })

async function contract(): Promise<void> {
  await pario.objects(Room).upsert({
    properties: {
      id: "room:101",
      externalId: "RM-101",
      name: "Conference 101",
    },
  })

  await pario.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
    value: 22.4,
    unit: "degreeCelsius",
    at: new Date(),
  })

  const room = await pario.objects(Room).findFirst({
    where: (r) => r.p.externalId.eq("RM-101"),
  })

  void room

  const tstat = await pario.objects(Thermostat).upsert({
    properties: {
      id: "tstat:abc",
      externalId: "device-123",
      name: "Tstat 101",
    },
  })

  await pario.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

  await pario.objects(Room).byId("room:101").link(Room.l.hasThermostat, {
    // @ts-expect-error hasThermostat must point to Thermostat
    objectTypeId: "Room",
    primaryId: "room:999",
  })

  // @ts-expect-error non-telemetry properties are not valid telemetry tokens
  pario.objects(Room).byId("room:101").telemetry(Room.p.name)

  await pario.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
    // @ts-expect-error currentTemperature expects numeric values
    value: "hot",
    unit: "degreeCelsius",
    at: new Date(),
  })
}

void contract
