import { actionParam, defineAction } from "@sixb/core"
import { rokuKeys } from "../lib/roku/types"
import { getRokuApi } from "../lib/rokuApi"
import { Television } from "../ontology/television"

const validRokuKeys = new Set<string>(rokuKeys)

export const pressButton = defineAction("pressButton", {
  description: "Press a remote control button on the television.",
})
  .target(Television)
  .params({ button: actionParam("string", { required: true }) })
  .validate(({ params }) => {
    if (!validRokuKeys.has(params.button)) {
      return { error: `Unsupported button: ${params.button}` }
    }
  })
  .run(async ({ params, target, sixb }) => {
    const client = await getRokuApi(sixb, target.properties.controlHost)
    await client.keypress(params.button)

    if (params.button === "PowerOff") {
      await sixb.objects(Television).upsert({
        properties: {
          ...target.properties,
          id: target.primaryId,
          powerState: "PowerOff",
        },
      })
    }
  })
