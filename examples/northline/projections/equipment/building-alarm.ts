import { defineProjection } from "@sixb/core"
import { controlsAlarms } from "../../datasets/building-controls/alarms"
import { BuildingAlarm } from "../../ontology/equipment/building-alarm"
import { Equipment } from "../../ontology/equipment/equipment"

export const alarmsProjection = defineProjection("controls-alarms", BuildingAlarm)
  .fromDataset(controlsAlarms)
  .properties({
    id: "alarm_id",
    message: "message",
    severity: "severity",
    category: "category",
    status: "status",
    observedAt: "observed_at",
    acknowledgedAt: "acknowledged_at",
    clearedAt: "cleared_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    equipment: {
      link: BuildingAlarm.l.equipment,
      sourceField: "equipment_id",
      target: Equipment,
    },
  })
