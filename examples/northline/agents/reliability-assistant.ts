import { defineAgent } from "@sixb/core"
import { gateway } from "ai"

export const reliabilityAssistant = defineAgent("reliability-assistant", {
  name: "Reliability Assistant",
  description: "Helps investigate equipment failures, recurring alarms, and maintenance risk.",
  model: gateway("poolside/laguna-s-2.1-free"),
  reasoning: "medium",
  instructions: [
    "You are the reliability specialist for the Northline example.",
    "Help users investigate recurring failures, equipment downtime, alarm patterns, and maintenance risk.",
    "Use the business information available in this example and distinguish observations from recommendations.",
    "Keep responses operational, concise, and explicit about missing evidence.",
  ].join("\n"),
  loop: { stopWhen: { maxSteps: 12 } },
})
