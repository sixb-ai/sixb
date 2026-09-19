import { describe, expect, test } from "bun:test"
import type { ConnectorOAuthCredentials, ReadonlyJsonObject } from "../src"
import { ConnectorCredentialCodec } from "../src/connectors/connections/credential-codec"
import { validateCredentials } from "../src/connectors/connections/validation"
import { ConnectorService } from "../src/connectors/service"
import {
  authorize,
  callbackUrl,
  createHarness,
  getAuthorization,
  managementCommand,
  projectOwner,
  serializedSnapshot,
  startAuthorization,
} from "./connector-connections.fixture"

const selector = { owner: projectOwner, slot: "social" }

// Regression checks: remove callback selection/forwarding in request.ts, context serialization in
// validation.ts, or refresh preservation in tokens.ts and run this file. Each corresponding test fails.
describe("OAuth provider callback parameters and authorization context", () => {
  test("passes only declared callback values and discovers the provider-selected account", async () => {
    const harness = createHarness({
      callbackParameters: ["tenant", "region", "missing"],
      exchange(input) {
        expect(input.callbackParameters).toEqual({ tenant: "tenant-secret", region: "eu" })
        return {
          accessToken: "access-secret",
          authorizationContext: { tenant: input.callbackParameters?.tenant ?? "", region: "eu" },
        }
      },
      discover(credentials) {
        expect(credentials.authorizationContext).toEqual({ tenant: "tenant-secret", region: "eu" })
        return [{ id: "account-a", label: "Verified account" }]
      },
    })
    const started = await startAuthorization(harness)
    const completed = await harness.process.completeAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        state: started.state,
        code: "code",
        redirectUri: callbackUrl,
        callbackParameters: {
          tenant: "tenant-secret",
          region: "eu",
          code: "injected",
          state: "injected",
          ignored: ["one", "two"],
        },
      }
    )
    expect(completed.accounts).toEqual([{ id: "account-a", label: "Verified account" }])
    expect(serializedSnapshot(harness.storage)).not.toContain("tenant-secret")
    expect(await storedCredentials(harness, completed.authorizationId)).toMatchObject({
      authorizationContext: { tenant: "tenant-secret", region: "eu" },
    })
    expect(completed).not.toHaveProperty("authorizationContext")
  })

  test("rejects duplicate accepted values before exchange and consumes the callback once", async () => {
    const harness = createHarness({ callbackParameters: ["tenant"] })
    const started = await startAuthorization(harness)
    await expect(
      harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
        state: started.state,
        code: "code",
        redirectUri: callbackUrl,
        callbackParameters: { tenant: ["one", "two"] },
      })
    ).rejects.toThrow("single string value")
    expect(harness.counts().exchangeCount).toBe(0)
    await expect(started.complete()).rejects.toThrow("invalid, expired, or already used")
  })

  test.each(
    [
      ["state"],
      ["code"],
      ["auth_code"],
      ["error"],
      ["error_description"],
      ["error_uri"],
      ["tenant", "tenant"],
      [""],
      ["bad name"],
    ].map((names) => ({ names }))
  )("rejects invalid callback declarations: %j", async ({ names }) => {
    const harness = createHarness({ callbackParameters: names })
    await expect(startAuthorization(harness)).rejects.toThrow("unique, non-reserved")
    expect(harness.counts().exchangeCount).toBe(0)
  })

  test("supports providers without callback declarations and legacy credentials", async () => {
    const harness = createHarness({
      exchange(input) {
        expect(input.callbackParameters).toEqual({})
        return { accessToken: "legacy-token" }
      },
    })
    const completed = await authorize(harness)
    expect(await storedCredentials(harness, completed.authorizationId)).toEqual({
      accessToken: "legacy-token",
    })
  })

  test("preserves, replaces, and clears context across refreshes after service restart", async () => {
    let update: ReadonlyJsonObject | undefined
    const context = { tenant: "private-tenant", nested: { regions: ["eu", "us"], enabled: true } }
    const harness = createHarness({
      refreshSkewMs: 0,
      exchange: () => ({
        accessToken: "access",
        refreshToken: "refresh",
        authorizationContext: context,
      }),
      refresh: () => ({
        accessToken: "rotated",
        ...(update === undefined ? {} : { authorizationContext: update }),
      }),
    })
    const authorization = await authorize(harness)
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      ...selector,
      authorizationId: authorization.authorizationId,
      accountId: "account-a",
    })
    await harness.service.close()
    const restarted = new ConnectorService("project", [harness.connector], {
      storage: harness.storage,
      credentialProtector: harness.protector,
      now: harness.now,
      refreshSkewMs: 0,
    })
    try {
      const client = await restarted.connectConnection(harness.connector, selector)
      const updates: readonly (ReadonlyJsonObject | undefined)[] = [
        undefined,
        { tenant: "replacement" },
        {},
      ]
      for (const next of updates) {
        update = next
        const token = await client.tokenHandle()
        expect(token).not.toHaveProperty("authorizationContext")
        token.invalidate()
        await client.token()
        expect(
          (await storedCredentials(harness, authorization.authorizationId)).authorizationContext
        ).toEqual(next ?? context)
      }
      expect(harness.refreshInputs.map((input) => input.authorizationContext)).toEqual([
        context,
        context,
        { tenant: "replacement" },
      ])
      expect(serializedSnapshot(harness.storage)).not.toContain("private-tenant")
    } finally {
      await restarted.close()
    }
  })

  test("replaces context on reauthorization and rejects an incompatible account", async () => {
    const discovered: unknown[] = []
    const harness = createHarness({
      callbackParameters: ["tenant", "region"],
      exchange: (input) => ({
        accessToken: "access",
        authorizationContext: { ...input.callbackParameters },
      }),
      discover(credentials) {
        discovered.push(credentials.authorizationContext)
        return [{ id: String(credentials.authorizationContext?.tenant), label: "Verified tenant" }]
      },
    })
    const initial = await startAuthorization(harness)
    const completed = await harness.process.completeAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        state: initial.state,
        code: "code",
        redirectUri: callbackUrl,
        callbackParameters: { tenant: "tenant-a", region: "eu" },
      }
    )
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      ...selector,
      authorizationId: completed.authorizationId,
      accountId: "tenant-a",
    })
    for (const tenant of ["tenant-a", "tenant-b"]) {
      const started = await harness.process.startAuthorization(
        managementCommand(),
        harness.connector.id,
        {
          ...selector,
          redirectUri: callbackUrl,
          reauthorizationId: completed.authorizationId,
        }
      )
      const result = harness.process.completeAuthorization(
        managementCommand(),
        harness.connector.id,
        {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: "new-code",
          redirectUri: callbackUrl,
          callbackParameters: { tenant },
        }
      )
      if (tenant === "tenant-a") {
        await result
        expect(
          (await storedCredentials(harness, completed.authorizationId)).authorizationContext
        ).toEqual({ tenant: "tenant-a" })
      } else {
        await expect(result).rejects.toThrow("changed incompatibly")
        expect(
          (await getAuthorization(harness.connectionStorage, completed.authorizationId))?.status
        ).toBe("needs_reauthorization")
      }
    }
    expect(discovered).toEqual([
      { tenant: "tenant-a", region: "eu" },
      { tenant: "tenant-a" },
      { tenant: "tenant-b" },
    ])
  })

  test("validates JSON context without lossy coercion and detaches mutable adapter data", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const invalid of [
      null,
      [],
      new Date(),
      { value: undefined },
      { value: NaN },
      { value: 1n },
      circular,
    ]) {
      expect(() =>
        validateCredentials({
          accessToken: "access",
          authorizationContext: invalid as ReadonlyJsonObject,
        })
      ).toThrow("expected a JSON object")
    }
    const context = { nested: { tenant: "original" } }
    const credentials = validateCredentials({
      accessToken: "access",
      authorizationContext: context,
    })
    context.nested.tenant = "changed"
    expect(credentials.authorizationContext).toEqual({ nested: { tenant: "original" } })
  })
})

async function storedCredentials(
  harness: ReturnType<typeof createHarness>,
  authorizationId: string
): Promise<ConnectorOAuthCredentials> {
  const authorization = await getAuthorization(harness.connectionStorage, authorizationId)
  if (!authorization?.credentials) throw new Error("Expected encrypted credentials")
  return new ConnectorCredentialCodec({ projectId: "project", protector: harness.protector }).open(
    harness.connector.id,
    authorizationId,
    authorization.credentials
  )
}
