import { actionParam, defineAction } from "@sixb/core"
import type { OperationMode } from "../lib/panasonic/types"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setMode = defineAction("setMode", {
  description: "Set operation mode (0=Auto, 1=Dry, 2=Cool, 3=Heat, 4=Fan).",
})
  .target(PanasonicAcUnit)
  .params({ mode: actionParam("integer", { required: true }) })
  .run(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    await api.setOperationMode(target.properties.guid, params.mode as OperationMode)

    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { operatingMode: params.mode }, at: new Date() },
      ])
  })
