import { defineAction, param, ref } from "@sixb/core"
import { buildingControlsConnector } from "../connectors/building-controls"
import { Equipment } from "../ontology/equipment"
import { ServiceCase } from "../ontology/service-case"

export const verifyEquipmentRecovery = defineAction("verify-equipment-recovery", {
  description: "Record post-repair evidence and resolve a service case when recovery is confirmed.",
})
  .on(ServiceCase)
  .params({ equipment: param(ref(Equipment)) })
  .writeback(async ({ params, sixb }) => {
    const controls = await sixb.connector(buildingControlsConnector)
    const readings = (await controls.listReadings({ limit: 500 })).rows
      .filter((reading) => reading.equipment_id === params.equipment.primaryId)
      .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at))
    const latest = readings[0]
    if (!latest) {
      throw new Error(
        "[Northline] Cannot verify recovery: no recent controls reading is available."
      )
    }
    const supplyTemperature =
      latest.temperature_unit === "degreeFahrenheit"
        ? ((latest.supply_temp - 32) * 5) / 9
        : latest.supply_temp
    const recovered = supplyTemperature < 22 && latest.compressor_current < 28
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
