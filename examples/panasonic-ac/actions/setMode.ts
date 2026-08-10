import { defineAction, param } from "@sixb/core"
import { panasonicConnector } from "../connectors/panasonic"
import type { OperationMode } from "../lib/panasonic/types"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setMode = defineAction("setMode", {
  description: "Set operation mode (0=Auto, 1=Dry, 2=Cool, 3=Heat, 4=Fan).",
})
  .on(PanasonicAcUnit)
  .params({ mode: param("integer") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await sixb.connectors.connect(panasonicConnector)
    await api.setOperationMode(target.properties.guid, params.mode as OperationMode)

    // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
    await sixb
      .objects(PanasonicAcUnit)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { operatingMode: params.mode }, at: new Date() },
      ])
  })
