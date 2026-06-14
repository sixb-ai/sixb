import { defineAction, param } from "@sixb/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setEco = defineAction("setEco", {
  description: "Enable or disable eco mode.",
})
  .target(PanasonicAcUnit)
  .params({ enabled: param("boolean") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    await api.setEcoMode(target.properties.guid, params.enabled)

    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { ecoMode: params.enabled }, at: new Date() },
      ])
  })
