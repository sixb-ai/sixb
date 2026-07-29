import { pageRows, runIdempotently } from "./client-utils"
import type {
  FieldNoteRow,
  SourceListInput,
  SourcePage,
  TechnicianRow,
  VisitRow,
  WorkOrderRow,
} from "./contracts"
import { fieldServiceStore, initializeDemoSources } from "./source-state"

export interface DispatchWorkOrderInput {
  readonly serviceCaseId: string
  readonly caseNumber: string
  readonly equipmentId: string
  readonly technicianId: string
  readonly title: string
  readonly priority: "routine" | "urgent" | "emergency"
  readonly scope: string
  readonly scheduledStart: string
  readonly scheduledEnd: string
}

export interface DispatchResult {
  readonly workOrder: WorkOrderRow
  readonly visit: VisitRow
}

export interface AddFieldNoteInput {
  readonly visitId: string
  readonly equipmentId: string
  readonly technicianId: string
  readonly noteType: FieldNoteRow["note_type"]
  readonly body: string
}

export interface FieldServiceClient {
  listTechnicians(input?: SourceListInput): Promise<SourcePage<TechnicianRow>>
  listWorkOrders(input?: SourceListInput): Promise<SourcePage<WorkOrderRow>>
  listVisits(input?: SourceListInput): Promise<SourcePage<VisitRow>>
  listFieldNotes(input?: SourceListInput): Promise<SourcePage<FieldNoteRow>>
  dispatchWorkOrder(input: DispatchWorkOrderInput, idempotencyKey: string): Promise<DispatchResult>
  startVisit(visitId: string, idempotencyKey: string): Promise<VisitRow>
  addFieldNote(input: AddFieldNoteInput, idempotencyKey: string): Promise<FieldNoteRow>
  recordDiagnosis(
    input: AddFieldNoteInput & { disposition: NonNullable<VisitRow["diagnosis_disposition"]> },
    idempotencyKey: string
  ): Promise<FieldNoteRow>
  completeVisit(
    visitId: string,
    input: {
      workPerformed: string
      disposition: NonNullable<VisitRow["completion_disposition"]>
    },
    idempotencyKey: string
  ): Promise<VisitRow>
}

export async function createFieldServiceClient(): Promise<FieldServiceClient> {
  await initializeDemoSources()

  return {
    async listTechnicians(input) {
      return pageRows((await fieldServiceStore.read()).technicians, input)
    },
    async listWorkOrders(input) {
      return pageRows((await fieldServiceStore.read()).workOrders, input)
    },
    async listVisits(input) {
      return pageRows((await fieldServiceStore.read()).visits, input)
    },
    async listFieldNotes(input) {
      return pageRows((await fieldServiceStore.read()).fieldNotes, input)
    },
    async dispatchWorkOrder(input, idempotencyKey) {
      return fieldServiceStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "dispatchWorkOrder",
          input,
          (workOrderId) => {
            const workOrder = state.workOrders.find((item) => item.work_order_id === workOrderId)
            const visit = state.visits.find((item) => item.work_order_id === workOrderId)
            return workOrder && visit ? { workOrder, visit } : undefined
          },
          () => {
            const now = new Date().toISOString()
            const suffix = input.caseNumber.replace(/^SC-/, "")
            const workOrder: WorkOrderRow = {
              work_order_id: `work-order-${suffix}`,
              work_order_number: `WO-${suffix}`,
              service_case_id: input.serviceCaseId,
              equipment_id: input.equipmentId,
              technician_id: input.technicianId,
              title: input.title,
              priority: input.priority,
              status: "dispatched",
              scope: input.scope,
              scheduled_start: input.scheduledStart,
              scheduled_end: input.scheduledEnd,
              dispatched_at: now,
              updated_at: now,
            }
            const visit: VisitRow = {
              visit_id: `visit-${suffix}`,
              visit_number: `V-${suffix}-1`,
              work_order_id: workOrder.work_order_id,
              technician_id: input.technicianId,
              status: "scheduled",
              scheduled_start: input.scheduledStart,
              updated_at: now,
            }
            state.workOrders.push(workOrder)
            state.visits.push(visit)
            const technician = state.technicians.find(
              (item) => item.technician_id === input.technicianId
            )
            if (technician) {
              technician.availability = "assigned"
              technician.updated_at = now
            }
            return { workOrder, visit }
          },
          (result) => result.workOrder.work_order_id
        )
      )
    },
    async startVisit(visitId, idempotencyKey) {
      return fieldServiceStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "startVisit",
          { visitId },
          (id) => state.visits.find((visit) => visit.visit_id === id),
          () => {
            const visit = requireVisit(state.visits, visitId)
            if (visit.status !== "scheduled") {
              throw new Error(`[NorthlineSource] Visit '${visitId}' is not scheduled.`)
            }
            visit.status = "in_progress"
            visit.started_at = new Date().toISOString()
            visit.updated_at = visit.started_at
            const workOrder = state.workOrders.find(
              (item) => item.work_order_id === visit.work_order_id
            )
            if (workOrder) {
              workOrder.status = "on_site"
              workOrder.updated_at = visit.started_at
            }
            return visit
          },
          (visit) => visit.visit_id
        )
      )
    },
    async addFieldNote(input, idempotencyKey) {
      return fieldServiceStore.update((state) =>
        createNote(state.fieldNotes, state.idempotency, input, idempotencyKey, "addFieldNote")
      )
    },
    async recordDiagnosis(input, idempotencyKey) {
      return fieldServiceStore.update((state) => {
        const visit = requireVisit(state.visits, input.visitId)
        const note = createNote(
          state.fieldNotes,
          state.idempotency,
          input,
          idempotencyKey,
          "recordDiagnosis"
        )
        visit.diagnosis_disposition = input.disposition
        visit.updated_at = note.updated_at
        return note
      })
    },
    async completeVisit(visitId, input, idempotencyKey) {
      return fieldServiceStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "completeVisit",
          { visitId, ...input },
          (id) => state.visits.find((visit) => visit.visit_id === id),
          () => {
            const visit = requireVisit(state.visits, visitId)
            if (!visit.diagnosis_disposition) {
              throw new Error(
                `[NorthlineSource] Cannot complete visit '${visitId}': diagnosis is missing.`
              )
            }
            const now = new Date().toISOString()
            visit.status = "completed"
            visit.completed_at = now
            visit.work_performed = input.workPerformed
            visit.completion_disposition = input.disposition
            visit.updated_at = now
            const workOrder = state.workOrders.find(
              (item) => item.work_order_id === visit.work_order_id
            )
            if (workOrder) {
              workOrder.status = "completed"
              workOrder.completed_at = now
              workOrder.updated_at = now
            }
            return visit
          },
          (visit) => visit.visit_id
        )
      )
    },
  }
}

function createNote(
  notes: FieldNoteRow[],
  idempotency: Record<string, { operation: string; fingerprint: string; resultId: string }>,
  input: AddFieldNoteInput,
  key: string,
  operation: string
): FieldNoteRow {
  return runIdempotently(
    idempotency,
    key,
    operation,
    input,
    (id) => notes.find((note) => note.note_id === id),
    () => {
      const now = new Date().toISOString()
      const note: FieldNoteRow = {
        note_id: `field-note-${notes.length + 1001}`,
        visit_id: input.visitId,
        equipment_id: input.equipmentId,
        technician_id: input.technicianId,
        note_type: input.noteType,
        body: input.body,
        recorded_at: now,
        updated_at: now,
      }
      notes.push(note)
      return note
    },
    (note) => note.note_id
  )
}

function requireVisit(visits: VisitRow[], visitId: string): VisitRow {
  const visit = visits.find((item) => item.visit_id === visitId)
  if (!visit) throw new Error(`[NorthlineSource] Visit '${visitId}' was not found.`)
  return visit
}
