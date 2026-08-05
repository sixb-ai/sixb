import type { ListSyncsResponses } from "../src/generated/types.gen"

type LatestSyncRun = NonNullable<ListSyncsResponses[200][number]["latestRun"]>
type SyncFailureCode = NonNullable<LatestSyncRun["error"]>["code"]

const unexpected: SyncFailureCode = "internal.unexpected"
const cancelled: SyncFailureCode = "runtime.cancelled"

// Dataset lookup codes belong to HTTP route failures, not persisted sync-run failures.
// @ts-expect-error the generated sync failure contract must stay scoped to its producer
const unrelated: SyncFailureCode = "dataset.not_found"

void [unexpected, cancelled, unrelated]
