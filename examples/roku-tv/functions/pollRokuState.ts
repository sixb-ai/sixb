import { defineFunction } from "@sixb/core"
import { getRokuApi } from "../lib/rokuApi"
import { Television } from "../ontology/television"

export const pollRokuState = defineFunction("poll-roku-state")
  .cron("* * * * *")
  .run(async ({ sixb }) => {
    const { objects } = await sixb.objects(Television).list({
      limit: 200,
      orderBy: "updatedAt",
      order: "desc",
    })

    for (const object of objects) {
      const host = object.properties.controlHost
      if (typeof host !== "string" || host.length === 0) {
        continue
      }

      const client = await getRokuApi(sixb, host)
      const now = new Date()

      try {
        const info = await client.getDeviceInfo()

        // activeApp and mediaPlayer return 403 when the TV is off
        const activeApp = await client.getActiveApp().catch(() => null)
        const mediaPlayer = await client.getMediaPlayer().catch(() => null)

        await sixb.objects(Television).upsert({
          properties: {
            id: object.primaryId,
            name: info.friendlyName,
            platform: "roku",
            controlHost: host,
            manufacturer: info.vendorName,
            modelName: info.modelName,
            modelNumber: info.modelNumber,
            serialNumber: info.serialNumber,
            softwareVersion: info.softwareVersion,
          },
        })

        await sixb.objects(Television).appendTelemetryBatch([
          {
            id: object.primaryId,
            properties: {
              powerState: info.powerMode,
              activeApp: activeApp?.name ?? null,
              mediaState: mediaPlayer?.state ?? null,
              lastSeenAt: now.toISOString(),
            },
            at: now,
          },
        ])
      } catch (error) {
        console.error(
          `[Sixb] Failed to poll Roku TV ${object.primaryId}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  })
