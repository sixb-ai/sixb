import { defineFunction, defineObjectType, Pario, prop } from "../src"
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
})

// Cron handler receives FunctionContext
const pullWeather = defineFunction("pull-weather")
  .cron("*/5 * * * *")
  .run(async ({ pario }) => {
    await pario.objects(Room).upsert({
      properties: {
        id: "room:101",
        externalId: "RM-101",
        name: "Conference 101",
      },
    })

    await pario.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
      value: 72,
      unit: "degreeFahrenheit",
      at: new Date(),
    })

    // @ts-expect-error non-telemetry property tokens are rejected
    pario.objects(Room).byId("room:101").telemetry(Room.p.name)
  })

const pario = new Pario({
  ontology: [Room],
  ...createTestRuntimeDeps(),
  functions: [pullWeather],
})

void pario
