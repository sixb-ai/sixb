import { defineAction, param } from "@sixb/core"
import { rokuKeys } from "../lib/roku/types"
import { getRokuApi } from "../lib/rokuApi"
import { Television } from "../ontology/television"

const validRokuKeys = new Set<string>(rokuKeys)

export const pressButton = defineAction("pressButton", {
  description: "Press a remote control button on the television.",
})
  .on(Television)
  .params({ button: param("string") })
  .validate(({ params }) => {
    if (!validRokuKeys.has(params.button)) {
      return { error: `Unsupported button: ${params.button}` }
    }
  })
  .writeback(async ({ params, target, sixb }) => {
    const client = await getRokuApi(sixb, target.properties.controlHost)
    await client.keypress(params.button)

    const nextPowerState = expectedPowerStateAfterKeypress(
      params.button,
      target.properties.powerState
    )
    if (nextPowerState) {
      // Telemetry is not part of EditBatch yet, so mirror action-known state
      // immediately from writeback instead of waiting for the next device poll.
      await sixb.objects(Television).appendTelemetryBatch([
        {
          id: target.primaryId,
          properties: {
            powerState: nextPowerState,
            ...(nextPowerState === "PowerOff" ? { activeApp: null, mediaState: null } : {}),
          },
          at: new Date(),
        },
      ])
    }
  })

function expectedPowerStateAfterKeypress(
  button: string,
  currentPowerState: unknown
): string | null {
  if (button === "PowerOff") {
    return "PowerOff"
  }

  if (button === "Power") {
    return currentPowerState === "PowerOn" ? "PowerOff" : "PowerOn"
  }

  return null
}
