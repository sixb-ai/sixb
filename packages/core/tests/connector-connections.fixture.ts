import { expect } from "bun:test"
import {
  type AuthorizationContext,
  type ConnectorOAuthCredentials,
  defineConnector,
  emptyGrantIndex,
  type SixbErrorCode,
} from "../src"
import type {
  ConnectorConnectionCommandContext,
  ConnectorConnectionProcess,
} from "../src/connectors/connections/contracts"
import { hashSecret } from "../src/connectors/connections/validation"
import { createConnectorCredentialProtectorFromKey } from "../src/connectors/credentials"
import { ConnectorService, type ConnectorServiceOptions } from "../src/connectors/service"
import { isSixbError } from "../src/errors/internal"
import { executionRecordInputFromRuntime } from "../src/execution/durable"
import { createPrincipalRequestScope } from "../src/execution/scopes"
import type { ConnectorConnectionStorage } from "../src/storage"
import { InMemoryStorage } from "../src/storage/in-memory"
import { getInMemoryStorageTestingAdapter } from "../src/storage/in-memory/testing"

export const callbackUrl = "https://app.test/api/connectors/callback"
export const projectOwner = { type: "project" } as const
export const encryptionKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url")

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

export function expectSixbError(error: unknown, code: SixbErrorCode) {
  expect(isSixbError(error)).toBe(true)
  if (!isSixbError(error)) throw new Error("Expected a coded Sixb error.")
  expect(error.code).toBe(code)
  return error
}

export type HarnessOptions = Pick<
  ConnectorServiceOptions,
  | "accountSelectionTtlMs"
  | "credentialMutationLeaseMs"
  | "providerOperationTimeoutMs"
  | "refreshSkewMs"
> & { readonly systemStorageClock?: boolean }

export function createHarness(options: HarnessOptions = {}) {
  let now = new Date("2026-08-19T12:00:00.000Z")
  let exchangeCount = 0
  let refreshCount = 0
  let revokeCount = 0
  let refreshError: Error | undefined
  let revokeError: Error | undefined
  let revokeAfterEffectError: Error | undefined
  let omitRefreshMetadata = false
  let authorizationUrlGate: Promise<void> | undefined
  let exchangeGate: Promise<void> | undefined
  let discoverGate: Promise<void> | undefined
  let refreshGate: Promise<void> | undefined
  let revokeGate: Promise<void> | undefined
  let providerRevoked = false
  const exchangedVerifiers: string[] = []
  const refreshInputs: ConnectorOAuthCredentials[] = []

  const connector = defineConnector("social", {
    type: "fake-oauth",
    authentication: {
      type: "oauth2",
      async authorizationUrl(_context, input) {
        await authorizationUrlGate
        const url = new URL("https://provider.test/oauth/authorize")
        url.searchParams.set("state", input.state)
        url.searchParams.set("code_challenge", input.codeChallenge)
        url.searchParams.set("code_challenge_method", input.codeChallengeMethod)
        return url
      },
      async exchangeCode(_context, input) {
        await exchangeGate
        exchangedVerifiers.push(input.codeVerifier)
        exchangeCount += 1
        return {
          accessToken: `access-secret-${exchangeCount}`,
          refreshToken: `refresh-secret-${exchangeCount}`,
          tokenType: "Bearer",
          scopes: ["accounts.read"],
          expiresAt: new Date(now.getTime() + 30_000),
        }
      },
      async refresh(_context, credentials) {
        refreshCount += 1
        refreshInputs.push(structuredClone(credentials))
        await refreshGate
        if (refreshError) throw refreshError
        if (omitRefreshMetadata) {
          return {
            accessToken: `rotated-access-${refreshCount}`,
            expiresAt: new Date(now.getTime() + 60 * 60_000),
          }
        }
        return {
          accessToken: `rotated-access-${refreshCount}`,
          refreshToken: `rotated-refresh-${refreshCount}`,
          tokenType: credentials.tokenType,
          scopes: credentials.scopes,
          expiresAt: new Date(now.getTime() + 60 * 60_000),
        }
      },
      async revoke() {
        revokeCount += 1
        await revokeGate
        if (providerRevoked) return
        if (revokeError) throw revokeError
        providerRevoked = true
        if (revokeAfterEffectError) throw revokeAfterEffectError
      },
    },
    async discoverAccounts() {
      await discoverGate
      return [
        { id: "account-a", label: "Account A" },
        { id: "account-b", label: "Account B" },
      ]
    },
    connect(context) {
      let latestToken: Awaited<ReturnType<typeof context.tokenSource.get>> | undefined
      return {
        accountId: context.account.id,
        aborted: () => context.signal.aborted,
        async token() {
          latestToken = await context.tokenSource.get()
          return {
            accessToken: latestToken.accessToken,
            ...(latestToken.tokenType === undefined ? {} : { tokenType: latestToken.tokenType }),
          }
        },
        tokenHandle: () => context.tokenSource.get(),
        invalidate: () => latestToken?.invalidate(),
      }
    },
  })

  const storage = new InMemoryStorage({
    connectorConnections: {
      now: options.systemStorageClock ? undefined : () => new Date(now),
    },
  })
  const connectionStorage = storage.connectorConnections
  const ready = seedConnectorActors(storage, "project", now)
  const protector = createConnectorCredentialProtectorFromKey(encryptionKey)
  const service = new ConnectorService("project", [connector], {
    storage,
    credentialProtector: protector,
    now: () => new Date(now),
    accountSelectionTtlMs: options.accountSelectionTtlMs,
    credentialMutationLeaseMs: options.credentialMutationLeaseMs,
    providerOperationTimeoutMs: options.providerOperationTimeoutMs,
    refreshSkewMs: options.refreshSkewMs,
  })
  const process = afterReady(requireConnectionProcess(service), ready)

  return {
    connector,
    storage,
    connectionStorage,
    protector,
    process,
    ready,
    service,
    setNow(value: Date) {
      now = new Date(value)
    },
    setRefreshError(value: Error | undefined) {
      refreshError = value
    },
    setOmitRefreshMetadata(value: boolean) {
      omitRefreshMetadata = value
    },
    setRevokeError(value: Error | undefined) {
      revokeError = value
    },
    setRevokeAfterEffectError(value: Error | undefined) {
      revokeAfterEffectError = value
    },
    setExchangeGate(value: Promise<void> | undefined) {
      exchangeGate = value
    },
    setAuthorizationUrlGate(value: Promise<void> | undefined) {
      authorizationUrlGate = value
    },
    setDiscoverGate(value: Promise<void> | undefined) {
      discoverGate = value
    },
    setRefreshGate(value: Promise<void> | undefined) {
      refreshGate = value
    },
    setRevokeGate(value: Promise<void> | undefined) {
      revokeGate = value
    },
    now: () => new Date(now),
    counts: () => ({ exchangeCount, refreshCount, revokeCount }),
    exchangedVerifiers,
    refreshInputs,
  }
}

export function managementScope(
  sessionId = "session-a",
  options: {
    readonly principalId?: string
    readonly manage?: boolean
    readonly projectId?: string
  } = {}
) {
  const grants =
    options.manage === false
      ? emptyGrantIndex()
      : { ...emptyGrantIndex(), "manage:connector": new Set(["social"]) }
  const context: AuthorizationContext = {
    principal: { type: "user", id: options.principalId ?? "user-a" },
    sessionId,
    groupIds: [],
    roleIds: [],
    grants,
  }
  const projectId = options.projectId ?? "project"
  const scope = createPrincipalRequestScope({
    projectId,
    requestId: `request-${sessionId}`,
    correlationId: `correlation-${sessionId}`,
    context,
    credential: { type: "session", id: sessionId },
  })
  return { context, scope }
}

export function managementCommand(
  sessionId = "session-a",
  options: Parameters<typeof managementScope>[1] = {}
): ConnectorConnectionCommandContext {
  const { scope } = managementScope(sessionId, options)
  return {
    execution: executionRecordInputFromRuntime({
      execution: scope.execution,
      runtimeAuthorization: scope.authorization,
    }),
  }
}

export function accessTokenCommand(accessTokenId: string): ConnectorConnectionCommandContext {
  const context: AuthorizationContext = {
    principal: { type: "serviceAccount", id: "service-a" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "manage:connector": new Set(["social"]) },
  }
  const scope = createPrincipalRequestScope({
    projectId: "project",
    requestId: `request-${accessTokenId}`,
    correlationId: `correlation-${accessTokenId}`,
    context,
    credential: { type: "accessToken", id: accessTokenId },
  })
  return {
    execution: executionRecordInputFromRuntime({
      execution: scope.execution,
      runtimeAuthorization: scope.authorization,
    }),
  }
}

export async function startAuthorization(
  harness: ReturnType<typeof createHarness>,
  slot = "social"
) {
  const started = await harness.process.startAuthorization(
    managementCommand(),
    harness.connector.id,
    {
      owner: projectOwner,
      slot,
      redirectUri: callbackUrl,
    }
  )
  const url = new URL(started.authorizationUrl)
  return {
    url,
    state: url.searchParams.get("state")!,
    complete: () =>
      harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
        state: url.searchParams.get("state")!,
        code: "authorization-code",
        redirectUri: callbackUrl,
      }),
  }
}

export async function authorize(harness: ReturnType<typeof createHarness>, slot = "social") {
  return (await startAuthorization(harness, slot)).complete()
}

export function serializedSnapshot(storage: InMemoryStorage): string {
  const snapshot = getInMemoryStorageTestingAdapter(storage).snapshot().connectorConnections
  return JSON.stringify({
    attempts: [...snapshot.attempts.values()],
    authorizations: [...snapshot.authorizations.values()],
    connections: [...snapshot.connections.values()],
  })
}

export function connectionSnapshot(storage: InMemoryStorage) {
  return getInMemoryStorageTestingAdapter(storage).snapshot().connectorConnections
}

export function getAuthorization(storage: ConnectorConnectionStorage, authorizationId: string) {
  return storage.getAuthorization({ projectId: "project", connectorId: "social", authorizationId })
}

export function listAuthorizationConnections(
  storage: ConnectorConnectionStorage,
  authorizationId: string
) {
  return storage.listConnectionsByAuthorization({
    projectId: "project",
    connectorId: "social",
    authorizationId,
  })
}

export async function waitForCredentialMutation(
  storage: ConnectorConnectionStorage,
  authorizationId: string
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const authorization = await getAuthorization(storage, authorizationId)
    if (authorization?.credentialMutation) return authorization.credentialMutation
    await Bun.sleep(1)
  }
  throw new Error("Expected the connector credential mutation to start.")
}

export function requireConnectionProcess(service: ConnectorService): ConnectorConnectionProcess {
  const process = service.connectionProcess
  if (!process) throw new Error("Expected connector connection process.")
  return process
}

export function afterReady(
  process: ConnectorConnectionProcess,
  ready: Promise<void>
): ConnectorConnectionProcess {
  return {
    async startAuthorization(...args) {
      await ready
      return process.startAuthorization(...args)
    },
    async completeAuthorization(...args) {
      await ready
      return process.completeAuthorization(...args)
    },
    async selectAccount(...args) {
      await ready
      return process.selectAccount(...args)
    },
    async disconnect(...args) {
      await ready
      return process.disconnect(...args)
    },
    async revokeAuthorization(...args) {
      await ready
      return process.revokeAuthorization(...args)
    },
  }
}

export async function seedConnectorActors(
  storage: InMemoryStorage,
  projectId: string,
  now: Date
): Promise<void> {
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000)
  await storage.auth.users.create({
    id: "user-a",
    projectId,
    email: `user-a@${projectId}.test`,
    createdAt: now,
    updatedAt: now,
  })
  await storage.auth.users.create({
    id: "user-b",
    projectId,
    email: `user-b@${projectId}.test`,
    createdAt: now,
    updatedAt: now,
  })
  await storage.auth.serviceAccounts.create({
    id: "service-a",
    projectId,
    name: "Service A",
    createdAt: now,
    updatedAt: now,
  })
  for (const [sessionId, userId] of [
    ["session-a", "user-a"],
    ["another-session", "user-a"],
    ["session-b", "user-b"],
  ] as const) {
    await storage.auth.sessions.create({
      id: sessionId,
      projectId,
      userId,
      strategyId: "test",
      audience: "atlas",
      tokenHash: `hash-${sessionId}`,
      createdAt: now,
      expiresAt,
    })
  }
  for (const accessTokenId of ["token-a", "token-b"]) {
    await storage.auth.accessTokens.create({
      id: accessTokenId,
      projectId,
      name: accessTokenId,
      kind: "serviceAccount",
      subjectType: "serviceAccount",
      subjectId: "service-a",
      tokenHash: `hash-${accessTokenId}`,
      createdAt: now,
      expiresAt,
    })
  }
}

export async function seedAuthorizationAttempt(
  harness: ReturnType<typeof createHarness>,
  input: { readonly id: string; readonly initiatedByExecutionId: string }
): Promise<string> {
  await harness.ready
  const state = `${input.id}.${input.id}-state`
  const codeVerifier = await harness.protector.seal(
    new TextEncoder().encode(`${input.id}-verifier`),
    {
      projectId: "project",
      connectorId: harness.connector.id,
      recordId: input.id,
      purpose: "pkce-verifier",
    }
  )
  await harness.connectionStorage.createAuthorizationAttempt({
    id: input.id,
    projectId: "project",
    connectorId: harness.connector.id,
    owner: projectOwner,
    slot: "social",
    initiatedByExecutionId: input.initiatedByExecutionId,
    stateHash: hashSecret(state),
    codeVerifier,
    redirectUri: callbackUrl,
    ttlMs: 10 * 60_000,
  })
  return state
}
