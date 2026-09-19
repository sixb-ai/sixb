import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { OAuthConnectorCodeExchangeInput } from "../src"
import {
  callbackUrl,
  connectionSnapshot,
  createHarness,
  managementCommand,
  projectOwner,
  startAuthorization,
} from "./connector-connections.fixture"

// Removal proof: restore unconditional S256 generation/validation in request.ts; disabled cases fail.
// Remove the attempt/configuration mode check; the configuration-change tests below exchange a code.
describe("connector PKCE capability", () => {
  test.each([
    undefined,
    "S256",
    "disabled",
  ] as const)("authorizes with PKCE mode %s", async (pkce) => {
    let exchanged: OAuthConnectorCodeExchangeInput | undefined
    const harness = createHarness({
      pkce,
      exchange(input) {
        exchanged = input
        return { accessToken: "token" }
      },
    })
    const started = await startAuthorization(harness)
    const [attempt] = connectionSnapshot(harness.storage).attempts.values()
    const enabled = pkce !== "disabled"
    expect(started.url.searchParams.has("code_challenge")).toBe(enabled)
    expect(started.url.searchParams.has("code_challenge_method")).toBe(enabled)
    expect(Object.hasOwn(attempt, "codeVerifier")).toBe(enabled)
    expect(attempt.stateHash).not.toBe(started.state)
    await started.complete()
    if (!exchanged) throw new Error("Expected code exchange")
    if (enabled) {
      expect(exchanged.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(started.url.searchParams.get("code_challenge")).toBe(
        createHash("sha256").update(exchanged.codeVerifier!).digest("base64url")
      )
      expect(started.url.searchParams.get("code_challenge_method")).toBe("S256")
    } else {
      expect(exchanged).not.toHaveProperty("codeVerifier")
    }
    await expect(started.complete()).rejects.toThrow("invalid, expired, or already used")
  })

  test("disabled PKCE still binds the code to the initiating actor and redirect", async () => {
    const harness = createHarness({ pkce: "disabled" })
    const started = await startAuthorization(harness)
    for (const [command, redirectUri] of [
      [managementCommand("other-session"), callbackUrl],
      [managementCommand(), "https://other.test/callback"],
    ] as const) {
      await expect(
        harness.process.completeAuthorization(command, harness.connector.id, {
          state: started.state,
          code: "code",
          redirectUri,
        })
      ).rejects.toThrow("invalid, expired, or already used")
    }
    expect(harness.counts().exchangeCount).toBe(0)
    await started.complete()
  })

  test("reauthorizes a non-PKCE grant without passing a verifier", async () => {
    const harness = createHarness({
      pkce: "disabled",
      exchange(input) {
        expect(input).not.toHaveProperty("codeVerifier")
        return { accessToken: "token" }
      },
    })
    const initial = await startAuthorization(harness)
    const grant = await initial.complete()
    await harness.process.selectAccount(managementCommand(), harness.connector.id, {
      owner: projectOwner,
      slot: "social",
      authorizationId: grant.authorizationId,
      accountId: "account-a",
    })
    const started = await harness.process.startAuthorization(
      managementCommand(),
      harness.connector.id,
      {
        owner: projectOwner,
        slot: "social",
        redirectUri: callbackUrl,
        reauthorizationId: grant.authorizationId,
      }
    )
    const url = new URL(started.authorizationUrl)
    expect(url.searchParams.has("code_challenge")).toBe(false)
    await harness.process.completeAuthorization(managementCommand(), harness.connector.id, {
      state: url.searchParams.get("state")!,
      code: "code",
      redirectUri: callbackUrl,
    })
    expect(harness.exchangedVerifiers).toEqual([undefined, undefined])
  })

  test.each([
    "S256",
    "disabled",
  ] as const)("rejects an in-flight mode change from %s", async (pkce) => {
    const harness = createHarness({ pkce })
    const started = await startAuthorization(harness)
    harness.connector.adapter.authentication.pkce = pkce === "S256" ? "disabled" : "S256"
    await expect(started.complete()).rejects.toThrow("PKCE configuration changed")
    expect(harness.counts().exchangeCount).toBe(0)
  })

  test.each([
    "state",
    "code_challenge",
    "code_challenge_method",
  ])("rejects invalid non-PKCE authorization URL field %s", async (field) => {
    const harness = createHarness({ pkce: "disabled" })
    const original = harness.connector.adapter.authentication.authorizationUrl
    harness.connector.adapter.authentication.authorizationUrl = async (context, input) => {
      const url = await original(context, input)
      url.searchParams.set(field, "unexpected")
      return url
    }
    await expect(startAuthorization(harness)).rejects.toThrow(
      "preserve the framework-provided state"
    )
    expect(connectionSnapshot(harness.storage).attempts.size).toBe(0)
  })

  test("rejects unsupported PKCE modes instead of silently disabling protection", async () => {
    const harness = createHarness({ pkce: "plain" as "S256" })
    await expect(startAuthorization(harness)).rejects.toThrow("PKCE must be S256 or disabled")
  })
})
