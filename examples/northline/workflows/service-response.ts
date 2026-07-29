import type { WorkflowDefinition } from "@sixb/core"
import {
  defineIntervention,
  defineWorkflow,
  defineWorkflowStep,
  interventionField,
  ref,
} from "@sixb/core"
import { dispatchWorkOrder } from "../actions/dispatchWorkOrder"
import { Equipment } from "../ontology/equipment"
import { ServiceCase } from "../ontology/service-case"
import { Technician } from "../ontology/technician"
import { dispatchReviewRequested } from "../schedules/operations"

const loadDispatchContext = defineWorkflowStep("load-dispatch-context")
  .input({ serviceCase: ref(ServiceCase) })
  .output({
    serviceCase: ref(ServiceCase),
    equipment: ref(Equipment),
    recommendedTechnician: ref(Technician),
    caseNumber: "string",
    title: "string",
    recommendation: "string",
    scheduledStart: "timestamp",
    scheduledEnd: "timestamp",
  })
  .run(async ({ input, sixb }) => {
    const serviceCase = await sixb.objects(ServiceCase).get(input.serviceCase.primaryId)
    if (!serviceCase) {
      throw new Error(`[Northline] Service case '${input.serviceCase.primaryId}' was not found.`)
    }
    const [equipmentLink] = await sixb
      .objects(ServiceCase)
      .byId(serviceCase.primaryId)
      .listLinks(ServiceCase.l.equipment)
    if (!equipmentLink) {
      throw new Error(`[Northline] ${serviceCase.properties.number} has no linked equipment.`)
    }
    const technician = await sixb.objects(Technician).get("technician-elena-park")
    if (!technician || technician.properties.availability !== "available") {
      throw new Error("[Northline] No qualified North Jersey rooftop technician is available.")
    }

    const start = new Date(Date.now() + 20 * 60_000)
    return {
      serviceCase: input.serviceCase,
      equipment: { objectTypeId: Equipment.id, primaryId: equipmentLink.targetId },
      recommendedTechnician: {
        objectTypeId: Technician.id,
        primaryId: technician.primaryId,
      },
      caseNumber: serviceCase.properties.number,
      title: serviceCase.properties.title,
      recommendation: `${technician.properties.name} is available in North Jersey and holds the rooftop-unit certification required for this equipment.`,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 90 * 60_000),
    }
  })

export const reviewDispatch = defineIntervention("review-dispatch", {
  description: "Review the recommended technician and response window.",
})
  .input({
    serviceCase: ref(ServiceCase),
    equipment: ref(Equipment),
    recommendedTechnician: ref(Technician),
    caseNumber: "string",
    title: "string",
    recommendation: "string",
    scheduledStart: "timestamp",
    scheduledEnd: "timestamp",
  })
  .response({
    technician: interventionField(ref(Technician)),
    scheduledStart: interventionField("timestamp"),
    scheduledEnd: interventionField("timestamp"),
  })
  .defaults(({ input }) => ({
    technician: input.recommendedTechnician,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
  }))

export const serviceResponseWorkflow: WorkflowDefinition = defineWorkflow("service-response")
  .input({ serviceCase: ref(ServiceCase) })
  .when(dispatchReviewRequested, ({ event }) => ({ serviceCase: event.subject }))
  .then(loadDispatchContext)
  .then(reviewDispatch)
  .then(dispatchWorkOrder, ({ steps }) => ({
    subject: steps.loadDispatchContext.serviceCase,
    params: {
      equipment: steps.loadDispatchContext.equipment,
      technician: steps.reviewDispatch.technician,
      scheduledStart: asDate(steps.reviewDispatch.scheduledStart),
      scheduledEnd: asDate(steps.reviewDispatch.scheduledEnd),
    },
  }))

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value)
}
