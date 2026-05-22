import { actionParam, defineAction } from "@pario/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setNanoe = defineAction("setNanoe", {
  description: "Enable or disable nanoe air purification.",
})
  .target(PanasonicAcUnit)
  .params({ enabled: actionParam("boolean", { required: true }) })
  .run(async ({ params, target, pario }) => {
    const api = await getPanasonicApi(pario)
    await api.setNanoe(target.properties.guid, params.enabled)

    await pario
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { nanoeMode: params.enabled }, at: new Date() },
      ])
  })
