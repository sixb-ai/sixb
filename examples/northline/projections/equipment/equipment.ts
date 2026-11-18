import { defineProjection } from "@sixb/core"
import { controlsEquipmentHealth } from "../../datasets/building-controls/equipment-health"
import { Facility } from "../../ontology/customers/facility"
import { Equipment } from "../../ontology/equipment/equipment"

export const equipmentProjection = defineProjection("controls-equipment", Equipment)
  .fromDataset(controlsEquipmentHealth)
  .properties({
    id: "equipment_id",
    name: "display_name",
    equipmentType: "equipment_type",
    manufacturer: "manufacturer",
    model: "model",
    serialNumber: "serial_number",
    installedOn: "installed_on",
    criticality: "criticality",
    health: "health",
    healthReason: "health_reason",
    lastSeenAt: "last_seen_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    facility: { link: Equipment.l.facility, sourceField: "facility_id", target: Facility },
  })
