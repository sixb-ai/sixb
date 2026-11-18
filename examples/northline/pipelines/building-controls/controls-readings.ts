import { definePipeline, definePipelineStep } from "@sixb/core"
import { controlsEquipment } from "../../datasets/building-controls/equipment"
import { controlsEquipmentHealth } from "../../datasets/building-controls/equipment-health"
import { controlsNormalizedReadings } from "../../datasets/building-controls/normalized-readings"
import { controlsRawReadings } from "../../datasets/building-controls/raw-readings"
import { operatingLimits } from "../../lib/operating-limits"
import { rawReadingsUpdated } from "../../schedules/data-plane"

const { supplyAirWatch, supplyAirUnhealthy, compressorUnhealthy } = operatingLimits

export const normalizeControlsReadings = definePipelineStep("normalize-controls-readings")
  .inputs({ readings: controlsRawReadings })
  .output(controlsNormalizedReadings)
  .sql(
    ({ readings }) => `
      SELECT
        reading_id,
        equipment_id,
        recorded_at,
        CASE
          WHEN temperature_unit = 'degreeFahrenheit' THEN (supply_temp - 32) * 5.0 / 9.0
          ELSE supply_temp
        END AS supply_air_temperature,
        CASE
          WHEN temperature_unit = 'degreeFahrenheit' THEN (return_temp - 32) * 5.0 / 9.0
          ELSE return_temp
        END AS return_air_temperature,
        'degreeCelsius' AS temperature_unit,
        compressor_current,
        'ampere' AS current_unit
      FROM ${readings}
    `
  )

export const deriveEquipmentHealth = definePipelineStep("derive-equipment-health")
  .inputs({ readings: controlsNormalizedReadings, equipment: controlsEquipment })
  .output(controlsEquipmentHealth)
  .sql(
    ({ readings, equipment }) => `
      WITH latest_readings AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY equipment_id
            ORDER BY recorded_at DESC, reading_id DESC
          ) AS reading_rank
        FROM ${readings}
      ),
      classified AS (
        SELECT
          equipment.equipment_id,
          equipment.facility_id,
          equipment.display_name,
          equipment.equipment_type,
          equipment.manufacturer,
          equipment.model,
          equipment.serial_number,
          equipment.installed_on,
          equipment.criticality,
          CASE
            WHEN readings.supply_air_temperature >= ${supplyAirUnhealthy}
              OR readings.compressor_current >= ${compressorUnhealthy}
              THEN 'unhealthy'
            WHEN readings.supply_air_temperature >= ${supplyAirWatch} THEN 'watch'
            ELSE 'healthy'
          END AS health,
          readings.supply_air_temperature,
          readings.compressor_current,
          readings.recorded_at,
          equipment.updated_at
        FROM ${equipment} AS equipment
        INNER JOIN latest_readings AS readings
          ON readings.equipment_id = equipment.equipment_id
          AND readings.reading_rank = 1
      )
      SELECT
        equipment_id,
        facility_id,
        display_name,
        equipment_type,
        manufacturer,
        model,
        serial_number,
        installed_on,
        criticality,
        health,
        CASE
          WHEN health = 'unhealthy'
            AND supply_air_temperature >= ${supplyAirUnhealthy}
            AND compressor_current >= ${compressorUnhealthy}
            THEN 'elevated_supply_temperature_and_current'
          WHEN health = 'unhealthy' AND supply_air_temperature >= ${supplyAirUnhealthy}
            THEN 'elevated_supply_temperature'
          WHEN health = 'unhealthy' THEN 'elevated_compressor_current'
          WHEN health = 'watch' THEN 'supply_temperature_trending_high'
          ELSE 'readings_within_expected_range'
        END AS health_reason,
        recorded_at AS last_seen_at,
        updated_at
      FROM classified
    `
  )

export const controlsReadingsPipeline = definePipeline("controls-readings")
  .when(rawReadingsUpdated)
  .then(normalizeControlsReadings)
  .then(deriveEquipmentHealth)
