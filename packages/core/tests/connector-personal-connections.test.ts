import { describe, expect, test } from "bun:test"
import { AuthorizationError, defineConnector, type Sixb, SixbHost } from "../src"
import { ConnectorService } from "../src/connectors/service"
import type { AuthorizablePrincipal, TrustedPrimitiveRef } from "../src/execution"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import { createTestActionExecution, createTestAutomaticWorkflowExecution } from "../src/testing"
import {
  callbackUrl,
  createHarness,
  encryptionKey,
  expectSixbError,
  managementCommand,
  projectOwner,
  rejectionOf,
  requireConnectionProcess,
  seedConnectorActors,
} from "./connector-connections.fixture"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const connectorId = "social"
const userOwner = (id: string) => ({ type: "user", id }) as const
// The harness seeds user-a and user-b. "another-session" signs user-a in again, with can.manage.
const sessions = { "user-a": "session-a", "user-b": "session-b" } as const
type User = keyof typeof sessions
type PersonalConnector = ReturnType<typeof createHarness>["connector"]
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

  test("a person's grant never fills a project slot", async () => {
    // Removal proof: return early from assertAuthorizationOwner; both project slots fill.
    const harness = createHarness({ owners: ["project", "user"] })
    const ada = await connectOwn(harness, "user-a")
    const grant = await harness.connectionStorage.getAuthorizationByConnectionId({
      projectId: "project",
      connectorId,
      connectionId: ada.id,
    })

    // Ada manages the connector, so only the grant's owner stops her.
    expectSixbError(
      await rejectionOf(
        harness.process.addConnection(manager(), connectorId, {
          fromConnectionId: ada.id,
          owner: projectOwner,
          slot: "shared",
        })
      ),
      "connector.operation_conflict"
    )
    expectSixbError(
      await rejectionOf(
        harness.process.selectAccount(manager(), connectorId, {
          authorizationId: grant!.id,
          accountId: "account-a",
          owner: projectOwner,
          slot: "shared",
        })
      ),
      "connector.operation_conflict"
    )

    // Her own second slot can still share it.
    expect(
      await harness.process.addConnection(member("user-a"), connectorId, {
        fromConnectionId: ada.id,
        owner: userOwner("user-a"),
        slot: "work",
      })
    ).toMatchObject({ owner: userOwner("user-a"), slot: "work" })
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

  test("syncs read every personal connection", async () => {
    const harness = createHarness({ owners: ["user"] })
    const ada = await connectOwn(harness, "user-a")

    expect(
      (await harness.service.listExecutionConnections(harness.connector)).map(({ id, owner }) => ({
        id,
        owner,
      }))
    ).toEqual([{ id: ada.id, owner: userOwner("user-a") }])
  })
})

describe("personal connections in actions and workflows", () => {
  const projectId = "default"

  /** Ada connects account-a and Ben account-b, each in their own `default` slot. */
  async function personalHost() {
    const harness = createHarness({ owners: ["user"] })
    const dependencies = createTestRuntimeDeps()
    await seedConnectorActors(dependencies.storage, projectId, new Date("2026-08-19T12:00:00.000Z"))
    const process = requireConnectionProcess(
      new ConnectorService(projectId, [harness.connector], {
        storage: dependencies.storage,
        credentialProtector: harness.protector,
      })
    )
    for (const [userId, accountId] of [
      ["user-a", "account-a"],
      ["user-b", "account-b"],
    ] as const) {
      const command = managementCommand(sessions[userId], {
        principalId: userId,
        manage: false,
        projectId,
      })
      const started = await process.startAuthorization(command, connectorId, {
        owner: userOwner(userId),
        slot: "default",
        redirectUri: callbackUrl,
      })
      const { authorizationId } = await process.completeAuthorization(command, connectorId, {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "authorization-code",
        redirectUri: callbackUrl,
      })
      await process.selectAccount(command, connectorId, {
        authorizationId,
        accountId,
        owner: userOwner(userId),
        slot: "default",
      })
    }

    const host = new SixbHost({
      ontology: [],
      connectors: [harness.connector],
      connectorConnections: { encryptionKey },
      ...dependencies,
    })
    const { executions } = dependencies.storage
    const bind = async (executionId: string, primitive: TrustedPrimitiveRef) => {
      const execution = await executions.getById({ projectId, id: executionId })
      if (!execution) throw new Error(`Expected execution '${executionId}'.`)
      return bindDurablePrimitiveExecution(host, { execution, primitive }).sixb
    }
    let runs = 0

    return {
      connector: harness.connector,
      /** An action run on behalf of `requestedBy`, or of no one. */
      async action(requestedBy?: AuthorizablePrincipal) {
        const primitive = { kind: "action", id: "categorize", runId: `run-${++runs}` } as const
        const executionId = await createTestActionExecution(executions, {
          projectId,
          actionId: primitive.id,
          runId: primitive.runId,
          ...(requestedBy === undefined ? {} : { requestedBy }),
        })
        return bind(executionId, primitive)
      },
      /** A workflow an event started: no one requested it. */
      async eventWorkflow() {
        const primitive = { kind: "workflow", id: "classify", runId: `run-${++runs}` } as const
        const executionId = await createTestAutomaticWorkflowExecution(executions, {
          projectId,
          workflowId: primitive.id,
          runId: primitive.runId,
        })
        return bind(executionId, primitive)
      },
    }
  }

  const open = (sixb: Sixb, connector: PersonalConnector, userId: User) =>
    // The guard throws before the connection is read; an async wrapper makes both a rejection.
    (async () => sixb.connector(connector, { owner: userOwner(userId), slot: "default" }))()

  test("a person's own run opens their own connection", async () => {
    const { action, connector } = await personalHost()

    const ada = await open(await action(userOwner("user-a")), connector, "user-a")
    const ben = await open(await action(userOwner("user-b")), connector, "user-b")
    expect([ada.accountId, ben.accountId]).toEqual(["account-a", "account-b"])
  })

  test("a run someone else requested can't open a person's connection", async () => {
    // Removal proof: return early from assertPersonalConnectionRequester; Ben opens Ada's account.
    const { action, connector } = await personalHost()

    const others: AuthorizablePrincipal[] = [
      userOwner("user-b"),
      { type: "serviceAccount", id: "service-a" },
    ]
    for (const requestedBy of others) {
      const refused = await rejectionOf(open(await action(requestedBy), connector, "user-a"))
      expect(refused).toBeInstanceOf(AuthorizationError)
      expect((refused as AuthorizationError).grantKey).toBe("connection:connector:social")
    }
  })

  test("a run no one requested picks the owner from its data", async () => {
    const { action, eventWorkflow, connector } = await personalHost()

    expect((await open(await eventWorkflow(), connector, "user-a")).accountId).toBe("account-a")
    expect((await open(await action(), connector, "user-b")).accountId).toBe("account-b")
  })

  test("a person without a connection in that slot reads as not found", async () => {
    const { eventWorkflow, connector } = await personalHost()
    const sixb = await eventWorkflow()

    const missing = expectSixbError(
      await rejectionOf(sixb.connector(connector, { owner: userOwner("user-a"), slot: "work" })),
      "connector.not_found"
    )
    expect(missing.message).toContain("user 'user-a' in slot 'work'")
  })
})
