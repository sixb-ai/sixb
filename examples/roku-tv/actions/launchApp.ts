import { actionParam, defineAction } from "@pario/core"
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
  .run(async ({ params, target, pario }) => {
    const client = await getRokuApi(pario, target.properties.controlHost)
    await client.launch(params.appId)

    await pario.objects(Television).upsert({
      properties: {
        ...target.properties,
        id: target.primaryId,
        activeApp: params.appId,
      },
    })
  })
