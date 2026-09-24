import { describe, expect, test } from "bun:test"
import type { Principal } from "../auth"
import {
  type CreateWorkflowInterventionInput,
  WorkflowInterventionError,
  type WorkflowInterventionStorage,
} from "../storage/workflow-interventions"

export interface WorkflowInterventionStorageContractSuiteOptions<
  TStorage extends WorkflowInterventionStorage = WorkflowInterventionStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "workflow-intervention-contract"

/** Provider-neutral lifecycle, paging, and principal-attribution contract for interventions. */
export function runWorkflowInterventionStorageContractSuite<
  TStorage extends WorkflowInterventionStorage,
>(label: string, options: WorkflowInterventionStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("creates pending interventions and supports filtered paging", async () => {
      await withStorage(async (storage) => {
        await storage.create(interventionInput({ id: "intervention-1", requestedAt: at("10:00") }))
        await storage.create(
          interventionInput({
            id: "intervention-2",
            workflowRunId: "run-2",
            requestedAt: at("11:00"),
          })
        )
        await storage.submit({ projectId, id: "intervention-2", response: { decision: "approve" } })
        await storage.create(
          interventionInput({
            projectId: "other-project",
            id: "other-project",
            requestedAt: at("12:00"),
          })
        )

        const stored = await storage.getById({ projectId, id: "intervention-1" })
        const page = await storage.list({
          projectId,
          statuses: ["pending"],
          workflowId: "review-workflow",
          interventionId: "review-draft-document",
          requestedAfter: at("09:00"),
          order: "asc",
          limit: 1,
        })

        expect(stored).toMatchObject({
          id: "intervention-1",
          status: "pending",
          input: { draftId: "draft-1" },
          defaultResponse: { decision: "approve" },
        })
        expect(stored?.requestedAt.toISOString()).toBe(at("10:00").toISOString())
        expect(page.total).toBe(1)
        expect(page.hasMore).toBe(false)
        expect(page.interventions.map((intervention) => intervention.id)).toEqual([
          "intervention-1",
        ])
        await expect(storage.list({ projectId, statuses: [] })).resolves.toEqual({
          interventions: [],
          hasMore: false,
          total: 0,
        })
      })
    })

    test("submits, cancels, expires, and rejects invalid transitions", async () => {
      await withStorage(async (storage) => {
        await storage.create(interventionInput({ id: "submit-me" }))
        const submitted = await storage.submit({
          projectId,
          id: "submit-me",
          submittedAt: at("12:00"),
          submittedBy: { type: "user", id: "usr_1" },
          response: { decision: "approve", reviewerNote: "Looks good." },
        })

        await storage.create(interventionInput({ id: "cancel-me" }))
        const cancelled = await storage.cancel({
          projectId,
          id: "cancel-me",
          cancelledAt: at("12:30"),
          cancelledBy: { type: "system", id: "workflow-timeout" },
        })

        await storage.create(interventionInput({ id: "expire-me" }))
        const expired = await storage.expire({ projectId, id: "expire-me", expiredAt: at("13:00") })

        expect(submitted).toMatchObject({
          status: "submitted",
          response: { decision: "approve", reviewerNote: "Looks good." },
          submittedBy: { type: "user", id: "usr_1" },
        })
        expect(submitted.submittedAt?.toISOString()).toBe(at("12:00").toISOString())
        expect(cancelled).toMatchObject({
          status: "cancelled",
          cancelledBy: { type: "system", id: "workflow-timeout" },
        })
        expect(cancelled.cancelledAt?.toISOString()).toBe(at("12:30").toISOString())
        expect(expired.status).toBe("expired")
        expect(expired.expiredAt?.toISOString()).toBe(at("13:00").toISOString())

        await expect(storage.cancel({ projectId, id: "submit-me" })).rejects.toBeInstanceOf(
          WorkflowInterventionError
        )
        await expect(
          storage.submit({ projectId, id: "missing", response: {} })
        ).rejects.toBeInstanceOf(WorkflowInterventionError)
        await expect(storage.create(interventionInput({ id: "submit-me" }))).rejects.toBeInstanceOf(
          WorkflowInterventionError
        )
        await expect(
          storage.create(interventionInput({ id: "bad-index", nodeIndex: -1 }))
        ).rejects.toBeInstanceOf(WorkflowInterventionError)
      })
    })

    test("persists submitting and cancelling principals as { type, id }", async () => {
      await withStorage(async (storage) => {
        const principals: readonly Principal[] = [
          { type: "user", id: "usr_1" },
          { type: "serviceAccount", id: "sa_1" },
          { type: "system", id: "system" },
        ]
        for (const [index, principal] of principals.entries()) {
          await storage.create(
            interventionInput({ id: `submit-${principal.type}`, requestedAt: at(`10:0${index}`) })
          )
          await storage.submit({
            projectId,
            id: `submit-${principal.type}`,
            response: {},
            submittedBy: principal,
          })
          await storage.create(interventionInput({ id: `cancel-${principal.type}` }))
          await storage.cancel({
            projectId,
            id: `cancel-${principal.type}`,
            cancelledBy: principal,
          })
        }
        await storage.create(interventionInput({ id: "anonymous" }))
        await storage.submit({ projectId, id: "anonymous", response: {} })

        for (const principal of principals) {
          const submitted = await storage.getById({ projectId, id: `submit-${principal.type}` })
          const cancelled = await storage.getById({ projectId, id: `cancel-${principal.type}` })
          expect(submitted?.submittedBy).toStrictEqual(principal)
          expect(cancelled?.cancelledBy).toStrictEqual(principal)
        }
        const anonymous = await storage.getById({ projectId, id: "anonymous" })
        expect(anonymous?.submittedBy).toBeUndefined()
        expect(anonymous?.cancelledBy).toBeUndefined()

        const listed = await storage.list({ projectId, statuses: ["submitted"], order: "asc" })
        expect(
          listed.interventions.flatMap((intervention) =>
            intervention.submittedBy ? [intervention.submittedBy] : []
          )
        ).toStrictEqual([...principals])
      })
    })
  })
}

function interventionInput(
  overrides: Partial<CreateWorkflowInterventionInput> = {}
): CreateWorkflowInterventionInput {
  return {
    id: "intervention-1",
    projectId,
    workflowId: "review-workflow",
    workflowRunId: "run-1",
    nodeRunId: "node-1",
    nodeIndex: 0,
    nodeId: "review-draft-document",
    nodeKey: "reviewDraftDocument",
    interventionId: "review-draft-document",
    input: { draftId: "draft-1" },
    defaultResponse: { decision: "approve" },
    requestedAt: at("10:00"),
    ...overrides,
  }
}

function at(time: string): Date {
  return new Date(`2026-05-08T${time}:00.000Z`)
}
