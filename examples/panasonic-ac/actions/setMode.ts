import { actionParam, defineAction } from "@pario/core"
import type { OperationMode } from "../lib/panasonic/types"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setMode = defineAction("setMode", {
  description: "Set operation mode (0=Auto, 1=Dry, 2=Cool, 3=Heat, 4=Fan).",
})
  .target(PanasonicAcUnit)
  .params({ mode: actionParam("integer", { required: true }) })
  .run(async ({ params, target, pario }) => {
    const api = await getPanasonicApi(pario)
    await api.setOperationMode(target.properties.guid, params.mode as OperationMode)

    await pario
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { operatingMode: params.mode }, at: new Date() },
      ])
  })
