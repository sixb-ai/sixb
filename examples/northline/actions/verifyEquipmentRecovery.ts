import { defineAction, param, ref } from "@sixb/core"
import { buildingControlsConnector } from "../connectors/building-controls"
import { operatingLimits } from "../lib/operating-limits"
import { allRows } from "../lib/sources/client-utils"
import type { ReadingRow } from "../lib/sources/contracts"
import { Equipment } from "../ontology/equipment"
import { ServiceCase } from "../ontology/service-case"

export const verifyEquipmentRecovery = defineAction("verify-equipment-recovery", {
  description: "Record post-repair evidence and resolve a service case when recovery is confirmed.",
})
  .on(ServiceCase)
  .params({ equipment: param(ref(Equipment)) })
  .writeback(async ({ params, sixb }) => {
    const controls = await sixb.connector(buildingControlsConnector)
    // The newest reading for the unit may sit on any page.
    let latest: ReadingRow | undefined
    for await (const reading of allRows((input) => controls.listReadings(input))) {
      if (reading.equipment_id !== params.equipment.primaryId) continue
      if (!latest || reading.recorded_at > latest.recorded_at) latest = reading
    }
    if (!latest) {
      throw new Error(
        "[Northline] Cannot verify recovery: no recent controls reading is available."
      )
    }
    const supplyTemperature =
      latest.temperature_unit === "degreeFahrenheit"
        ? ((latest.supply_temp - 32) * 5) / 9
        : latest.supply_temp
    // Recovered once no longer unhealthy, by the same limits the health pipeline uses.
    const recovered =
      supplyTemperature < operatingLimits.supplyAirUnhealthy &&
      latest.compressor_current < operatingLimits.compressorUnhealthy
    return {
      recovered,
      evidence: recovered
        ? "Supply-air temperature and compressor current returned to expected range."
        : "Latest controls readings remain outside the expected operating range.",
    }
  })
  .edits(({ objects, params, run, subject, writeback }) => {
    objects(ServiceCase)
      .byId(subject.primaryId)
      .update(
        writeback.recovered
          ? {
              status: "resolved",
              slaStatus: "met",
              nextAction: "Review documentation and close",
              resolutionSummary: writeback.evidence,
              resolvedAt: run.startedAt,
            }
          : {
              status: "in_service",
              slaStatus: "at_risk",
              nextAction: "Dispatch follow-up service",
              resolutionSummary: writeback.evidence,
            }
      )
    if (writeback.recovered) {
      objects(Equipment).byId(params.equipment.primaryId).update({
        health: "healthy",
        healthReason: "post_repair_readings_within_expected_range",
        lastSeenAt: run.startedAt,
      })
    }
  })
