import { defineAction, param } from "@sixb/core"
import type { FanSpeed } from "../lib/panasonic/types"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setFan = defineAction("setFan", {
  description: "Set fan speed (0=Auto, 1=Low, 2=LowMid, 3=Mid, 4=HighMid, 5=High).",
})
  .on(PanasonicAcUnit)
  .params({ speed: param("integer") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    await api.setFanSpeed(target.properties.guid, params.speed as FanSpeed)

    // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { fanSpeed: params.speed }, at: new Date() },
      ])
  })
