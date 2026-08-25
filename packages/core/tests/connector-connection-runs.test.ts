import { describe, expect, test } from "bun:test"
import { AuthorizationError } from "../src"
import {
  callbackUrl,
  createHarness,
  managementCommand,
  projectOwner,
  rejectionOf,
  serializedSnapshot,
} from "./connector-connections.fixture"

const returnTo = "https://app.test/settings/connectors"

describe("connector connection runs", () => {
  test("keeps protocol secrets in a separate one-shot attempt", async () => {
    const harness = createHarness()
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
    expect(completed).toEqual({ runId: started.runId, returnTo })

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

  test("binds run reads and account selection to the initiating actor", async () => {
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
      harness.process.getConnectionRun(
        managementCommand("session-b", { principalId: "user-b" }),
        harness.connector.id,
        started.runId
      )
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  test("records an OAuth denial as a terminal cancelled run", async () => {
    const harness = createHarness()
    const command = managementCommand()
    const started = await harness.process.startConnectionRun(command, harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
      returnTo,
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!

    await expect(
      harness.process.callbackProcess.completeConnectionRun({
        state,
        error: "access_denied",
        redirectUri: callbackUrl,
        callbackBinding: started.callbackBinding.secret,
      })
    ).resolves.toEqual({ runId: started.runId, returnTo })
    await expect(
      harness.process.getConnectionRun(command, harness.connector.id, started.runId)
    ).resolves.toMatchObject({ status: "cancelled" })
    expect(harness.counts().exchangeCount).toBe(0)
  })
})
