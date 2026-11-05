import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { AuthorizationError } from "../src"
import type { ConnectorAccountCandidate } from "../src/connectors/types"
import {
  callbackUrl,
  connectAccount,
  createGate,
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

describe("connector connection runs returning from the provider", () => {
  const accountA = { id: "account-a", label: "Account A" }
  const accountB = { id: "account-b", label: "Account B" }

  afterEach(() => {
    mock.restore()
  })

  /** A harness whose grants expose `accounts`, which a test may change between runs. */
  function harnessExposing(initial: readonly ConnectorAccountCandidate[]) {
    let accounts = initial
    const harness = createHarness({ discover: () => accounts })

    async function returnFromProvider() {
      const started = await harness.process.startConnectionRun(
        managementCommand(),
        harness.connector.id,
        { owner: projectOwner, slot: "social", redirectUri: callbackUrl, returnTo }
      )
      await harness.process.callbackProcess.completeConnectionRun({
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "code",
        redirectUri: callbackUrl,
        callbackBinding: started.callbackBinding.secret,
      })
      const run = await harness.process.getConnectionRun(
        managementCommand(),
        harness.connector.id,
        started.runId
      )
      if (!run) throw new Error("Expected the connection run.")
      return run
    }

    return {
      harness,
      returnFromProvider,
      expose(next: readonly ConnectorAccountCandidate[]) {
        accounts = next
      },
      connections: () => harness.process.listConnections(managementCommand(), harness.connector.id),
    }
  }

  test("connects the only account without waiting for a selection", async () => {
    // Remove connectOnlyAccount's call: the run stops at account_selection.
    const { harness, returnFromProvider, connections } = harnessExposing([accountA])

    expect(await returnFromProvider()).toMatchObject({
      status: "succeeded",
      connections: [{ slot: "social", account: { id: "account-a" }, status: "connected" }],
    })

    expect(await connections()).toMatchObject([{ slot: "social", status: "connected" }])
    await expect(
      harness.process.listPendingConnectionRuns(managementCommand(), harness.connector.id)
    ).resolves.toEqual([])
    expect(harness.counts().revokeCount).toBe(0)
  })

  test("waits for a selection when the grant exposes several accounts", async () => {
    // Connect authorization.accounts[0] unconditionally: the run succeeds without a choice.
    const { returnFromProvider, connections } = harnessExposing([accountA, accountB])

    expect(await returnFromProvider()).toMatchObject({
      status: "waiting",
      waitingFor: "account_selection",
      accounts: [accountA, accountB],
    })
    expect(await connections()).toEqual([])
  })

  test("moves the same account onto its new grant", async () => {
    const { harness, returnFromProvider, connections } = harnessExposing([accountA])
    await returnFromProvider()
    const [before] = await connections()

    expect(await returnFromProvider()).toMatchObject({ status: "succeeded" })

    const [after] = await connections()
    expect(after?.id).toBe(before?.id)
    expect(after?.account.id).toBe("account-a")
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("asks before replacing a different account connected to the slot", async () => {
    // Pass replace: true from connectOnlyAccount: the connected account is silently replaced.
    const { harness, returnFromProvider, expose, connections } = harnessExposing([accountA])
    await returnFromProvider()
    expose([accountB])
    const warn = spyOn(console, "warn")

    const run = await returnFromProvider()

    expect(run).toMatchObject({ status: "waiting", accounts: [accountB] })
    expect(await connections()).toMatchObject([{ account: { id: "account-a" } }])
    expect(warn).not.toHaveBeenCalled()
    await harness.process.selectConnectionRunAccount(managementCommand(), harness.connector.id, {
      runId: run.id,
      accountId: "account-b",
      replace: true,
    })
    expect(await connections()).toMatchObject([{ account: { id: "account-b" } }])
  })

  test("connects a different account to a slot that was disconnected", async () => {
    // Restore the conflict for disconnected slots: signing in again with the right account stops
    // at the picker, then fails with connector.replacement_required.
    const { harness, returnFromProvider, expose, connections } = harnessExposing([accountA])
    await returnFromProvider()
    const [connection] = await connections()
    await harness.process.disconnect(managementCommand(), harness.connector.id, connection!.id)
    expose([accountB])

    expect(await returnFromProvider()).toMatchObject({ status: "succeeded" })

    expect(await connections()).toMatchObject([
      { id: connection!.id, account: { id: "account-b" }, status: "connected" },
    ])
  })

  test("fails the run and revokes a grant that exposes no account", async () => {
    // Remove the empty-account check: the run waits forever with nothing to select.
    const { harness, returnFromProvider, connections } = harnessExposing([])

    expect(await returnFromProvider()).toMatchObject({
      status: "failed",
      error: { code: "connector.not_found" },
    })

    expect(await connections()).toEqual([])
    expect(harness.counts().revokeCount).toBe(1)
  })

  test("leaves the run selectable when connecting the only account fails", async () => {
    // Drop connectOnlyAccount's catch: the callback fails on a run that already left processing.
    const { harness, returnFromProvider, connections } = harnessExposing([accountA])
    await returnFromProvider()
    const [connection] = await connections()
    const previous = await harness.connectionStorage.getAuthorizationByConnectionId({
      projectId: "project",
      connectorId: harness.connector.id,
      connectionId: connection!.id,
    })

    // A slot's connection cannot move while its grant is being reauthorized.
    const exchange = createGate()
    harness.setExchangeGate(exchange.wait)
    const started = await harness.process.startAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: previous!.id,
      }
    )
    const reauthorizing = harness.process.completeAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "reauthorization-code",
        redirectUri: callbackUrl,
      }
    )
    await exchange.entered
    harness.setExchangeGate(undefined)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    const run = await returnFromProvider()

    expect(run).toMatchObject({ status: "waiting", accounts: [accountA] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(harness.counts().revokeCount).toBe(0)

    exchange.release()
    await reauthorizing
    await expect(
      harness.process.selectConnectionRunAccount(managementCommand(), harness.connector.id, {
        runId: run.id,
        accountId: "account-a",
      })
    ).resolves.toMatchObject({ status: "succeeded" })
  })
})
