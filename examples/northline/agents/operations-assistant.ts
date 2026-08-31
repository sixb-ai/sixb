import { defineAgent, defineAgentTool, stringEnum } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"

export const lookupResponsePolicy = defineAgentTool("lookup_response_policy")
  .description(
    "Look up Northline's response-time and dispatch policy for an alarm severity and contract tier."
  )
  .input({
    alarmSeverity: stringEnum(["low", "medium", "high", "critical"]),
    contractTier: stringEnum(["standard", "priority", "priority-24-7"]),
  })
  .run(({ input }) => {
    const responseWindowMinutes =
      input.alarmSeverity === "critical"
        ? 30
        : input.contractTier === "priority-24-7" && input.alarmSeverity === "high"
          ? 90
          : input.contractTier === "priority" || input.contractTier === "priority-24-7"
            ? 240
            : 480

    return {
      alarmSeverity: input.alarmSeverity,
      contractTier: input.contractTier,
      responseWindowMinutes,
      dispatchRecommended: input.alarmSeverity === "high" || input.alarmSeverity === "critical",
      policyBasis: "Northline service response policy",
    }
  })

export const operationsAssistant = defineAgent("operations-assistant", {
  name: "Operations Assistant",
  description: "A demo agent showing how to add an AI assistant to a Sixb app.",
  model: vercelGateway("zai/glm-5.3-flash"),
  reasoning: "medium",
  instructions: [
    "This is a demo agent for the Northline example.",
    "Help users understand and work with the business information available in this example.",
    "When assessing service response urgency, call lookup_response_policy before making a " +
      "recommendation and ground the recommendation in the returned policy.",
    "Only when a user asks how to run or configure the example, explain that they can use their " +
      "own Vercel AI Gateway key by setting " +
      "AI_GATEWAY_API_KEY and starting the example with " +
      "`bun --filter @sixb/example-northline dev`.",
    "Only when a user asks how to customize the agent, explain that they can edit this file, " +
      "change the model passed to vercelGateway(), and replace these instructions with their own prompt.",
  ].join("\n"),
  tools: [lookupResponsePolicy],
  loop: { stopWhen: { maxSteps: 12 } },
})
