import { defineSync } from "@sixb/core"
import { panasonicConnector } from "../connectors/panasonic"
import { panasonicDeviceSnapshots } from "../datasets/deviceSnapshots"
import { TEMPERATURE_UNAVAILABLE } from "../lib/panasonic/schema"
import { acUnitKeyFromName } from "../ontology/acUnit"
import { panasonicDeviceSnapshotsSchedule } from "../schedules/devices"

export const syncPanasonicDeviceSnapshots = defineSync("sync-panasonic-device-snapshots")
  .when(panasonicDeviceSnapshotsSchedule)
  .from(panasonicConnector)
  .read(async function* (api, context) {
    const groups = await api.getDeviceGroups()

    for (const group of groups) {
      for (const device of group.devices) {
        try {
          const status = await api.getDeviceStatus(device.deviceGuid)
          const params = status.parameters

          yield {
            id: acUnitKeyFromName(device.deviceName),
            guid: device.deviceGuid,
            deviceName: device.deviceName,
            observedAt: new Date(),
            temperatureUnit: "degreeCelsius",
            power: params.operate === 1,
            operatingMode: params.operationMode,
            indoorTemperature:
              params.insideTemperature === TEMPERATURE_UNAVAILABLE
                ? null
                : params.insideTemperature,
            outdoorTemperature:
              params.outTemperature === TEMPERATURE_UNAVAILABLE ? null : params.outTemperature,
            targetTemperature: params.temperatureSet,
            fanSpeed: params.fanSpeed,
            swingHorizontal: params.airSwingLR,
            swingVertical: params.airSwingUD,
            ecoMode: params.ecoMode === 2,
            nanoeMode: params.nanoe === 2,
            ecoNaviMode: params.ecoNavi === 2,
            iAutoMode: params.iAuto === 1,
          }
        } catch (error) {
          context.logger.error(error instanceof Error ? error : String(error), {
            deviceName: device.deviceName,
          })
        }
      }
    }
  })
  .intoDataset(panasonicDeviceSnapshots)
