import { defineFunction } from "@pario/core"
import { TEMPERATURE_UNAVAILABLE } from "../lib/panasonic/schema"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const pollPanasonicState = defineFunction("poll-panasonic-state")
  .cron("* * * * *")
  .run(async ({ pario }) => {
    const api = await getPanasonicApi(pario)

    const { objects } = await pario.objects(PanasonicAcUnit).list({
      limit: 200,
      orderBy: "updatedAt",
      order: "desc",
    })

    for (const object of objects) {
      const guid = object.properties.guid
      if (typeof guid !== "string" || guid.length === 0) {
        continue
      }

      try {
        const status = await api.getDeviceStatus(guid)
        const params = status.parameters
        const now = new Date()

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
          { id: object.primaryId, properties: telemetry, at: now },
        ])
      } catch (error) {
        console.error(
          `[Pario] Failed to poll Panasonic AC ${object.primaryId}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  })
