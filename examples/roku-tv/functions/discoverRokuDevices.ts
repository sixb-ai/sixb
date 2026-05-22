import { defineFunction } from "@pario/core"
import { discoverRokuDevices } from "../lib/roku/discovery"
import { getRokuApi } from "../lib/rokuApi"
import { televisionObjectKeyFromHost } from "../lib/televisionTwin"
import { Television } from "../ontology/television"

export const discoverRoku = defineFunction("discover-roku-devices")
  .cron("* * * * *")
  .run(async ({ pario }) => {
    const discovered = await discoverRokuDevices({ timeoutMs: 5_000 })
    if (discovered.length === 0) return

    for (const device of discovered) {
      const key = televisionObjectKeyFromHost(device.host)
      const client = await getRokuApi(pario, device.host)
      const now = new Date()

      try {
        const info = await client.getDeviceInfo()

        // activeApp and mediaPlayer return 403 when the TV is off
        const activeApp = await client.getActiveApp().catch(() => null)
        const mediaPlayer = await client.getMediaPlayer().catch(() => null)

        await pario.objects(Television).upsert({
          properties: {
            id: key,
            name: info.friendlyName,
            platform: "roku",
            controlHost: device.host,
            manufacturer: info.vendorName,
            modelName: info.modelName,
            modelNumber: info.modelNumber,
            serialNumber: info.serialNumber,
            softwareVersion: info.softwareVersion,
          },
        })

        await pario.objects(Television).appendTelemetryBatch([
          {
            id: key,
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
          `[Pario] Failed to onboard Roku device ${device.host}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  })
