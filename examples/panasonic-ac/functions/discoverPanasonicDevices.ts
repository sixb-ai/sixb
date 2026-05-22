import { defineFunction } from "@pario/core"
import { TEMPERATURE_UNAVAILABLE } from "../lib/panasonic/schema"
import { getPanasonicApi } from "../lib/panasonicApi"
import { acUnitKeyFromName, PanasonicAcUnit } from "../ontology/acUnit"

export const discoverPanasonicDevices = defineFunction("discover-panasonic-devices")
  .cron("*/5 * * * *")
  .run(async ({ pario }) => {
    const api = await getPanasonicApi(pario)
    const groups = await api.getDeviceGroups()

    for (const group of groups) {
      for (const device of group.devices) {
        const acKey = acUnitKeyFromName(device.deviceName)

        try {
          const status = await api.getDeviceStatus(device.deviceGuid)
          const params = status.parameters
          const now = new Date()

          await pario.upsertObject(PanasonicAcUnit.id, {
            id: acKey,
            guid: device.deviceGuid,
            deviceName: device.deviceName,
          })

          const telemetry: Record<string, unknown> = {
            power: params.operate === 1,
            operatingMode: params.operationMode,
            targetTemperature: { value: params.temperatureSet, unit: "degreeCelsius" },
            fanSpeed: params.fanSpeed,
            swingHorizontal: params.airSwingLR,
            swingVertical: params.airSwingUD,
            ecoMode: params.ecoMode === 2,
            nanoeMode: params.nanoe === 2,
            ecoNaviMode: params.ecoNavi === 2,
            iAutoMode: params.iAuto === 1,
          }

          if (params.insideTemperature !== TEMPERATURE_UNAVAILABLE) {
            telemetry.indoorTemperature = {
              value: params.insideTemperature,
              unit: "degreeCelsius",
            }
          }
          if (params.outTemperature !== TEMPERATURE_UNAVAILABLE) {
            telemetry.outdoorTemperature = {
              value: params.outTemperature,
              unit: "degreeCelsius",
            }
          }

          await pario.appendTelemetry(PanasonicAcUnit.id, [
            { id: acKey, properties: telemetry, at: now },
          ])
        } catch (error) {
          console.error(
            `[Pario] Failed to onboard Panasonic device ${device.deviceName}:`,
            error instanceof Error ? error.message : String(error)
          )
        }
      }
    }
  })
