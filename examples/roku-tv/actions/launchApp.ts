import { actionParam, defineAction } from "@sixb/core"
import { getRokuApi } from "../lib/rokuApi"
import { Television } from "../ontology/television"

export const launchApp = defineAction("launchApp", {
  description: "Launch an app by provider-specific app id.",
})
  .target(Television)
  .params({ appId: actionParam("string", { required: true }) })
  .validate(({ params }) => {
    if (params.appId.length === 0) {
      return { error: "launchApp requires params.appId" }
    }
  })
  .run(async ({ params, target, sixb }) => {
    const client = await getRokuApi(sixb, target.properties.controlHost)
    await client.launch(params.appId)

    await sixb.objects(Television).upsert({
      properties: {
        ...target.properties,
        id: target.primaryId,
        activeApp: params.appId,
      },
    })
  })
