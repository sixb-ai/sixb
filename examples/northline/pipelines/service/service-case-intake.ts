import { definePipeline, definePipelineStep } from "@sixb/core"
import { controlsAlarms } from "../../datasets/building-controls/alarms"
import { controlsEquipment } from "../../datasets/building-controls/equipment"
import { businessContracts } from "../../datasets/business-system/contracts"
import { businessFacilities } from "../../datasets/business-system/facilities"
import { northlineServiceCases } from "../../datasets/service/service-cases"
import {
  alarmsUpdated,
  contractsUpdated,
  equipmentUpdated,
  facilitiesUpdated,
} from "../../schedules/data-plane"

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
  .when(equipmentUpdated)
  .when(facilitiesUpdated)
  .when(contractsUpdated)
  .then(deriveServiceCases)
