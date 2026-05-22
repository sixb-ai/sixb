import { actionParam, defineAction } from "@pario/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setTemperature = defineAction("setTemperature", {
  description: "Set the target temperature in Celsius.",
})
  .target(PanasonicAcUnit)
  .params({ value: actionParam("double", { required: true }) })
  .run(async ({ params, target, pario }) => {
    const api = await getPanasonicApi(pario)
    await api.setTemperature(target.properties.guid, params.value)

    await pario.objects(PanasonicAcUnit).appendTelemetryBatch([
      {
        id: target.primaryId,
        properties: { targetTemperature: { value: params.value, unit: "degreeCelsius" } },
        at: new Date(),
      },
    ])
  })
