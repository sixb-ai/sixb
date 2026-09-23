import {
  decisionOutput,
  defineAction,
  defineObjectType,
  defineWorkflowStep,
  prop,
  question,
} from "@sixb/core"

export const Ticket = defineObjectType({
  id: "Ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("description", "string", { required: true }),
    prop("category", "string"),
  ],
})

export const triageQuestions = {
  category: question.choice({
    instructions: "Identify the main issue in description.",
    options: {
      maintenance: "Breakdowns, leaks, and repairs",
      billing: "Invoices and payments",
      other: "Any other request",
    },
  }),
  severity: question.score({
    instructions: "Assess operational impact in description.",
    levels: ["No operational impact", "Degraded operation", "Operation stopped"],
  }),
  blocked: question.probability(
    "Does description explicitly report equipment that cannot operate?"
  ),
}

export const triage = defineWorkflowStep("triage")
  .input({ description: "string" })
  .output(decisionOutput(triageQuestions))
  .run(
    async ({ input, sixb }) =>
      (await sixb.models.decision.evaluate({ input, questions: triageQuestions })).output
  )

export const triageTicket = defineAction("triage-ticket")
  .on(Ticket)
  .params({})
  .writeback(async ({ target, sixb }) => {
    const description = target.properties.description
    const { output, callId } = await sixb.models.decision.evaluate({
      input: { description },
      questions: triageQuestions,
    })
    return { description, previousCategory: target.properties.category ?? null, output, callId }
  })
  .edits(async ({ read, objects, subject, writeback }) => {
    const current = await read.objects(Ticket).get(subject.primaryId)
    if (
      !current ||
      current.properties.description !== writeback.description ||
      (current.properties.category ?? null) !== writeback.previousCategory
    ) {
      throw new Error("Ticket changed; request a new triage.")
    }
    objects(Ticket).byId(subject.primaryId).update({ category: writeback.output.category.choice })
  })
