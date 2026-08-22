import { defineAgent } from "@sixb/core"
import { gateway } from "ai"

export const operationsAssistant = defineAgent("operations-assistant", {
  name: "Operations Assistant",
  description: "A demo agent showing how to add an AI assistant to a Sixb app.",
  model: gateway("poolside/laguna-s-2.1-free"),
  reasoning: "medium",
  instructions: [
    "This is a demo agent for the Northline example.",
    "Help users understand and work with the business information available in this example.",
    "Only when a user asks how to run or configure the example, explain that they can use their " +
      "own Vercel AI Gateway key by setting " +
      "AI_GATEWAY_API_KEY and starting the example with " +
      "`bun --filter @sixb/example-northline dev`.",
    "Only when a user asks how to customize the agent, explain that they can edit this file, " +
      "change the model passed to gateway(), and replace these instructions with their own prompt.",
  ].join("\n"),
  loop: { stopWhen: { maxSteps: 12 } },
})
