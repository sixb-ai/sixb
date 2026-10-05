import { resolveContentBlock, resolveContentBlocks } from "../content"
import type { PlaudHttp } from "../http"
import type { PlaudClient, PlaudTranscriptSegment } from "../types"
import { isRecord, nonEmpty } from "../validation"
import { getRecording } from "./recordings"

export function createTranscriptsResource(http: PlaudHttp): PlaudClient["transcripts"] {
  return {
    async list(id, options) {
      const file = await getRecording(http, id, options)
      return resolveContentBlocks(http, file.source_list, options?.signal)
    },
    async get(id, options) {
      const type = nonEmpty(options?.block ?? "transaction", "block")
      const file = await getRecording(http, id, options)
      const selected = file.source_list.find((block) => block.data_type === type)
      if (!selected) return null
      const block = await resolveContentBlock(http, selected, options?.signal)
      const content = block.data_content ?? ""
      let segments: PlaudTranscriptSegment[] | null = null
      try {
        const value: unknown = JSON.parse(content)
        if (Array.isArray(value) && value.every(isSegment)) segments = value
      } catch {
        /* Outline and other blocks can be plain text. Preserve the original content. */
      }
      return { block, content, segments }
    },
  }
}

function isSegment(value: unknown): value is PlaudTranscriptSegment {
  return (
    isRecord(value) &&
    typeof value.start_time === "number" &&
    Number.isFinite(value.start_time) &&
    typeof value.end_time === "number" &&
    Number.isFinite(value.end_time) &&
    typeof value.content === "string" &&
    (value.speaker == null || typeof value.speaker === "string") &&
    (value.original_speaker == null || typeof value.original_speaker === "string")
  )
}
