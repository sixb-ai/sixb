import { defineAction, param } from "@sixb/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setPower = defineAction("setPower", {
  description: "Turn the AC unit on or off.",
})
  .target(PanasonicAcUnit)
  .params({ on: param("boolean") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    if (params.on) {
      await api.powerOn(target.properties.guid)
    } else {
      await api.powerOff(target.properties.guid)
    }

    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { power: params.on }, at: new Date() },
      ])
  })
