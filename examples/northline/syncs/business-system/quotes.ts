import { change, defineSync } from "@sixb/core"
import { businessSystemConnector } from "../../connectors/business-system"
import { businessQuotes } from "../../datasets/business-system/quotes"
import { hourlyBusinessSync } from "../../schedules/source-syncs"

export const syncBusinessQuotes = defineSync("sync-business-quotes", { mode: "merge" })
  .when(hourlyBusinessSync)
  .checkpoint<{ cursor: string }>()
  .from(businessSystemConnector)
  .read(async function* (client, context) {
    for (const event of await client.quoteChangesSince(context.checkpoint?.cursor)) {
      yield event.kind === "delete" ? change.delete(event.key) : change.upsert(event.row)
      context.setCheckpoint({ cursor: event.cursor })
    }
  })
  .intoDataset(businessQuotes)
