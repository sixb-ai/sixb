import type { PlaudHttp } from "./http"
import type { PlaudContentBlock } from "./types"
import { isRecord } from "./validation"

export async function resolveContentBlock(
  http: PlaudHttp,
  block: PlaudContentBlock,
  signal?: AbortSignal
): Promise<PlaudContentBlock> {
  if (block.data_content || !block.data_link) return { ...block }
  // A failed body fetch must fail the export, not quietly pretend a transcript is empty.
  return { ...block, data_content: await http.text(block.data_link, signal) }
}

export async function resolveContentBlocks(
  http: PlaudHttp,
  blocks: PlaudContentBlock[],
  signal?: AbortSignal
): Promise<PlaudContentBlock[]> {
  const resolved: PlaudContentBlock[] = []
  for (const block of blocks) resolved.push(await resolveContentBlock(http, block, signal))
  return resolved
}

export function isContentBlockList(value: unknown): value is PlaudContentBlock[] {
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        isRecord(block) &&
        typeof block.data_id === "string" &&
        typeof block.data_type === "string" &&
        (block.data_content == null || typeof block.data_content === "string") &&
        (block.data_link == null || typeof block.data_link === "string")
    )
  )
}
