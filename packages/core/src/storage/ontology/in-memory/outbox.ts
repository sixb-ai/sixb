import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../../materialization/errors"
import type {
  ClaimedOntologyOutboxRow,
  ClaimOntologyOutboxInput,
  CompleteOntologyOutboxLeaseInput,
  OntologyOutboxRecord,
  OntologyOutboxStorage,
  OntologyOutboxSummary,
  PurgePublishedOntologyOutboxInput,
  RescheduleOntologyOutboxLeaseInput,
  SummarizeOntologyOutboxInput,
} from "../outbox"
import {
  assertNonblank,
  assertTimestamp,
  type InMemoryOntologyState,
  insertBounded,
  outboxKey,
} from "./shared-state"

export class InMemoryOntologyOutboxStorage implements OntologyOutboxStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  async claim(input: ClaimOntologyOutboxInput): Promise<readonly ClaimedOntologyOutboxRow[]> {
    return this.runRootOperation(() => this.claimUnlocked(input))
  }

  private claimUnlocked(input: ClaimOntologyOutboxInput): readonly ClaimedOntologyOutboxRow[] {
    assertNonblank(input.projectId, "Ontology outbox project id")
    assertPositiveLimit(input.limit)
    const now = assertTimestamp(input.now, "Ontology outbox claim time")
    const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt, "Ontology outbox lease expiry")
    assertNonblank(input.leaseId, "Ontology outbox lease id")
    if (leaseExpiresAt <= now) {
      throw new MaterializationValidationError(
        "Ontology outbox lease expiry must be later than the claim time."
      )
    }
    const rows: OntologyOutboxRecord[] = []
    for (const row of this.state.outbox.values()) {
      if (row.envelope.projectId !== input.projectId) continue
      assertPairedLease(row)
      if (row.publishedAt !== null || Date.parse(row.availableAt) > now) continue
      if (row.leaseExpiresAt !== null && Date.parse(row.leaseExpiresAt) > now) continue
      insertBounded(rows, row, input.limit, compareClaimRows)
    }
    return rows.map((row) => {
      const claimed: ClaimedOntologyOutboxRow = {
        ...row,
        attempts: row.attempts + 1,
        leaseId: input.leaseId,
        leaseExpiresAt: input.leaseExpiresAt,
      }
      this.state.outbox.set(outboxKey(input.projectId, row.envelope.id), structuredClone(claimed))
      return structuredClone(claimed)
    })
  }

  async markPublished(input: CompleteOntologyOutboxLeaseInput): Promise<void> {
    await this.runRootOperation(() => this.markPublishedUnlocked(input))
  }

  private markPublishedUnlocked(input: CompleteOntologyOutboxLeaseInput): void {
    assertNonblank(input.projectId, "Ontology outbox project id")
    assertNonblank(input.leaseId, "Ontology outbox lease id")
    assertTimestamp(input.publishedAt, "Ontology outbox publishedAt")
    const rows = this.validateLeaseBatch(input.projectId, input.ids, input.leaseId)
    for (const [key, row] of rows) {
      this.state.outbox.set(key, {
        ...row,
        publishedAt: input.publishedAt,
        leaseId: null,
        leaseExpiresAt: null,
      })
    }
  }

  async reschedule(input: RescheduleOntologyOutboxLeaseInput): Promise<void> {
    await this.runRootOperation(() => this.rescheduleUnlocked(input))
  }

  private rescheduleUnlocked(input: RescheduleOntologyOutboxLeaseInput): void {
    assertNonblank(input.projectId, "Ontology outbox project id")
    assertNonblank(input.leaseId, "Ontology outbox lease id")
    assertTimestamp(input.availableAt, "Ontology outbox availableAt")
    const rows = this.validateLeaseBatch(input.projectId, input.ids, input.leaseId)
    for (const [key, row] of rows) {
      this.state.outbox.set(key, {
        ...row,
        availableAt: input.availableAt,
        lastFailure: input.failure === undefined ? row.lastFailure : structuredClone(input.failure),
        leaseId: null,
        leaseExpiresAt: null,
      })
    }
  }

  async purgePublished(input: PurgePublishedOntologyOutboxInput): Promise<number> {
    return this.runRootOperation(() => this.purgePublishedUnlocked(input))
  }

  async summarize(input: SummarizeOntologyOutboxInput): Promise<OntologyOutboxSummary> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Ontology outbox project id")
      let pendingCount = 0
      let oldestPendingAt: string | null = null
      let retryingCount = 0
      let maxAttempts = 0

      for (const row of this.state.outbox.values()) {
        if (row.envelope.projectId !== input.projectId || row.publishedAt !== null) continue
        pendingCount += 1
        if (row.attempts > 0) retryingCount += 1
        maxAttempts = Math.max(maxAttempts, row.attempts)
        if (oldestPendingAt === null || row.createdAt < oldestPendingAt) {
          oldestPendingAt = row.createdAt
        }
      }

      return { pendingCount, oldestPendingAt, retryingCount, maxAttempts }
    })
  }

  private purgePublishedUnlocked(input: PurgePublishedOntologyOutboxInput): number {
    assertNonblank(input.projectId, "Ontology outbox project id")
    assertPositiveLimit(input.limit)
    const cutoff = assertTimestamp(input.publishedBefore, "Ontology outbox purge cutoff")
    const rows: [string, OntologyOutboxRecord][] = []
    for (const entry of this.state.outbox.entries()) {
      const [, row] = entry
      if (
        row.envelope.projectId !== input.projectId ||
        row.publishedAt === null ||
        Date.parse(row.publishedAt) >= cutoff
      ) {
        continue
      }
      insertBounded(rows, entry, input.limit, ([, left], [, right]) =>
        comparePublishedRows(left, right)
      )
    }
    for (const [key] of rows) this.state.outbox.delete(key)
    return rows.length
  }

  private requireLease(key: string, leaseId: string) {
    const row = this.state.outbox.get(key)
    if (!row || row.leaseId !== leaseId || row.leaseExpiresAt === null) {
      throw new MaterializationConflictError(
        "outbox-lease",
        "Ontology outbox lease does not match."
      )
    }
    return row
  }

  private validateLeaseBatch(
    projectId: string,
    ids: readonly string[],
    leaseId: string
  ): readonly (readonly [string, ReturnType<InMemoryOntologyOutboxStorage["requireLease"]>])[] {
    const seen = new Set<string>()
    return ids.map((id) => {
      assertNonblank(id, "Ontology outbox event id")
      if (seen.has(id)) {
        throw new MaterializationValidationError(
          `Ontology outbox lease batch repeats event '${id}'.`
        )
      }
      seen.add(id)
      const key = outboxKey(projectId, id)
      return [key, this.requireLease(key, leaseId)] as const
    })
  }
}

/**
 * Deterministic claim order.
 *
 * Every row of one commit shares `createdAt`, so `commitOrdinal` gives providers a stable batch
 * order. It correlates facts but does not promise broker delivery order: concurrent leases and
 * retries may publish later rows first.
 */
function compareClaimRows(
  left: import("../outbox").OntologyOutboxRecord,
  right: import("../outbox").OntologyOutboxRecord
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.envelope.commitId.localeCompare(right.envelope.commitId) ||
    left.envelope.commitOrdinal - right.envelope.commitOrdinal
  )
}

function comparePublishedRows(
  left: import("../outbox").OntologyOutboxRecord,
  right: import("../outbox").OntologyOutboxRecord
): number {
  return (
    (left.publishedAt ?? "").localeCompare(right.publishedAt ?? "") ||
    left.envelope.id.localeCompare(right.envelope.id)
  )
}

function assertPositiveLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new MaterializationValidationError("Ontology outbox limit must be positive.")
  }
}

function assertPairedLease(row: {
  readonly leaseId: string | null
  readonly leaseExpiresAt: string | null
}): void {
  if ((row.leaseId === null) !== (row.leaseExpiresAt === null)) {
    throw new MaterializationConflictError(
      "outbox-lease",
      "Ontology outbox row has an unpaired lease lifecycle."
    )
  }
}
