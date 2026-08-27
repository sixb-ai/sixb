import { describe, expect, test } from "bun:test"
import { AuthorizationError, SixbHost } from "../src"
import { createConnectorRuntime } from "../src/connectors/execution"
import { ConnectorService } from "../src/connectors/service"
import { createTrustedPrimitiveRuntimeAuthorization } from "../src/execution/authorization"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import type { SixbRuntimeContext } from "../src/runtime/types"
import { resolveSyncConnectorSources } from "../src/syncs/sources"
import { createTestActionExecution, createTestSyncExecution } from "../src/testing"
import {
  authorize,
  callbackUrl,
  createHarness,
  encryptionKey,
  expectSixbError,
  managementCommand,
  managementScope,
  projectOwner,
  rejectionOf,
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

  test("resolves every connected account for one trusted Sync execution", async () => {
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
      slot: "brand-a",
      redirectUri: callbackUrl,
    })
    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const authorization = await management.completeAuthorization(command, harness.connector.id, {
      state,
      code: "authorization-code",
      redirectUri: callbackUrl,
    })
    const first = await management.selectAccount(command, harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "brand-a",
    })
    const second = await management.selectAccount(command, harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-b",
      owner: projectOwner,
      slot: "brand-b",
    })
    const host = new SixbHost({
      ontology: [],
      connectors: [harness.connector],
      connectorConnections: { encryptionKey },
      ...dependencies,
    })
    const primitive = { kind: "sync" as const, id: "sync-social", runId: "run-social" }
    const executionId = await createTestSyncExecution(dependencies.storage.executions, {
      projectId: "default",
      syncId: primitive.id,
      runId: primitive.runId,
    })
    const execution = await dependencies.storage.executions.getById({
      projectId: "default",
      id: executionId,
    })
    if (!execution) throw new Error("Expected the Sync execution fixture.")
    const trusted = bindDurablePrimitiveExecution(host, { execution, primitive }).sixb

    const sources = await resolveSyncConnectorSources(trusted.connector, harness.connector)
    expect(sources.map((source) => source.connection?.id)).toEqual(
      [first.id, second.id].sort((left, right) => left.localeCompare(right))
    )
    const clients = await Promise.all(
      sources.map((source) => source.connect(new AbortController().signal))
    )
    expect(clients.map((client) => client.accountId).sort()).toEqual(["account-a", "account-b"])

    await management.disconnect(command, harness.connector.id, first.id)
    const remaining = await resolveSyncConnectorSources(trusted.connector, harness.connector)
    expect(remaining.map((source) => source.connection?.id)).toEqual([second.id])

    const request = host.withScope(managementScope("session-a", { projectId: "default" }).scope)
    await expect(resolveSyncConnectorSources(request.connector, harness.connector)).rejects.toThrow(
      AuthorizationError
    )
  })

  test("cancels and bounds managed client creation", async () => {
    const harness = createHarness({ providerOperationTimeoutMs: 20 })
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
      owner: projectOwner,
      slot: "social",
    })
    const primitive = { kind: "sync" as const, id: "sync-social", runId: "run-social" }
    const execution = {
      id: "execution-social",
      projectId: "project",
      executor: { type: "primitive" as const, ...primitive },
      source: { type: "schedule" as const, eventId: "event-social" },
      correlationId: "correlation-social",
    }
    const runtime = {
      projectId: "project",
      runtimeAuthorization: createTrustedPrimitiveRuntimeAuthorization({
        projectId: "project",
        primitive,
      }),
    } as SixbRuntimeContext
    const connector = createConnectorRuntime(runtime, execution, harness.service)
    const [source] = await resolveSyncConnectorSources(connector, harness.connector)
    if (!source) throw new Error("Expected one managed connector source.")

    harness.setConnectGate(new Promise(() => {}))
    const runController = new AbortController()
    const cancelled = source.connect(runController.signal)
    await waitFor(() => harness.connectionSignals.length === 1)
    runController.abort(new DOMException("cancelled by test", "AbortError"))
    await expect(cancelled).rejects.toThrow("cancelled by test")
    expect(harness.connectionSignals[0]?.aborted).toBe(true)

    const timedOut = await rejectionOf(source.connect(new AbortController().signal))
    expectSixbError(timedOut, "connector.provider_unavailable")
    expect(harness.connectionSignals[1]?.aborted).toBe(true)

    harness.setConnectGate(undefined)
    const lifetimeController = new AbortController()
    const client = await source.connect(lifetimeController.signal)
    expect(client.aborted()).toBe(false)
    lifetimeController.abort()
    expect(client.aborted()).toBe(true)
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for connector client creation.")
}
