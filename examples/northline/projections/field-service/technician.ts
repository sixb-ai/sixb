import { defineProjection } from "@sixb/core"
import { fieldTechnicians } from "../../datasets/field-service/technicians"
import { Technician } from "../../ontology/field-service/technician"

export const techniciansProjection = defineProjection("field-technicians", Technician)
  .fromDataset(fieldTechnicians)
  .properties({
    id: "technician_id",
    name: "full_name",
    email: "email",
    phone: "phone",
    territory: "territory",
    certification: "certification",
    availability: "availability",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({})
