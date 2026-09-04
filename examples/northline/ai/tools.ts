import { type AgentToolResult, defineAgentTool, stringEnum } from "@sixb/core"
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

function imageFileExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg"
  if (mediaType === "image/webp") return "webp"
  if (mediaType === "image/gif") return "gif"
  return "png"
}
