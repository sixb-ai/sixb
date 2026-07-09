import type { ActionEditCommitResult } from "@sixb/core"
import type { RunActionJobInput } from "../types"

export async function emitLocalCommitEvents(
  runtime: RunActionJobInput["runtime"],
  commit: ActionEditCommitResult
): Promise<void> {
  if (!commit.created || commit.events.length === 0) {
    return
  }

  try {
    await runtime.events.append({ events: commit.events })
  } catch (error) {
    console.error("[SixbActionWorker] Failed to emit action commit events:", error)
  }
}
