import { randomUUID } from "node:crypto"
import { OntologyValidationError } from "../ontology/errors"

export function createActionRunId(runId: string | undefined): string {
  if (runId !== undefined) {
    if (!runId.trim()) {
      throw new OntologyValidationError("[Sixb] Action run id must not be empty")
    }
    return runId
  }

  return `act_${randomUUID()}`
}

export function createActionRunIdempotencyKey(projectId: string, runId: string): string {
  return `action:${projectId}:${runId}`
}
