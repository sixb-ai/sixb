import { defineAction, param } from "@sixb/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setTemperature = defineAction("setTemperature", {
  description: "Set the target temperature in Celsius.",
})
  .on(PanasonicAcUnit)
  .params({ value: param("double") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    await api.setTemperature(target.properties.guid, params.value)

    // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
    await sixb.objects(PanasonicAcUnit).appendTelemetryBatch([
      {
        id: target.primaryId,
        properties: { targetTemperature: { value: params.value, unit: "degreeCelsius" } },
        at: new Date(),
      },
    ])
  })
