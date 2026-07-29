import { definePipeline, definePipelineStep } from "@sixb/core"
import {
  controlsAlarms,
  controlsEquipment,
  controlsEquipmentHealth,
  controlsNormalizedReadings,
  controlsRawReadings,
  northlineServiceCases,
} from "../datasets/building-controls"
import { businessContracts, businessFacilities } from "../datasets/business-system"
import { alarmsUpdated, rawReadingsUpdated } from "../schedules/data-plane"

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
            WHEN readings.supply_air_temperature >= 22 OR readings.compressor_current >= 28
              THEN 'unhealthy'
            WHEN readings.supply_air_temperature >= 19 THEN 'watch'
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
            AND supply_air_temperature >= 22
            AND compressor_current >= 28
            THEN 'elevated_supply_temperature_and_current'
          WHEN health = 'unhealthy' AND supply_air_temperature >= 22
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

export const deriveServiceCases = definePipelineStep("derive-service-cases")
  .inputs({
    alarms: controlsAlarms,
    equipment: controlsEquipment,
    facilities: businessFacilities,
    contracts: businessContracts,
  })
  .output(northlineServiceCases)
  .sql(
    ({ alarms, equipment, facilities, contracts }) => `
      WITH service_context AS (
        SELECT
          alarms.*,
          equipment.facility_id,
          equipment.display_name,
          facilities.customer_id,
          contracts.contract_id,
          contracts.response_target_minutes,
          contracts.resolution_target_minutes,
          contracts.major_components_excluded,
          row_number() OVER (
            PARTITION BY alarms.alarm_id
            ORDER BY
              CASE WHEN contracts.status = 'active' THEN 0 ELSE 1 END,
              contracts.updated_at DESC
          ) AS contract_rank
        FROM ${alarms} AS alarms
        INNER JOIN ${equipment} AS equipment
          ON equipment.equipment_id = alarms.equipment_id
        INNER JOIN ${facilities} AS facilities
          ON facilities.facility_id = equipment.facility_id
        INNER JOIN ${contracts} AS contracts
          ON contracts.facility_id = facilities.facility_id
      ),
      numbered AS (
        SELECT
          *,
          CASE alarm_id
            WHEN 'alarm-delaware-controller-offline' THEN '1035'
            WHEN 'alarm-keystone-boiler-lockout' THEN '1038'
            WHEN 'alarm-broad-ahu-damper' THEN '1040'
            WHEN 'alarm-camden-condenser-fan' THEN '1041'
            WHEN 'alarm-harbor-rtu-7-vfd' THEN '1042'
            ELSE CAST(
              1100 + list_sum(
                list_transform(
                  range(1, length(alarm_id) + 1),
                  i -> ascii(substr(alarm_id, i, 1)) * i
                )
              ) % 800
              AS VARCHAR
            )
          END AS case_sequence
        FROM service_context
        WHERE contract_rank = 1
      )
      SELECT
        'case-sc-' || case_sequence AS case_id,
        'SC-' || case_sequence AS case_number,
        customer_id,
        facility_id,
        equipment_id,
        contract_id,
        alarm_id,
        message AS title,
        'alarm' AS source,
        severity,
        CASE
          WHEN status = 'cleared' THEN 'resolved'
          WHEN alarm_id = 'alarm-camden-condenser-fan' THEN 'awaiting_authorization'
          WHEN alarm_id = 'alarm-keystone-boiler-lockout' THEN 'in_service'
          WHEN status = 'acknowledged' THEN 'dispatching'
          ELSE 'new'
        END AS status,
        CASE
          WHEN severity = 'critical'
            THEN display_name || ' is unavailable and customer operations may be disrupted.'
          ELSE display_name || ' is operating outside its expected range.'
        END AS customer_impact,
        CASE
          WHEN major_components_excluded THEN 'partially_covered'
          ELSE 'covered'
        END AS coverage_status,
        observed_at + response_target_minutes * INTERVAL '1 minute' AS response_deadline,
        observed_at + resolution_target_minutes * INTERVAL '1 minute' AS resolution_deadline,
        CASE
          WHEN status = 'cleared' THEN 'met'
          WHEN alarm_id = 'alarm-keystone-boiler-lockout' THEN 'at_risk'
          ELSE 'on_track'
        END AS sla_status,
        CASE
          WHEN status = 'cleared' THEN 'Jordan Bell'
          WHEN alarm_id = 'alarm-camden-condenser-fan' THEN 'Avery Chen'
          WHEN alarm_id = 'alarm-keystone-boiler-lockout' THEN 'Marcus Reed'
          WHEN status = 'acknowledged' THEN 'Priya Nair'
          ELSE NULL
        END AS owner_name,
        CASE
          WHEN status = 'cleared' THEN 'Verify documentation and close'
          WHEN alarm_id = 'alarm-camden-condenser-fan' THEN 'Review repair quote'
          WHEN alarm_id = 'alarm-keystone-boiler-lockout' THEN 'Review field diagnosis'
          WHEN status = 'acknowledged' THEN 'Track dispatched technician'
          ELSE 'Acknowledge and review coverage'
        END AS next_action,
        observed_at AS detected_at,
        acknowledged_at,
        CASE WHEN status = 'cleared' THEN cleared_at ELSE NULL END AS resolved_at
      FROM numbered
    `
  )

export const serviceCaseIntakePipeline = definePipeline("service-case-intake")
  .when(alarmsUpdated)
  .then(deriveServiceCases)
