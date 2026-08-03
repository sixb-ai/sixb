import { randomUUID } from "node:crypto"
import { SixbError } from "../errors"

export function createActionRunId(runId: string | undefined): string {
  if (runId !== undefined) {
    if (!runId.trim()) {
      throw new SixbError("runtime.invalid_input", "[Sixb] Action run id must not be empty")
    }
    return runId
  }

  return `act_${randomUUID()}`
}

export function createActionRunIdempotencyKey(projectId: string, runId: string): string {
  return `action:${projectId}:${runId}`
}
