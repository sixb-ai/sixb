import { defineAction, param } from "@sixb/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setPower = defineAction("setPower", {
  description: "Turn the AC unit on or off.",
})
  .on(PanasonicAcUnit)
  .params({ on: param("boolean") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    if (params.on) {
      await api.powerOn(target.properties.guid)
    } else {
      await api.powerOff(target.properties.guid)
    }

    // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { power: params.on }, at: new Date() },
      ])
  })
