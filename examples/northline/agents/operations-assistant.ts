import { type AgentToolResult, defineAgent, defineAgentTool, stringEnum } from "@sixb/core"
import { gateway, generateImage } from "ai"

const IMAGE_MODEL = "xai/grok-imagine-image-2.0"

export const generateImageTool = defineAgentTool("generate_image")
  .description("Generate an image from a text prompt and return it as an attachment.")
  .input({ prompt: "string" })
  .run(async ({ input, artifacts, signal }) => {
    // Temporary example integration: AI Gateway observes this image call, but Sixb's current usage
    // ledger records only the worker-owned language-model calls that drive the agent loop.
    const { image } = await generateImage({
      model: gateway.image(IMAGE_MODEL),
      prompt: input.prompt,
      abortSignal: signal,
    })
    const { fileRef } = await artifacts.put({
      body: image.uint8Array,
      fileName: `generated-image.${imageFileExtension(image.mediaType)}`,
      mediaType: image.mediaType,
    })
    const result: AgentToolResult = {
      kind: "agentToolResult",
      content: [
        { type: "text", text: "Generated an image." },
        { type: "file", fileRef },
      ],
    }
    return result
  })

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
  model: gateway("deepseek/deepseek-v4-flash-vision-exp"),
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
      "change the model passed to gateway(), and replace these instructions with their own prompt.",
    "When the user asks you to create an image, call generate_image with a detailed prompt.",
  ].join("\n"),
  tools: [lookupResponsePolicy, generateImageTool],
  loop: { stopWhen: { maxSteps: 12 } },
})

function imageFileExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg"
  if (mediaType === "image/webp") return "webp"
  if (mediaType === "image/gif") return "gif"
  return "png"
}
