import { defineAction, param } from "@sixb/core"
import { panasonicConnector } from "../connectors/panasonic"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setEco = defineAction("setEco", {
  description: "Enable or disable eco mode.",
})
  .on(PanasonicAcUnit)
  .params({ enabled: param("boolean") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await sixb.connector(panasonicConnector)
    await api.setEcoMode(target.properties.guid, params.enabled)

    // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { ecoMode: params.enabled }, at: new Date() },
      ])
  })
