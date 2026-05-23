import { actionParam, defineAction } from "@sixb/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setNanoe = defineAction("setNanoe", {
  description: "Enable or disable nanoe air purification.",
})
  .target(PanasonicAcUnit)
  .params({ enabled: actionParam("boolean", { required: true }) })
  .run(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    await api.setNanoe(target.properties.guid, params.enabled)

    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { nanoeMode: params.enabled }, at: new Date() },
      ])
  })
