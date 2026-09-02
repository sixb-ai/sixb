import type { WorkflowDefinition } from "@sixb/core"
import { defineAgentStep, defineWorkflow, stringEnum } from "@sixb/core"
import { lookupResponsePolicy, operationsAssistantModel } from "../agents/operations-assistant"

const serviceAssessmentInput = {
  caseNumber: "string",
  alarmSeverity: stringEnum(["low", "medium", "high", "critical"]),
  contractTier: stringEnum(["standard", "priority", "priority-24-7"]),
  summary: "string",
} as const

export const assessServiceCase = defineAgentStep("assess-service-case", {
  model: operationsAssistantModel,
  reasoning: "medium",
  instructions: "Assess service response urgency using Northline's response policy.",
  tools: [lookupResponsePolicy],
})
  .input(serviceAssessmentInput)
  .output({
    priority: stringEnum(["routine", "urgent", "emergency"]),
    responseWindowMinutes: "integer",
    dispatchRecommended: "boolean",
    rationale: "string",
  })
  .prompt(
    ({ input }) => `Assess the appropriate service response for Northline case ${input.caseNumber}.

Alarm severity: ${input.alarmSeverity}
Contract tier: ${input.contractTier}
Case summary: ${input.summary}

First call lookup_response_policy with the alarm severity and contract tier. Use its result to
recommend a priority, response window, and whether Northline should dispatch a technician.`
  )

/** Manual workflow used to exercise and inspect a complete agentic workflow-node execution. */
export const agentServiceAssessmentWorkflow: WorkflowDefinition = defineWorkflow(
  "agent-service-assessment"
)
  .input(serviceAssessmentInput)
  .then(assessServiceCase)
