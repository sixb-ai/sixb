import { describe, expect, test } from "bun:test"
import { AuthorizationError, SixbHost } from "../src"
import { createConnectorRuntime } from "../src/connectors/execution"
import { ConnectorService } from "../src/connectors/service"
import { createTrustedPrimitiveRuntimeAuthorization } from "../src/execution/authorization"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import type { SixbRuntimeContext } from "../src/runtime/types"
import { createTestActionExecution } from "../src/testing"
import {
  callbackUrl,
  createHarness,
  encryptionKey,
  managementCommand,
  managementScope,
  projectOwner,
  requireConnectionProcess,
  seedConnectorActors,
} from "./connector-connections.fixture"
import { createTestRuntimeDeps } from "./test-runtime-deps"

describe("connector connection execution boundary", () => {
  test("binds trusted connector access to the exact primitive execution", () => {
    const harness = createHarness()
    const execution = {
      id: "execution-a",
      projectId: "project",
      executor: { type: "primitive", kind: "action", id: "publish", runId: "run-a" },
      source: { type: "execution", executionId: "request-a" },
      correlationId: "correlation-a",
    } as const
    const runtime = {
      projectId: "project",
      runtimeAuthorization: createTrustedPrimitiveRuntimeAuthorization({
        projectId: "project",
        primitive: { kind: "action", id: "publish", runId: "run-b" },
      }),
    } as SixbRuntimeContext
    const connector = createConnectorRuntime(runtime, execution, harness.service)

    expect(() => connector(harness.connector, { owner: projectOwner, slot: "social" })).toThrow(
      "does not match its executor"
    )
  })

  test("allows durable trusted primitives and denies request principals", async () => {
    const harness = createHarness()
    const dependencies = createTestRuntimeDeps()
    await seedConnectorActors(dependencies.storage, "default", new Date("2026-08-19T12:00:00.000Z"))
    const management = requireConnectionProcess(
      new ConnectorService("default", [harness.connector], {
        storage: dependencies.storage,
        credentialProtector: harness.protector,
      })
    )
    const command = managementCommand("session-a", { projectId: "default" })
    const started = await management.startAuthorization(command, harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      redirectUri: callbackUrl,
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const authorization = await management.completeAuthorization(command, harness.connector.id, {
      state,
      code: "authorization-code",
      redirectUri: callbackUrl,
    })
    await management.selectAccount(command, harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })

    const host = new SixbHost({
      ontology: [],
      connectors: [harness.connector],
      connectorConnections: { encryptionKey },
      ...dependencies,
    })
    const primitive = { kind: "action" as const, id: "publish", runId: "run-a" }
    const executionId = await createTestActionExecution(dependencies.storage.executions, {
      projectId: "default",
      actionId: primitive.id,
      runId: primitive.runId,
    })
    const execution = await dependencies.storage.executions.getById({
      projectId: "default",
      id: executionId,
    })
    if (!execution) throw new Error("Expected the Action execution fixture.")
    const trusted = bindDurablePrimitiveExecution(host, { execution, primitive }).sixb
    const first = await trusted.connector(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    expect(first.accountId).toBe("account-a")
    expect(first.aborted()).toBe(false)

    await host.closeConnectors()
    expect(first.aborted()).toBe(true)
    const reconnected = await trusted.connector(harness.connector, {
      owner: projectOwner,
      slot: "social",
    })
    expect(reconnected.aborted()).toBe(false)

    const request = host.withScope(managementScope("session-a", { projectId: "default" }).scope)
    expect(() =>
      request.connector(harness.connector, { owner: projectOwner, slot: "social" })
    ).toThrow(AuthorizationError)
  })
})
