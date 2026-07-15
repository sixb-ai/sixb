import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { CreateWorkflowInterventionInput } from "@sixb/core/storage"
import { WorkflowInterventionError } from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import { PgWorkflowInterventionStorage } from "../src/pg-workflow-intervention-storage"
import { createTestStorage } from "./helpers"

describe("PgWorkflowInterventionStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("creates pending interventions and supports filtered paging", async () => {
    await storage.workflowInterventions.create(
      createInterventionInput({
        id: "intervention-1",
        requestedAt: new Date("2026-05-08T10:00:00.000Z"),
      })
    )
    await storage.workflowInterventions.create(
      createInterventionInput({
        id: "intervention-2",
        workflowRunId: "run-2",
        requestedAt: new Date("2026-05-08T11:00:00.000Z"),
      })
    )
    await storage.workflowInterventions.submit({
      id: "intervention-2",
      projectId: "my-app",
      response: { decision: "approve" },
    })
    await storage.workflowInterventions.create(
      createInterventionInput({
        id: "other-project",
        projectId: "other-app",
        requestedAt: new Date("2026-05-08T12:00:00.000Z"),
      })
    )

    const stored = await storage.workflowInterventions.getById({
      projectId: "my-app",
      id: "intervention-1",
    })
    const page = await storage.workflowInterventions.list({
      projectId: "my-app",
      statuses: ["pending"],
      workflowId: "review-workflow",
      interventionId: "review-draft-document",
      requestedAfter: new Date("2026-05-08T09:00:00.000Z"),
      order: "asc",
      limit: 1,
    })
    const empty = await storage.workflowInterventions.list({
      projectId: "my-app",
      statuses: [],
    })

    expect(stored).toMatchObject({
      id: "intervention-1",
      status: "pending",
      input: { draftId: "draft-1" },
      defaultResponse: { decision: "approve" },
    })
    expect(stored?.requestedAt.toISOString()).toBe("2026-05-08T10:00:00.000Z")
    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.interventions.map((intervention) => intervention.id)).toEqual(["intervention-1"])
    expect(empty).toEqual({
      interventions: [],
      hasMore: false,
      total: 0,
    })
  })

  test("submits, cancels, expires, and rejects invalid transitions", async () => {
    await storage.workflowInterventions.create(createInterventionInput({ id: "submit-me" }))
    const submitted = await storage.workflowInterventions.submit({
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

    await storage.workflowInterventions.create(createInterventionInput({ id: "cancel-me" }))
    const cancelled = await storage.workflowInterventions.cancel({
      id: "cancel-me",
      projectId: "my-app",
      cancelledBy: {
        principalType: "system",
        principalId: "workflow-timeout",
      },
    })

    await storage.workflowInterventions.create(createInterventionInput({ id: "expire-me" }))
    const expired = await storage.workflowInterventions.expire({
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
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.cancelledBy).toEqual({
      principalType: "system",
      principalId: "workflow-timeout",
    })
    expect(expired.status).toBe("expired")
    expect(expired.expiredAt?.toISOString()).toBe("2026-05-08T13:00:00.000Z")

    await expect(
      storage.workflowInterventions.cancel({
        id: "submit-me",
        projectId: "my-app",
      })
    ).rejects.toBeInstanceOf(WorkflowInterventionError)
    await expect(
      storage.workflowInterventions.create(createInterventionInput({ id: "submit-me" }))
    ).rejects.toBeInstanceOf(WorkflowInterventionError)
    await expect(
      storage.workflowInterventions.create(
        createInterventionInput({
          id: "bad-index",
          nodeIndex: -1,
        })
      )
    ).rejects.toBeInstanceOf(WorkflowInterventionError)
  })

  test("PostgresStorage includes workflow intervention storage", () => {
    expect(storage.workflowInterventions).toBeInstanceOf(PgWorkflowInterventionStorage)
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
