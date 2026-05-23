import { actionParam, defineAction } from "@sixb/core"
import type { FanSpeed } from "../lib/panasonic/types"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setFan = defineAction("setFan", {
  description: "Set fan speed (0=Auto, 1=Low, 2=LowMid, 3=Mid, 4=HighMid, 5=High).",
})
  .target(PanasonicAcUnit)
  .params({ speed: actionParam("integer", { required: true }) })
  .run(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    await api.setFanSpeed(target.properties.guid, params.speed as FanSpeed)

    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { fanSpeed: params.speed }, at: new Date() },
      ])
  })
