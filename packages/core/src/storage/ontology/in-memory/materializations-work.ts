import { MaterializationConflictError } from "../../../materialization/errors"
import type {
  StoredLinkOverride,
  StoredLinkSlotOverride,
  StoredObjectOverride,
} from "../materializations"

export * from "../provider-work"

export function assertLastCommit(
  value: StoredObjectOverride | StoredLinkOverride | StoredLinkSlotOverride | undefined,
  expected: string | null,
  label: string
): void {
  if ((value?.lastCommitId ?? null) !== expected) {
    throw new MaterializationConflictError("effective-state", `Expected ${label} changed.`)
  }
}
