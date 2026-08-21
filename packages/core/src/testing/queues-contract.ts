import { describe, expect, test } from "bun:test"
import { QueueError } from "../queues/errors"
import type { PipelineQueueJobFailureCode, QueueJobFailure, Queues } from "../queues/types"

const TERMINAL_FAILURE = {
  code: "internal.unexpected",
  retryable: false,
  message: "boom",
  at: "2026-01-01T00:00:00.000Z",
  details: { pipelineId: "p-1" },
} as const satisfies QueueJobFailure<PipelineQueueJobFailureCode>

export interface QueueContractSuiteOptions {
  /** Factory that produces a fresh `Queues` instance for each test case. */
  readonly createQueues: () => Queues | Promise<Queues>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (queues: Queues) => void | Promise<void>
  /**
   * Lease duration used in lease-expiry redelivery assertions. Providers with a stalled-check
   * interval (e.g., BullMQ) need a larger value than in-memory providers. Defaults to 20ms.
   */
  readonly shortLeaseMs?: number
  /**
   * Time to wait for a claim to become re-visible after its lease expires. Defaults to
   * `shortLeaseMs + 10`; providers that rely on a periodic checker must add that interval.
   */
  readonly leaseExpiryRedeliveryMs?: number
  /**
   * Time to wait for a delayed retry to become visible again. Defaults to `shortLeaseMs + 15`.
   */
  readonly retryRedeliveryMs?: number
}

/**
 * Runs the shared `Queues` contract against any provider.
 *
 * Every provider must exhibit the same enqueue/claim/complete/retry/fail/renewLease behavior
 * described here, which is the authoritative specification for Sixb queues — each test is
 * written in Arrange/Act/Assert form, with timing parameters exposed for providers that need
 * them (short lease durations, periodic checker intervals).
 */
export function runQueueContractSuite(label: string, options: QueueContractSuiteOptions): void {
  const shortLeaseMs = options.shortLeaseMs ?? 20
  const leaseExpiryRedeliveryMs = options.leaseExpiryRedeliveryMs ?? shortLeaseMs + 10
  const retryRedeliveryMs = options.retryRedeliveryMs ?? shortLeaseMs + 15

  const withQueues = async (body: (queues: Queues) => Promise<void>): Promise<void> => {
    const queues = await options.createQueues()
    try {
      await body(queues)
    } finally {
      await options.teardown?.(queues)
    }
  }

  describe(label, () => {
    describe("enqueue", () => {
      test("returns envelopes with generated id, createdAt, availableAt, attempt=0", async () => {
        await withQueues(async (queues) => {
          const before = Date.now()

          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [
              {
                type: "sync.run.requested",
                payload: { syncId: "sync-1", commitMessage: "manual" },
              },
            ],
          })

          expect(job?.id).toMatch(/^[0-9a-f-]{36}$/)
          expect(job?.projectId).toBe("project-a")
          expect(job?.attempt).toBe(0)
          expect(job?.type).toBe("sync.run.requested")
          expect(job?.payload.syncId).toBe("sync-1")
          expect(Date.parse(job!.createdAt)).toBeGreaterThanOrEqual(before)
          expect(job?.availableAt).toBe(job?.createdAt)
        })
      })

      test("deduplicates repeated enqueue with a caller-supplied id", async () => {
        await withQueues(async (queues) => {
          const input = {
            id: "dispatch-run-1",
            type: "sync.run.requested" as const,
            payload: { syncId: "sync-1" },
          }
          const [[first], [second]] = await Promise.all([
            queues.syncRuns.enqueue({ projectId: "project-a", jobs: [input] }),
            queues.syncRuns.enqueue({ projectId: "project-a", jobs: [input] }),
          ])

          expect(first?.id).toBe(input.id)
          expect(second?.id).toBe(input.id)
          await expect(
            queues.syncRuns.claim({ projectId: "project-a", workerId: "worker-1", limit: 2 })
          ).resolves.toHaveLength(1)
        })
      })

      test("treats caller-supplied ids as opaque across the job lifecycle", async () => {
        await withQueues(async (queues) => {
          const id = "workflow:review-meeting:node:0"
          const input = {
            id,
            type: "sync.run.requested" as const,
            payload: { syncId: "sync-1" },
          }

          const [[first], [duplicate]] = await Promise.all([
            queues.syncRuns.enqueue({ projectId: "project-a", jobs: [input] }),
            queues.syncRuns.enqueue({ projectId: "project-a", jobs: [input] }),
          ])
          const [claimed] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            limit: 2,
          })

          expect(first?.id).toBe(id)
          expect(duplicate?.id).toBe(id)
          expect(claimed?.job.id).toBe(id)
          if (queues.syncRuns.renewLease) {
            await expect(
              queues.syncRuns.renewLease({
                projectId: "project-a",
                jobId: id,
                leaseId: claimed!.leaseId,
                leaseMs: shortLeaseMs * 10,
              })
            ).resolves.toMatchObject({ job: { id } })
          }
          await queues.syncRuns.complete({
            projectId: "project-a",
            jobId: id,
            leaseId: claimed!.leaseId,
          })
          await expect(
            queues.syncRuns.claim({ projectId: "project-a", workerId: "worker-2" })
          ).resolves.toHaveLength(0)
        })
      })

      test("returns empty array when no jobs are passed", async () => {
        await withQueues(async (queues) => {
          const result = await queues.syncRuns.enqueue({ projectId: "project-a", jobs: [] })

          expect(result).toEqual([])
        })
      })

      test("rejects empty projectId with QueueError", async () => {
        await withQueues(async (queues) => {
          await expect(
            queues.syncRuns.enqueue({
              projectId: "   ",
              jobs: [{ type: "sync.run.requested", payload: { syncId: "sync-1" } }],
            })
          ).rejects.toBeInstanceOf(QueueError)
        })
      })
    })

    describe("claim", () => {
      test("increments attempt to 1 on first successful claim", async () => {
        await withQueues(async (queues) => {
          await queues.pipelines.enqueue({
            projectId: "project-a",
            jobs: [{ type: "pipeline.run.requested", payload: { pipelineId: "p-1" } }],
          })

          const [claimed] = await queues.pipelines.claim({
            projectId: "project-a",
            workerId: "worker-1",
          })

          expect(claimed?.job.attempt).toBe(1)
          expect(claimed?.job.payload.pipelineId).toBe("p-1")
          expect(claimed?.leaseId).toBeTruthy()
          expect(Date.parse(claimed!.leaseExpiresAt)).toBeGreaterThan(
            Date.parse(claimed!.claimedAt)
          )
        })
      })

      test("returns empty array when limit is 0 or negative", async () => {
        await withQueues(async (queues) => {
          await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })

          const zero = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            limit: 0,
          })
          const negative = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            limit: -5,
          })

          expect(zero).toEqual([])
          expect(negative).toEqual([])
        })
      })

      test("rejects non-positive leaseMs with QueueError", async () => {
        await withQueues(async (queues) => {
          await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })

          await expect(
            queues.syncRuns.claim({ projectId: "project-a", workerId: "w-1", leaseMs: 0 })
          ).rejects.toBeInstanceOf(QueueError)
          await expect(
            queues.syncRuns.claim({ projectId: "project-a", workerId: "w-1", leaseMs: -1 })
          ).rejects.toBeInstanceOf(QueueError)
        })
      })

      test("respects delayed visibility via availableAt", async () => {
        await withQueues(async (queues) => {
          const availableAt = new Date(Date.now() + shortLeaseMs + 20).toISOString()
          await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" }, availableAt }],
          })

          const before = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
          })
          await Bun.sleep(shortLeaseMs + 40)
          const after = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
          })

          expect(before).toHaveLength(0)
          expect(after).toHaveLength(1)
          expect(after[0]?.job.availableAt).toBe(availableAt)
        })
      })

      test("isolates jobs across distinct projectIds", async () => {
        await withQueues(async (queues) => {
          await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "a-1" } }],
          })
          await queues.syncRuns.enqueue({
            projectId: "project-b",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "b-1" } }],
          })

          const claimedB = await queues.syncRuns.claim({
            projectId: "project-b",
            workerId: "worker-b",
            limit: 10,
          })

          expect(claimedB).toHaveLength(1)
          expect(claimedB[0]?.job.payload.syncId).toBe("b-1")
          expect(claimedB[0]?.job.projectId).toBe("project-b")
        })
      })

      test("keeps syncRuns, pipelines, projections, workflows, and actions lanes independent", async () => {
        await withQueues(async (queues) => {
          await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          await queues.pipelines.enqueue({
            projectId: "project-a",
            jobs: [{ type: "pipeline.run.requested", payload: { pipelineId: "p-1" } }],
          })
          await queues.projections.enqueue({
            projectId: "project-a",
            jobs: [
              {
                type: "projection.run.requested",
                payload: {
                  projectionId: "room-projection",
                  projectionKind: "object",
                  protocol: "replacement",
                  datasetVersion: {
                    datasetId: "canonical.rooms",
                    versionId: "ver_1",
                    createdAt: "2026-01-01T00:00:00.000Z",
                  },
                  ontologyRevision: "ontology-v1",
                  projectionRevision: "projection-v1",
                  ownershipHash: "ownership-v1",
                },
              },
            ],
          })
          await queues.workflows.enqueue({
            projectId: "project-a",
            jobs: [
              {
                type: "workflow.run.requested",
                payload: { runId: "workflow-run-1" },
              },
            ],
          })
          await queues.actions.enqueue({
            projectId: "project-a",
            jobs: [
              {
                type: "action.run.requested",
                payload: {
                  runId: "act_1",
                },
              },
            ],
          })

          const crossLane = await queues.pipelines.claim({
            projectId: "project-a",
            workerId: "pipeline-worker-1",
            limit: 10,
          })
          const projectionLane = await queues.projections.claim({
            projectId: "project-a",
            workerId: "projection-worker-1",
            limit: 10,
          })
          const workflowLane = await queues.workflows.claim({
            projectId: "project-a",
            workerId: "workflow-worker-1",
            limit: 10,
          })
          const actionLane = await queues.actions.claim({
            projectId: "project-a",
            workerId: "action-worker-1",
            limit: 10,
          })
          const sameLane = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "sync-worker-1",
            limit: 10,
          })

          expect(crossLane).toHaveLength(1)
          expect(crossLane[0]?.job.payload.pipelineId).toBe("p-1")
          expect(projectionLane).toHaveLength(1)
          expect(projectionLane[0]?.job.payload.projectionId).toBe("room-projection")
          expect(workflowLane).toHaveLength(1)
          expect(workflowLane[0]?.job.payload.runId).toBe("workflow-run-1")
          expect(actionLane).toHaveLength(1)
          expect(actionLane[0]?.job.payload.runId).toBe("act_1")
          expect(sameLane).toHaveLength(1)
        })
      })
    })

    describe("complete", () => {
      test("removes the job from the lane permanently", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          const [claim] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
          })

          await queues.syncRuns.complete({
            projectId: "project-a",
            jobId: job!.id,
            leaseId: claim!.leaseId,
          })

          const later = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-2",
            limit: 10,
          })
          expect(later).toHaveLength(0)
        })
      })

      test("rejects a wrong leaseId with QueueError", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            leaseMs: shortLeaseMs * 10,
          })

          await expect(
            queues.syncRuns.complete({
              projectId: "project-a",
              jobId: job!.id,
              leaseId: "not-the-right-lease",
            })
          ).rejects.toBeInstanceOf(QueueError)
        })
      })
    })

    describe("retry", () => {
      test("reschedules the job and bumps attempt on next claim", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          const [firstClaim] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            leaseMs: shortLeaseMs,
          })

          const retryAt = new Date(Date.now() + retryRedeliveryMs).toISOString()
          await queues.syncRuns.retry({
            projectId: "project-a",
            jobId: job!.id,
            leaseId: firstClaim!.leaseId,
            availableAt: retryAt,
          })
          await Bun.sleep(retryRedeliveryMs + 30)
          const [secondClaim] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-2",
            leaseMs: shortLeaseMs,
          })

          expect(secondClaim?.job.id).toBe(job?.id)
          expect(secondClaim?.job.attempt).toBe(2)
        })
      })

      test("rejects invalid availableAt with QueueError", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          const [claim] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            leaseMs: shortLeaseMs * 10,
          })

          await expect(
            queues.syncRuns.retry({
              projectId: "project-a",
              jobId: job!.id,
              leaseId: claim!.leaseId,
              availableAt: "not-a-timestamp",
            })
          ).rejects.toBeInstanceOf(QueueError)
        })
      })
    })

    describe("fail", () => {
      test("marks the job as terminally failed", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.pipelines.enqueue({
            projectId: "project-a",
            jobs: [{ type: "pipeline.run.requested", payload: { pipelineId: "p-1" } }],
          })
          const [claim] = await queues.pipelines.claim({
            projectId: "project-a",
            workerId: "pipeline-worker-1",
          })

          await queues.pipelines.fail({
            projectId: "project-a",
            jobId: job!.id,
            leaseId: claim!.leaseId,
            failure: TERMINAL_FAILURE,
          })

          const later = await queues.pipelines.claim({
            projectId: "project-a",
            workerId: "pipeline-worker-2",
            limit: 10,
          })
          expect(later).toHaveLength(0)
        })
      })
    })

    describe("renewLease", () => {
      test("extends the lease and returns an updated claim", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          const [claim] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            leaseMs: shortLeaseMs + 20,
          })

          const renewed = await queues.syncRuns.renewLease?.({
            projectId: "project-a",
            jobId: job!.id,
            leaseId: claim!.leaseId,
            leaseMs: shortLeaseMs * 5,
          })

          expect(renewed?.job.id).toBe(job?.id)
          expect(renewed?.leaseId).toBe(claim?.leaseId)
          expect(Date.parse(renewed!.leaseExpiresAt)).toBeGreaterThan(
            Date.parse(claim!.leaseExpiresAt)
          )
        })
      })

      test("returns null for unknown jobId", async () => {
        await withQueues(async (queues) => {
          const result = await queues.syncRuns.renewLease?.({
            projectId: "project-a",
            jobId: "00000000-0000-0000-0000-000000000000",
            leaseId: "no-such-lease",
            leaseMs: shortLeaseMs,
          })

          expect(result).toBeNull()
        })
      })

      test("returns null when the leaseId does not match", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            leaseMs: shortLeaseMs * 10,
          })

          const renewed = await queues.syncRuns.renewLease?.({
            projectId: "project-a",
            jobId: job!.id,
            leaseId: "not-the-right-lease",
            leaseMs: shortLeaseMs,
          })

          expect(renewed).toBeNull()
        })
      })
    })

    describe("redelivery", () => {
      test("redelivers after lease expiry with attempt incremented", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          const [first] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            leaseMs: shortLeaseMs,
          })

          await Bun.sleep(leaseExpiryRedeliveryMs)
          const [second] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-2",
            leaseMs: shortLeaseMs,
          })

          expect(first?.job.attempt).toBe(1)
          expect(second?.job.id).toBe(job?.id)
          expect(second!.job.attempt).toBeGreaterThanOrEqual(2)
        })
      })

      test("rejects complete on an already-expired lease", async () => {
        await withQueues(async (queues) => {
          const [job] = await queues.syncRuns.enqueue({
            projectId: "project-a",
            jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
          })
          const [claim] = await queues.syncRuns.claim({
            projectId: "project-a",
            workerId: "worker-1",
            leaseMs: shortLeaseMs,
          })

          await Bun.sleep(leaseExpiryRedeliveryMs)

          await expect(
            queues.syncRuns.complete({
              projectId: "project-a",
              jobId: job!.id,
              leaseId: claim!.leaseId,
            })
          ).rejects.toBeInstanceOf(QueueError)
        })
      })
    })

    describe("health", () => {
      // `sixb check` reports its queues row from this call. While the method was absent, that row
      // was a literal the command printed green.
      test("resolves against a reachable backend", async () => {
        await withQueues(async (queues) => {
          await expect(queues.health()).resolves.toBeUndefined()
        })
      })
    })

    describe("scope", () => {
      // Asserted rather than left to the type checker: a provider that declares the wrong scope is
      // a deployment that looks healthy and claims nothing.
      test("declares whether it can be shared across processes", async () => {
        await withQueues(async (queues) => {
          expect(["process", "shared"]).toContain(queues.scope)
        })
      })
    })
  })
}
