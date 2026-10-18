import { describe, expect, test } from "bun:test"
import { AuthorizationError } from "../src"
import {
  callbackUrl,
  connectAccount,
  createHarness,
  expectSixbError,
  managementCommand,
  projectOwner,
  rejectionOf,
  serializedSnapshot,
} from "./connector-connections.fixture"

const returnTo = "https://app.test/settings/connectors"

describe("connector connection runs", () => {
  test("recovers pending selection for the initiating user after a new session", async () => {
    // Remove listPending or restore credential equality for run access to make recovery fail.
    const harness = createHarness()
    const started = await harness.process.startConnectionRun(
      managementCommand(),
      harness.connector.id,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        returnTo,
      }
    )
    await expect(
      harness.process.listPendingConnectionRuns(managementCommand(), harness.connector.id)
    ).resolves.toEqual([])
    await harness.process.callbackProcess.completeConnectionRun({
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "code",
      redirectUri: callbackUrl,
      callbackBinding: started.callbackBinding.secret,
    })
    harness.setNow(new Date("2027-08-19T12:00:00.000Z"))
    const renewed = managementCommand("new-session")
    const pending = await harness.process.listPendingConnectionRuns(renewed, harness.connector.id)
    expect(pending).toMatchObject([
      { id: started.runId, status: "waiting", waitingFor: "account_selection" },
    ])
    expect(JSON.stringify(pending)).not.toContain("authorizationId")
    const other = managementCommand("session-b", { principalId: "user-b" })
    await expect(
      harness.process.listPendingConnectionRuns(other, harness.connector.id)
    ).resolves.toEqual([])
    await expect(
      harness.process.getConnectionRun(other, harness.connector.id, started.runId)
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      harness.process.selectConnectionRunAccount(other, harness.connector.id, {
        runId: started.runId,
        accountId: "account-a",
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      harness.process.selectConnectionRunAccount(renewed, harness.connector.id, {
        runId: started.runId,
        accountId: "account-a",
      })
    ).resolves.toMatchObject({ status: "succeeded" })
    await expect(
      harness.process.listPendingConnectionRuns(renewed, harness.connector.id)
    ).resolves.toEqual([])
    expect(harness.counts().revokeCount).toBe(0)
  })

  test.each([
    undefined,
    "disabled",
  ] as const)("keeps protocol secrets in a separate one-shot attempt (PKCE %s)", async (pkce) => {
    const harness = createHarness({ pkce })
    const command = managementCommand()
    const started = await harness.process.startConnectionRun(command, harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
      returnTo,
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const snapshot = serializedSnapshot(harness.storage)

    expect(snapshot).not.toContain(started.callbackBinding.secret)
    expect(snapshot).not.toContain(state)
    expect(
      await harness.process.getConnectionRun(command, harness.connector.id, started.runId)
    ).toMatchObject({
      status: "waiting",
      waitingFor: "provider_authorization",
    })

    const invalid = await rejectionOf(
      harness.process.callbackProcess.completeConnectionRun({
        state,
        code: "authorization-code",
        redirectUri: callbackUrl,
        callbackBinding: "wrong-binding",
      })
    )
    expect(invalid).toMatchObject({ code: "connector.authorization_invalid" })

    const completed = await harness.process.callbackProcess.completeConnectionRun({
      state,
      code: "authorization-code",
      redirectUri: callbackUrl,
      callbackBinding: started.callbackBinding.secret,
    })
    expect(completed).toEqual({ runId: started.runId, connectorId: harness.connector.id, returnTo })

    const waiting = await harness.process.getConnectionRun(
      command,
      harness.connector.id,
      started.runId
    )
    expect(waiting).toMatchObject({
      status: "waiting",
      waitingFor: "account_selection",
      accounts: [
        { id: "account-a", label: "Account A" },
        { id: "account-b", label: "Account B" },
      ],
    })

    const succeeded = await harness.process.selectConnectionRunAccount(
      command,
      harness.connector.id,
      { runId: started.runId, accountId: "account-a" }
    )
    expect(succeeded).toMatchObject({
      status: "succeeded",
      connections: [{ slot: "social", account: { id: "account-a" } }],
    })
    await expect(harness.process.listConnections(command, harness.connector.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ slot: "social" })])
    )
  })

  test("distinguishes an occupied slot from other run conflicts", async () => {
    const harness = createHarness()
    const command = managementCommand()
    await connectAccount(harness)

    const started = await harness.process.startConnectionRun(command, harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
      returnTo,
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    await harness.process.callbackProcess.completeConnectionRun({
      state,
      code: "authorization-code",
      redirectUri: callbackUrl,
      callbackBinding: started.callbackBinding.secret,
    })

    const replacementRequired = await rejectionOf(
      harness.process.selectConnectionRunAccount(command, harness.connector.id, {
        runId: started.runId,
        accountId: "account-b",
      })
    )
    expectSixbError(replacementRequired, "connector.replacement_required")

    await harness.process.selectConnectionRunAccount(command, harness.connector.id, {
      runId: started.runId,
      accountId: "account-b",
      replace: true,
    })
    const terminalConflict = await rejectionOf(
      harness.process.selectConnectionRunAccount(command, harness.connector.id, {
        runId: started.runId,
        accountId: "account-b",
      })
    )
    expectSixbError(terminalConflict, "connector.operation_conflict")
  })
})
