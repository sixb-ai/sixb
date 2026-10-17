import { describe, expect, test } from "bun:test"
import {
  SandboxError,
  SandboxNotRunningError,
  type SandboxRequestCredential,
} from "@sixb/core/sandboxes"
import { fixture, type RecordedRequest } from "./vercel-sdk-fixture"

const network = {
  mode: "restricted" as const,
  allow: [{ name: "git", origin: "https://github.com" }],
}

function credential(secret: string): SandboxRequestCredential {
  return {
    origin: "https://github.com",
    path: "/acme/repo.git/git-receive-pack",
    method: "POST",
    headers: { Authorization: `Basic ${secret}` },
  }
}

function endpoint(request: RecordedRequest | undefined): string {
  return `${request?.method} ${request?.path.split("?")[0]}`
}

function carriesSecret(request: RecordedRequest): boolean {
  return JSON.stringify(request.body).includes("secret")
}

describe("Vercel ephemeral request credentials", () => {
  test("injects on the created session before the clone, never in the creation defaults", async () => {
    // Regression proof: move the initial injection after initializeSandboxEnvironment, or drop
    // it; the clone then precedes the policy update, or no update is sent at all.
    const f = fixture()

    // The fake transport rejects commands, so the clone fails after injection.
    await expect(
      f.factory.create({
        network,
        requestCredentials: [credential("initial-secret")],
        environment: { source: { type: "git", url: "https://github.com/acme/repo.git" } },
      })
    ).rejects.toThrow()

    const [creation] = f.requests
    expect(endpoint(creation)).toBe("POST /v2/sandboxes")
    expect(creation?.body.persistent).toBe(false)
    expect(creation?.body.networkPolicy).toEqual({ allow: ["github.com"] })
    expect(JSON.stringify(creation?.body)).not.toContain("initial-secret")

    const injection = f.requests.findIndex((request) => request.path.includes("/network-policy"))
    const clone = f.requests.findIndex((request) => request.path.includes("/cmd"))
    expect(endpoint(f.requests[injection])).toBe(
      "POST /v2/sandboxes/sessions/session-1/network-policy"
    )
    expect(JSON.stringify(f.requests[injection]?.body)).toContain("initial-secret")
    expect(clone).toBeGreaterThan(injection)
    expect(carriesSecret(f.requests[clone]!)).toBe(false)

    expect(endpoint(f.requests.at(-1))).toBe(`DELETE /v2/sandboxes/${creation?.body.name}`)
  })

  test("rejects disallowed credentials before any provider request", async () => {
    // Regression proof: remove the pre-provisioning withRequestCredentials call in create();
    // the sandbox is created first and only then rejected.
    const f = fixture()

    await expect(
      f.factory.create({
        network: { mode: "none" },
        requestCredentials: [credential("blocked-secret")],
      })
    ).rejects.toThrow("credential injection target")

    expect(f.requests).toHaveLength(0)
  })

  test("renewal and removal reach only the pinned session, which never resumes", async () => {
    // Regression proof: return the SDK Sandbox itself from createVercelSandbox; its deprecated
    // updateNetworkPolicy and runCommand resume the stopped session through GET ?resume=true.
    const f = fixture()
    const sandbox = await f.factory.create({
      network,
      requestCredentials: [credential("initial-secret")],
    })
    const base = f.requests[0]?.body.networkPolicy
    const before = f.requests.length

    await sandbox.setRequestCredentials!([credential("renewed-secret")])
    await sandbox.setRequestCredentials!([])

    const updates = f.requests.slice(before)
    expect(updates.map(endpoint)).toEqual([
      "POST /v2/sandboxes/sessions/session-1/network-policy",
      "POST /v2/sandboxes/sessions/session-1/network-policy",
    ])
    expect(JSON.stringify(updates[0]?.body)).toContain("renewed-secret")

    // Removal restores exactly the policy the sandbox was created with.
    const removal: unknown = updates[1]?.body
    expect(removal).toEqual(base)

    // The transport answers commands as a stopped session; a pinned handle must not resume.
    await expect(sandbox.runCommand("git", ["push"])).rejects.toThrow()

    expect(f.requests.some((request) => request.path.includes("resume=true"))).toBe(false)
    expect(f.requests.some((request) => request.method === "PATCH")).toBe(false)
    expect(
      f.requests
        .filter(carriesSecret)
        .every((request) =>
          /^POST \/v2\/sandboxes\/sessions\/[^/]+\/network-policy$/.test(endpoint(request))
        )
    ).toBe(true)
  })

  test("a stopped or destroyed handle rejects credentials without a request", async () => {
    // Regression proof: remove assertRunning from VercelSandbox.setRequestCredentials; the
    // stale handle sends a policy update.
    const f = fixture()
    const sandbox = await f.factory.create({ network })

    await sandbox.stop()
    const afterStop = f.requests.length
    await expect(
      sandbox.setRequestCredentials!([credential("late-secret")])
    ).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(f.requests).toHaveLength(afterStop)

    await sandbox.destroy()
    expect(endpoint(f.requests.at(-1))).toBe(`DELETE /v2/sandboxes/${sandbox.id}`)
    await expect(sandbox.setRequestCredentials!([])).rejects.toBeInstanceOf(SandboxNotRunningError)
    expect(f.requests).toHaveLength(afterStop + 1)
  })

  test("a failed initial injection deletes the sandbox and exposes no provider detail", async () => {
    // Regression proof: let VercelSandbox.setRequestCredentials rethrow the SDK error; the
    // create failure then interpolates the SDK message.
    const f = fixture()
    f.failNetwork()

    const creation = f.factory.create({
      network,
      requestCredentials: [credential("private-secret")],
    })

    await expect(creation).rejects.toBeInstanceOf(SandboxError)
    // Anchored: the fixed message admits neither the provider detail nor the secret.
    await expect(creation).rejects.toThrow(
      /^\[Sandbox\] Vercel credential injection update failed\.$/
    )
    expect(f.requests.some((request) => request.path.includes("/cmd"))).toBe(false)
    expect(endpoint(f.requests.at(-1))).toBe(`DELETE /v2/sandboxes/${f.requests[0]?.body.name}`)
  })
})
