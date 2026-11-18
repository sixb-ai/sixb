import { defineProjection } from "@sixb/core"
import { fieldNotes } from "../../datasets/field-service/notes"
import { Equipment } from "../../ontology/equipment/equipment"
import { FieldNote } from "../../ontology/field-service/field-note"
import { ServiceVisit } from "../../ontology/field-service/service-visit"
import { Technician } from "../../ontology/field-service/technician"

export const fieldNotesProjection = defineProjection("field-notes", FieldNote)
  .fromDataset(fieldNotes)
  .properties({
    id: "note_id",
    noteType: "note_type",
    body: "body",
    recordedAt: "recorded_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    visit: { link: FieldNote.l.visit, sourceField: "visit_id", target: ServiceVisit },
    equipment: { link: FieldNote.l.equipment, sourceField: "equipment_id", target: Equipment },
    author: { link: FieldNote.l.author, sourceField: "technician_id", target: Technician },
  })
