import { defineAction, param } from "@sixb/core"
import { rokuKeys } from "../lib/roku/types"
import { getRokuApi } from "../lib/rokuApi"
import { Television } from "../ontology/television"

const validRokuKeys = new Set<string>(rokuKeys)

export const pressButton = defineAction("pressButton", {
  description: "Press a remote control button on the television.",
})
  .target(Television)
  .params({ button: param("string") })
  .validate(({ params }) => {
    if (!validRokuKeys.has(params.button)) {
      return { error: `Unsupported button: ${params.button}` }
    }
  })
  .writeback(async ({ params, target, sixb }) => {
    const client = await getRokuApi(sixb, target.properties.controlHost)
    await client.keypress(params.button)

    if (params.button === "PowerOff") {
      // TODO(actions-v2): move local telemetry writes out of writeback once EditBatch supports them.
      await sixb.objects(Television).appendTelemetryBatch([
        {
          id: target.primaryId,
          properties: { powerState: "PowerOff" },
          at: new Date(),
        },
      ])
    }
  })
