import { describe, expect, test } from "bun:test"
import type { EventDraft } from "../src/events/types"
import {
  callbackUrl,
  connectAccount,
  createHarness,
  managementCommand,
  projectOwner,
  rejectionOf,
} from "./connector-connections.fixture"

const connectorId = "social"

/** A harness whose connection events land in `emitted`, as the host's event service would get them. */
function harnessWithEvents(options: Parameters<typeof createHarness>[0] = {}) {
  const emitted: EventDraft[] = []
  const harness = createHarness({
    ...options,
    events: {
      async emit(input) {
        emitted.push(...input.events)
      },
    },
  })
  const announced = () =>
    emitted.map((event) =>
      event.type === "connector.connection.connected" ||
      event.type === "connector.connection.disconnected"
        ? `${event.type.slice("connector.connection.".length)}:${event.payload.reason}:${event.payload.connection.account.id}`
        : event.type
    )
  return { harness, emitted, announced }
}

describe("connection events", () => {
  // Countercheck: drop `this.events.connected` from ConnectorConnectionService.selectAccount.
  test("connecting announces the connection, with its account and nothing secret", async () => {
    const { harness, emitted, announced } = harnessWithEvents()
    const { connection } = await connectAccount(harness)

    expect(announced()).toEqual(["connected:connected:account-a"])
    expect(emitted[0]?.payload).toEqual({
      connectorId,
      connection: {
        id: connection.id,
        connectorId,
        owner: projectOwner,
        slot: "social",
        account: { id: "account-a", label: "Account A" },
      },
      reason: "connected",
    })
    expect(JSON.stringify(emitted)).not.toContain("secret")
  })

  test("a connection run announces the account it connects", async () => {
    const { harness, announced } = harnessWithEvents({
      discover: () => [{ id: "account-a", label: "Account A" }],
    })
    const started = await harness.process.startConnectionRun(managementCommand(), connectorId, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
      returnTo: "https://app.test/connections",
    })
    await harness.process.callbackProcess.completeConnectionRun({
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "authorization-code",
      redirectUri: callbackUrl,
      callbackBinding: started.callbackBinding.secret,
    })

    expect(announced()).toEqual(["connected:connected:account-a"])
  })

  test("replacing a slot's account announces it as replaced", async () => {
    const { harness, announced } = harnessWithEvents()
    const { authorizationId } = await connectAccount(harness)
    await harness.process.selectAccount(managementCommand(), connectorId, {
      authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "social",
      replace: true,
    })

    expect(announced()).toEqual(["connected:connected:account-a", "connected:replaced:account-b"])
  })

  // Countercheck: drop `this.events.connected` from completeReauthorization.
  test("reconnecting announces each connection on the renewed grant", async () => {
    const { harness, announced } = harnessWithEvents()
    const { authorizationId } = await connectAccount(harness)
    const started = await harness.process.startAuthorization(managementCommand(), connectorId, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
      reauthorizationId: authorizationId,
    })
    await harness.process.completeAuthorization(managementCommand(), connectorId, {
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "reauthorization-code",
      redirectUri: callbackUrl,
    })

    expect(announced()).toEqual([
      "connected:connected:account-a",
      "connected:reconnected:account-a",
    ])
  })

  test("disconnecting and revoking announce why Sixb can no longer use the connection", async () => {
    const disconnecting = harnessWithEvents()
    const first = await connectAccount(disconnecting.harness)
    await disconnecting.harness.process.disconnect(
      managementCommand(),
      connectorId,
      first.connection.id
    )
    expect(disconnecting.announced()).toEqual([
      "connected:connected:account-a",
      "disconnected:disconnected:account-a",
    ])

    const revoking = harnessWithEvents()
    const second = await connectAccount(revoking.harness)
    await revoking.harness.process.revokeConnection(
      managementCommand(),
      connectorId,
      second.connection.id
    )
    expect(revoking.announced()).toEqual([
      "connected:connected:account-a",
      "disconnected:revoked:account-a",
    ])
  })

  // Countercheck: drop `this.events.disconnected` from revokeUserConnections.
  test("a suspension announces each of the person's connections, and no one else's", async () => {
    const { harness, emitted } = harnessWithEvents({ owners: ["project", "user"] })
    const own = (userId: "user-a" | "user-b") =>
      // The fixture seeds a session for each of them.
      managementCommand(userId === "user-a" ? "session-a" : "session-b", {
        principalId: userId,
        manage: false,
      })
    for (const userId of ["user-a", "user-b"] as const) {
      const started = await harness.process.startAuthorization(own(userId), connectorId, {
        owner: { type: "user", id: userId },
        slot: "default",
        redirectUri: callbackUrl,
      })
      const { authorizationId } = await harness.process.completeAuthorization(
        own(userId),
        connectorId,
        {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: "authorization-code",
          redirectUri: callbackUrl,
        }
      )
      await harness.process.selectAccount(own(userId), connectorId, {
        authorizationId,
        accountId: "account-a",
        owner: { type: "user", id: userId },
        slot: "default",
      })
    }
    emitted.length = 0

    await harness.service.revokeUserConnections("user-a")

    expect(
      emitted.map((event) =>
        event.type === "connector.connection.disconnected"
          ? [event.payload.reason, event.payload.connection.owner]
          : event.type
      )
    ).toEqual([["suspended", { type: "user", id: "user-a" }]])
  })

  test("a write that fails announces nothing", async () => {
    const { harness, emitted } = harnessWithEvents()
    const { authorizationId } = await connectAccount(harness)
    emitted.length = 0

    // The slot holds account-a; another account needs an explicit replacement.
    await rejectionOf(
      harness.process.selectAccount(managementCommand(), connectorId, {
        authorizationId,
        accountId: "account-b",
        owner: projectOwner,
        slot: "social",
      })
    )
    expect(emitted).toEqual([])
  })
})
