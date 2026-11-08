import { describe, expect, test } from "bun:test"
import { AuthorizationError, defineConnector } from "../src"
import {
  callbackUrl,
  createHarness,
  expectSixbError,
  managementCommand,
  projectOwner,
  rejectionOf,
} from "./connector-connections.fixture"

const connectorId = "social"
const userOwner = (id: string) => ({ type: "user", id }) as const
// The harness seeds user-a and user-b. "another-session" signs user-a in again, with can.manage.
const sessions = { "user-a": "session-a", "user-b": "session-b" } as const
type User = keyof typeof sessions
const member = (id: User) => managementCommand(sessions[id], { principalId: id, manage: false })
const manager = () => managementCommand("another-session", { principalId: "user-a" })

/** One person authorizes with their own account and fills their own `default` slot. */
async function connectOwn(harness: ReturnType<typeof createHarness>, userId: User) {
  const command = member(userId)
  const started = await harness.process.startAuthorization(command, connectorId, {
    owner: userOwner(userId),
    slot: "default",
    redirectUri: callbackUrl,
  })
  const { authorizationId } = await harness.process.completeAuthorization(command, connectorId, {
    state: new URL(started.authorizationUrl).searchParams.get("state")!,
    code: "authorization-code",
    redirectUri: callbackUrl,
  })
  return harness.process.selectAccount(command, connectorId, {
    authorizationId,
    accountId: "account-a",
    owner: userOwner(userId),
    slot: "default",
  })
}

describe("personal connector connections", () => {
  test("defineConnector checks who may own an OAuth connector's connections", () => {
    const { adapter } = createHarness().connector
    expect(defineConnector("m365", adapter).owners).toBeUndefined()
    expect(defineConnector("m365", adapter, { owners: ["user"] }).owners).toEqual(["user"])
    for (const owners of [[], ["user", "user"], ["team"]]) {
      expect(() => defineConnector("m365", adapter, { owners: owners as never })).toThrow(
        'owners must list "project", "user" or both'
      )
    }
    const defineAny = defineConnector as (...args: unknown[]) => unknown
    expect(() =>
      defineAny("static", { type: "static", connect: () => ({}) }, { owners: ["user"] })
    ).toThrow("has no OAuth connections to own")
  })

  test("a member connects their own account and sees only their own", async () => {
    const harness = createHarness({ owners: ["project", "user"] })
    const ada = await connectOwn(harness, "user-a")
    const ben = await connectOwn(harness, "user-b")

    expect(ada).toMatchObject({ owner: userOwner("user-a"), status: "connected" })
    expect(ben).toMatchObject({ owner: userOwner("user-b"), status: "connected" })
    const ids = async (command: ReturnType<typeof member>) =>
      (await harness.process.listConnections(command, connectorId)).map(({ id }) => id).sort()
    expect(await ids(member("user-a"))).toEqual([ada.id])
    expect(await ids(member("user-b"))).toEqual([ben.id])
    expect(await ids(manager())).toEqual([ada.id, ben.id].sort())
  })

  test("a member can't fill the project's slot or someone else's", async () => {
    const harness = createHarness({ owners: ["project", "user"] })
    const start = (owner: typeof projectOwner | ReturnType<typeof userOwner>) =>
      rejectionOf(
        harness.process.startAuthorization(member("user-a"), connectorId, {
          owner,
          slot: "default",
          redirectUri: callbackUrl,
        })
      )

    const forProject = await start(projectOwner)
    expect(forProject).toBeInstanceOf(AuthorizationError)
    expect((forProject as AuthorizationError).grantKey).toBe("manage:connector:social")
    expect(await start(userOwner("user-b"))).toBeInstanceOf(AuthorizationError)
  })

  test("only the owner reconnects or revokes; a manager can disconnect", async () => {
    const harness = createHarness({ owners: ["user"] })
    const ben = await connectOwn(harness, "user-b")

    // Someone else's connection reads as missing.
    expect(await harness.process.disconnect(member("user-a"), connectorId, ben.id)).toBeNull()
    expectSixbError(
      await rejectionOf(
        harness.process.startReauthorization(member("user-a"), connectorId, ben.id, {
          redirectUri: callbackUrl,
          returnTo: "https://app.test/connections",
        })
      ),
      "connector.not_found"
    )
    expectSixbError(
      await rejectionOf(harness.process.revokeConnection(member("user-a"), connectorId, ben.id)),
      "connector.not_found"
    )

    // A manager sees it, but reconnecting would make them act as Ben.
    expect(
      await rejectionOf(
        harness.process.startReauthorization(manager(), connectorId, ben.id, {
          redirectUri: callbackUrl,
          returnTo: "https://app.test/connections",
        })
      )
    ).toBeInstanceOf(AuthorizationError)
    expect(await harness.process.disconnect(manager(), connectorId, ben.id)).toMatchObject({
      id: ben.id,
      status: "disconnected",
    })
  })

  test("the owner disconnects their own connection", async () => {
    const harness = createHarness({ owners: ["user"] })
    const ada = await connectOwn(harness, "user-a")

    expect(await harness.process.disconnect(member("user-a"), connectorId, ada.id)).toMatchObject({
      status: "disconnected",
    })
  })

  test("a project-only connector still requires can.manage", async () => {
    // Removal proof: let assertConnectorConnectionCommandAccess admit everyone; the member lists.
    const harness = createHarness()
    const listed = await rejectionOf(harness.process.listConnections(member("user-a"), connectorId))
    expect(listed).toBeInstanceOf(AuthorizationError)

    expectSixbError(
      await rejectionOf(
        harness.process.startAuthorization(manager(), connectorId, {
          owner: userOwner("user-a"),
          slot: "default",
          redirectUri: callbackUrl,
        })
      ),
      "connector.configuration_invalid"
    )
  })

  test("a personal-only connector refuses project connections", async () => {
    const harness = createHarness({ owners: ["user"] })
    expectSixbError(
      await rejectionOf(
        harness.process.startAuthorization(manager(), connectorId, {
          owner: projectOwner,
          slot: "default",
          redirectUri: callbackUrl,
        })
      ),
      "connector.configuration_invalid"
    )
  })

  test("syncs read personal connections; sixb.connector() refuses them", async () => {
    const harness = createHarness({ owners: ["user"] })
    const ada = await connectOwn(harness, "user-a")

    expect(
      (await harness.service.listExecutionConnections(harness.connector)).map(({ id, owner }) => ({
        id,
        owner,
      }))
    ).toEqual([{ id: ada.id, owner: userOwner("user-a") }])
    expectSixbError(
      await rejectionOf(
        harness.service.connectConnection(harness.connector, {
          owner: userOwner("user-a"),
          slot: "default",
        })
      ),
      "connector.configuration_invalid"
    )
  })
})
