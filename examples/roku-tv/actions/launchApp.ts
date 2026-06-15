import { defineAction, param } from "@sixb/core"
import { getRokuApi } from "../lib/rokuApi"
import { Television } from "../ontology/television"

export const launchApp = defineAction("launchApp", {
  description: "Launch an app by provider-specific app id.",
})
  .on(Television)
  .params({ appId: param("string") })
  .validate(({ params }) => {
    if (params.appId.length === 0) {
      return { error: "launchApp requires params.appId" }
    }
  })
  .writeback(async ({ params, target, sixb }) => {
    const client = await getRokuApi(sixb, target.properties.controlHost)
    await client.launch(params.appId)

    // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
    await sixb.objects(Television).appendTelemetryBatch([
      {
        id: target.primaryId,
        properties: { activeApp: params.appId },
        at: new Date(),
      },
    ])
  })
