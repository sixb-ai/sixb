import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import type { CreateWorkflowInterventionInput } from "../src/storage"
import { InMemoryWorkflowInterventionStorage, WorkflowInterventionError } from "../src/storage"

describe("InMemoryWorkflowInterventionStorage", () => {
  test("creates pending interventions and lists them with filters", async () => {
    const storage = new InMemoryWorkflowInterventionStorage()

    const created = await storage.create(
      createInterventionInput({
        id: "intervention-1",
        requestedAt: new Date("2026-05-08T10:00:00.000Z"),
      })
    )
    ;(created.input as { draftId: string }).draftId = "mutated"

    await storage.create(
      createInterventionInput({
        id: "intervention-2",
        workflowRunId: "run-2",
        requestedAt: new Date("2026-05-08T11:00:00.000Z"),
      })
    )
    await storage.submit({
      id: "intervention-2",
      projectId: "my-app",
      response: { decision: "approve" },
    })
    await storage.create(
      createInterventionInput({
        id: "other-project",
        projectId: "other-app",
        requestedAt: new Date("2026-05-08T12:00:00.000Z"),
      })
    )

    const stored = await storage.getById({
      projectId: "my-app",
      id: "intervention-1",
    })
    const page = await storage.list({
      projectId: "my-app",
      statuses: ["pending"],
      workflowId: "review-workflow",
      interventionId: "review-draft-document",
      requestedAfter: new Date("2026-05-08T09:00:00.000Z"),
      order: "asc",
      limit: 1,
    })
    const empty = await storage.list({
      projectId: "my-app",
      statuses: [],
    })

    expect(stored?.input).toEqual({ draftId: "draft-1" })
    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.interventions.map((intervention) => intervention.id)).toEqual(["intervention-1"])
    expect(empty).toEqual({
      interventions: [],
      hasMore: false,
      total: 0,
    })
  })

  test("submits, cancels, and expires only pending interventions", async () => {
    const storage = new InMemoryWorkflowInterventionStorage()

    await storage.create(
      createInterventionInput({
        id: "submit-me",
      })
    )
    const submitted = await storage.submit({
      id: "submit-me",
      projectId: "my-app",
      submittedAt: new Date("2026-05-08T12:00:00.000Z"),
      submittedBy: {
        principalType: "user",
        principalId: "usr_1",
      },
      response: {
        decision: "approve",
        reviewerNote: "Looks good.",
      },
    })

    await storage.create(createInterventionInput({ id: "cancel-me" }))
    const cancelled = await storage.cancel({
      id: "cancel-me",
      projectId: "my-app",
      cancelledAt: new Date("2026-05-08T12:30:00.000Z"),
      cancelledBy: {
        principalType: "system",
        principalId: "workflow-timeout",
      },
    })

    await storage.create(createInterventionInput({ id: "expire-me" }))
    const expired = await storage.expire({
      id: "expire-me",
      projectId: "my-app",
      expiredAt: new Date("2026-05-08T13:00:00.000Z"),
    })

    expect(submitted).toMatchObject({
      status: "submitted",
      response: {
        decision: "approve",
        reviewerNote: "Looks good.",
      },
      submittedBy: {
        principalType: "user",
        principalId: "usr_1",
      },
    })
    expect(submitted.submittedAt?.toISOString()).toBe("2026-05-08T12:00:00.000Z")
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.cancelledBy).toEqual({
      principalType: "system",
      principalId: "workflow-timeout",
    })
    expect(expired.status).toBe("expired")
    expect(expired.expiredAt?.toISOString()).toBe("2026-05-08T13:00:00.000Z")

    await expect(
      storage.cancel({
        id: "submit-me",
        projectId: "my-app",
      })
    ).rejects.toBeInstanceOf(WorkflowInterventionError)
    await expect(
      storage.submit({
        id: "missing",
        projectId: "my-app",
        response: {},
      })
    ).rejects.toBeInstanceOf(WorkflowInterventionError)
    await expect(
      storage.create(createInterventionInput({ id: "submit-me" }))
    ).rejects.toBeInstanceOf(WorkflowInterventionError)
    await expect(
      storage.create(
        createInterventionInput({
          id: "bad-index",
          nodeIndex: -1,
        })
      )
    ).rejects.toBeInstanceOf(WorkflowInterventionError)
  })

  test("InMemoryStorage includes workflow intervention storage", () => {
    const storage = new InMemoryStorage()
    expect(storage.workflowInterventions).toBeInstanceOf(InMemoryWorkflowInterventionStorage)
  })
})

function createInterventionInput(
  overrides: Partial<CreateWorkflowInterventionInput> = {}
): CreateWorkflowInterventionInput {
  return {
    id: "intervention-1",
    projectId: "my-app",
    workflowId: "review-workflow",
    workflowRunId: "run-1",
    nodeRunId: "node-1",
    nodeIndex: 0,
    nodeId: "review-draft-document",
    nodeKey: "reviewDraftDocument",
    interventionId: "review-draft-document",
    input: { draftId: "draft-1" },
    defaultResponse: { decision: "approve" },
    requestedAt: new Date("2026-05-08T10:00:00.000Z"),
    ...overrides,
  }
}
