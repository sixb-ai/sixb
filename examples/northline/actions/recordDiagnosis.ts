import { defineAction, param, ref } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { fieldServiceConnector } from "../connectors/field-service"
import { Equipment } from "../ontology/equipment"
import { FieldNote } from "../ontology/field-note"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"
import { Technician } from "../ontology/technician"

export const recordDiagnosis = defineAction("record-diagnosis", {
  description: "Record a field diagnosis and determine the next service-case state.",
})
  .on(ServiceVisit)
  .params({
    serviceCase: param(ref(ServiceCase)),
    equipment: param(ref(Equipment)),
    technician: param(ref(Technician)),
    disposition: param(stringEnum(["resolved_on_site", "follow_up_required", "quote_required"])),
    finding: param("string"),
  })
  .validate(({ params, target }) => {
    if (target.properties.status !== "in_progress") {
      throw new Error(
        `[Northline] Cannot record diagnosis: ${target.properties.number} is not active.`
      )
    }
    if (!params.finding.trim()) throw new Error("[Northline] A diagnostic finding is required.")
  })
  .writeback(async ({ params, run, sixb, target }) => {
    const fieldService = await sixb.connector(fieldServiceConnector)
    return fieldService.recordDiagnosis(
      {
        visitId: target.primaryId,
        equipmentId: params.equipment.primaryId,
        technicianId: params.technician.primaryId,
        noteType: "diagnostic",
        body: params.finding,
        disposition: params.disposition,
      },
      run.idempotencyKey ?? run.id
    )
  })
  .edits(({ objects, params, subject, writeback }) => {
    objects(ServiceVisit).byId(subject.primaryId).update({
      diagnosisDisposition: params.disposition,
      sourceUpdatedAt: writeback.updated_at,
    })
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
    objects(ServiceCase)
      .byId(params.serviceCase.primaryId)
      .update({
        status: params.disposition === "quote_required" ? "awaiting_authorization" : "in_service",
        nextAction:
          params.disposition === "quote_required"
            ? "Review uncovered repair quote"
            : "Complete field work",
        currentVisitId: subject.primaryId,
      })
  })
