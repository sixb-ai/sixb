import { defineAgentTool, stringEnum } from "@sixb/core"

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
