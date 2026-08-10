import { defineAction, param, ref } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { fieldServiceConnector } from "../connectors/field-service"
import { Equipment } from "../ontology/equipment"
import { FieldNote } from "../ontology/field-note"
import { ServiceVisit } from "../ontology/service-visit"
import { Technician } from "../ontology/technician"

export const addFieldNote = defineAction("add-field-note", {
  description: "Add a typed field observation to an active visit.",
})
  .on(ServiceVisit)
  .params({
    equipment: param(ref(Equipment)),
    technician: param(ref(Technician)),
    noteType: param(
      stringEnum([
        "general",
        "diagnostic",
        "safety",
        "customer_communication",
        "repair_recommendation",
        "follow_up",
      ])
    ),
    body: param("string"),
  })
  .validate(({ params, target }) => {
    if (target.properties.status !== "in_progress") {
      throw new Error(`[Northline] Cannot add a note: ${target.properties.number} is not active.`)
    }
    if (!params.body.trim()) throw new Error("[Northline] Field note text is required.")
  })
  .writeback(async ({ params, run, sixb, target }) => {
    const fieldService = await sixb.connectors.connect(fieldServiceConnector)
    return fieldService.addFieldNote(
      {
        visitId: target.primaryId,
        equipmentId: params.equipment.primaryId,
        technicianId: params.technician.primaryId,
        noteType: params.noteType,
        body: params.body,
      },
      run.idempotencyKey ?? run.id
    )
  })
  .edits(({ objects, params, subject, writeback }) => {
    const note = objects(FieldNote).create({
      id: writeback.note_id,
      noteType: writeback.note_type,
      body: writeback.body,
      recordedAt: writeback.recorded_at,
      sourceUpdatedAt: writeback.updated_at,
    })
    note.link(FieldNote.l.visit, objects(ServiceVisit).byId(subject.primaryId))
    note.link(FieldNote.l.equipment, objects(Equipment).byId(params.equipment.primaryId))
    note.link(FieldNote.l.author, objects(Technician).byId(params.technician.primaryId))
  })
