import { defineAgent } from "@sixb/core"
import { vercelGateway } from "@sixb/llm-openresponses"

const gateway = vercelGateway()

export const operationsAssistant = defineAgent("operations-assistant", {
  name: "Operations Assistant",
  description: "A demo agent showing how to add an AI assistant to a Sixb app.",
  model: gateway.model("poolside/laguna-s-2.1-free"),
  reasoning: "medium",
  instructions: [
    "This is a demo agent for the Northline example.",
    "Explain that users can run it with their own Vercel AI Gateway key by setting " +
      "AI_GATEWAY_API_KEY and starting the example with " +
      "`bun --filter @sixb/example-northline dev`.",
    "Tell users they can customize the agent by editing this file, changing the model passed to " +
      "gateway.model(), and replacing these instructions with their own prompt.",
  ].join("\n"),
  loop: { stopWhen: { maxSteps: 12 } },
})
