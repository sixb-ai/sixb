import { defineAction, param } from "@sixb/core"
import { panasonicConnector } from "../connectors/panasonic"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setNanoe = defineAction("setNanoe", {
  description: "Enable or disable nanoe air purification.",
})
  .on(PanasonicAcUnit)
  .params({ enabled: param("boolean") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await sixb.connector(panasonicConnector)
    await api.setNanoe(target.properties.guid, params.enabled)

    // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { nanoeMode: params.enabled }, at: new Date() },
      ])
  })
