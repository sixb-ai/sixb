import { defineSync } from "@sixb/core"
import { rokuConnector } from "../connectors/roku"
import { rokuDeviceSnapshots } from "../datasets/deviceSnapshots"
import { televisionObjectKeyFromHost } from "../lib/televisionTwin"
import { rokuDeviceSnapshotsSchedule } from "../schedules/devices"

export const syncRokuDeviceSnapshots = defineSync("sync-roku-device-snapshots")
  .when(rokuDeviceSnapshotsSchedule)
  .from(rokuConnector)
  .read(async function* (connector, context) {
    const devices = await connector.discover({ timeoutMs: 5_000, signal: context.signal })

    for (const device of devices) {
      try {
        const api = await connector.forHost(device.host)
        const info = await api.getDeviceInfo()
        const activeApp = await api.getActiveApp().catch(() => null)
        const mediaPlayer = await api.getMediaPlayer().catch(() => null)

        yield {
          id: televisionObjectKeyFromHost(device.host),
          name: info.friendlyName,
          platform: "roku",
          controlHost: device.host,
          manufacturer: info.vendorName,
          modelName: info.modelName,
          modelNumber: info.modelNumber,
          serialNumber: info.serialNumber,
          softwareVersion: info.softwareVersion,
          powerState: info.powerMode,
          activeApp: activeApp?.name ?? null,
          mediaState: mediaPlayer?.state ?? null,
          observedAt: new Date(),
        }
      } catch (error) {
        context.logger.error(error instanceof Error ? error : String(error), {
          host: device.host,
        })
      }
    }
  })
  .intoDataset(rokuDeviceSnapshots)
