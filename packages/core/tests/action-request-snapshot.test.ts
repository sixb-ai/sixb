import { expect, test } from "bun:test"
import { type ActionDefinition, defineAction, emptyGrantIndex, SixbHost } from "../src"
import type { RequestActionInput } from "../src/actions"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const allowedAction = defineAction("allowed-action")
  .params({})
  .writeback(async () => {})

const deniedAction = defineAction("denied-action")
  .params({})
  .writeback(async () => {})

function actionDefinition(action: unknown): ActionDefinition {
  return action as ActionDefinition
}

test("authorizes and dispatches the same snapshotted action request", async () => {
  const runtimeDeps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "action-request-snapshot",
    ontology: [],
    actions: [actionDefinition(allowedAction), actionDefinition(deniedAction)],
    ...runtimeDeps,
  })
  const auth = runtimeDeps.storage.auth
  if (!auth) throw new Error("Test runtime requires auth storage.")
  await auth.users.create({
    projectId: host.id,
    id: "requester",
    email: "requester@example.com",
  })
  const sixb = createTestSixb(host, {
    authorization: {
      principal: { type: "user", id: "requester" },
      groupIds: [],
      roleIds: [],
      grants: {
        ...emptyGrantIndex(),
        "apply:action": new Set([allowedAction.id]),
      },
    },
  })

  let actionIdReads = 0
  const input = {
    get actionId() {
      actionIdReads += 1
      return actionIdReads === 1 ? allowedAction.id : deniedAction.id
    },
    runId: "act_snapshot",
  } as RequestActionInput

  const result = await sixb.actions.request(input)
  const stored = await runtimeDeps.storage.actionRuns?.getById({
    projectId: host.id,
    id: result.runId,
  })

  expect(actionIdReads).toBe(1)
  expect(stored?.actionId).toBe(allowedAction.id)
})
