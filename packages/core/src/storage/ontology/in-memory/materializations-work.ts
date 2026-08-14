import { stableJsonStringify } from "../../../json"
import { MaterializationConflictError } from "../../../materialization/errors"
import type {
  MaterializationPlanChunk,
  StoredLinkOverride,
  StoredLinkSlotOverride,
  StoredObjectOverride,
} from "../materializations"
import { invalidCorrelation, materializationPlanItems } from "../provider-work"
import type { SessionState } from "./materializations"

export * from "../provider-work"

export function assertChunkSequence(session: SessionState, chunk: MaterializationPlanChunk): void {
  const planItems = materializationPlanItems(chunk)
  const applyStream = session.workStreams.apply
  const appliedStart = session.appliedPlanItems.length
  if (
    planItems.length > 0 &&
    (!applyStream.started || appliedStart + planItems.length > applyStream.emittedCount)
  ) {
    invalidCorrelation("Materialization plan items cannot be applied before they are streamed.")
  }
  for (let offset = 0; offset < planItems.length; offset += 1) {
    const expected = session.applyWork[appliedStart + offset]?.item
    if (!expected || stableJsonStringify(planItems[offset]) !== stableJsonStringify(expected)) {
      invalidCorrelation("Materialization plan items must be applied in exact streamed order.")
    }
  }

  const eventStream = session.workStreams.event
  const appliedOutboxCount = session.outboxEnvelopes.size
  if (
    chunk.outbox.length > 0 &&
    (!eventStream.started || appliedOutboxCount + chunk.outbox.length > eventStream.emittedCount)
  ) {
    invalidCorrelation("Materialization events cannot be applied before they are streamed.")
  }
  for (let offset = 0; offset < chunk.outbox.length; offset += 1) {
    const expected = session.eventWork[appliedOutboxCount + offset]
    const actual = chunk.outbox[offset]?.envelope
    if (!expected || !actual) {
      invalidCorrelation("Materialization outbox events must follow exact streamed order.")
    }
    const { id: _id, commitOrdinal, ...actualDraft } = actual
    if (
      commitOrdinal !== appliedOutboxCount + offset ||
      stableJsonStringify(actualDraft) !== stableJsonStringify(expected.draft)
    ) {
      invalidCorrelation("Materialization outbox events must follow exact streamed order.")
    }
  }
}

export function assertLastCommit(
  value: StoredObjectOverride | StoredLinkOverride | StoredLinkSlotOverride | undefined,
  expected: string | null,
  label: string
): void {
  if ((value?.lastCommitId ?? null) !== expected) {
    throw new MaterializationConflictError("effective-state", `Expected ${label} changed.`)
  }
}
