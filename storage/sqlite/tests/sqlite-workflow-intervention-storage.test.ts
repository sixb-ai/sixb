import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { CreateWorkflowInterventionInput } from "@sixb/core/storage"
import { SqliteStorage } from "../src"
import { SqliteWorkflowInterventionStorage } from "../src/workflow-intervention-storage"

describe("SqliteWorkflowInterventionStorage", () => {
  let storage: SqliteWorkflowInterventionStorage

  beforeEach(() => {
    storage = new SqliteWorkflowInterventionStorage()
  })

  afterEach(() => {
    storage.close()
  })

  test("creates pending interventions and supports filtered paging", async () => {
    await storage.create(
      createInterventionInput({
        id: "intervention-1",
        requestedAt: new Date("2026-05-08T10:00:00.000Z"),
      })
    )
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
    await storage.create(createInterventionInput({ id: "submit-me" }))
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
    ).rejects.toHaveProperty("code", "storage.conflict")
    await expect(
      storage.create(createInterventionInput({ id: "submit-me" }))
    ).rejects.toHaveProperty("code", "storage.conflict")
    await expect(
      storage.create(
        createInterventionInput({
          id: "bad-index",
          nodeIndex: -1,
        })
      )
    ).rejects.toHaveProperty("code", "runtime.invalid_input")
  })

  test("SqliteStorage includes workflow intervention storage", () => {
    const bundled = new SqliteStorage()

    try {
      expect(bundled.workflowInterventions).toBeInstanceOf(SqliteWorkflowInterventionStorage)
    } finally {
      closeSqliteStorage(bundled)
    }
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

function closeSqliteStorage(storage: SqliteStorage): void {
  storage.close()
}
