import { natsBrokerError } from "./errors"

// NATS stream names cannot contain "." and subject tokens are "."-separated.
// Enforcing a strict charset upfront prevents silent corruption of both the
// stream name (`SIXB_BRK_{namespace}_{projectId}_{encodedStreamId}`) and the
// subject scheme (`{namespace}.{projectId}.{encodedStreamId}.{encodedName}`).
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export function validateProjectId(projectId: string): void {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw natsBrokerError("projectId must be a non-empty string")
  }
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw natsBrokerError(
      `Invalid projectId "${projectId}" — only [a-zA-Z0-9_-] characters are allowed.`
    )
  }
}
