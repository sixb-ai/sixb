import { defineAgentStep } from "@sixb/core"

export const analyzePerformanceWithAgent = defineAgentStep("analyze-performance", {
  instructions: "Summarize the supplied campaign performance. Do not invent measurements.",
})
  .input({ month: "string", performance: "string" })
  .output({ report: "string" })
  .prompt(({ input }) => `Analyze ${input.month}:\n${input.performance}`)
