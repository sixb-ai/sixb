import { actionParam, defineAction } from "@pario/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setEco = defineAction("setEco", {
  description: "Enable or disable eco mode.",
})
  .target(PanasonicAcUnit)
  .params({ enabled: actionParam("boolean", { required: true }) })
  .run(async ({ params, target, pario }) => {
    const api = await getPanasonicApi(pario)
    await api.setEcoMode(target.properties.guid, params.enabled)

    await pario
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { ecoMode: params.enabled }, at: new Date() },
      ])
  })
