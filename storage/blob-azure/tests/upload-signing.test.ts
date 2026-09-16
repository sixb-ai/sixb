import { describe, expect, test } from "bun:test"
import { BlobServiceClient, type UserDelegationKey } from "@azure/storage-blob"
import { delegationKeyCache, uploadSigner } from "../src/upload-signing"

function key(expiresOn = new Date(Date.now() + 2 * 60 * 60 * 1000)): UserDelegationKey {
  return {
    signedObjectId: "11111111-1111-1111-1111-111111111111",
    signedTenantId: "22222222-2222-2222-2222-222222222222",
    signedStartsOn: new Date(Date.now() - 5 * 60 * 1000),
    signedExpiresOn: expiresOn,
    signedService: "b",
    signedVersion: "2020-12-06",
    value: Buffer.alloc(32, 1).toString("base64"),
  }
}

describe("Azure user-delegation SAS signing", () => {
  test("concurrent signers share one refresh and reuse a valid delegation key", async () => {
    const gate = Promise.withResolvers<UserDelegationKey>()
    let calls = 0
    const load = delegationKeyCache(async (start, end) => {
      calls++
      expect(start.getTime()).toBeLessThan(Date.now())
      expect(end.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
      return gate.promise
    })
    const expiry = new Date(Date.now() + 60_000)
    const pending = [load(expiry), load(expiry)]
    expect(calls).toBe(1)
    const result = key()
    gate.resolve(result)
    expect(await Promise.all(pending)).toEqual([result, result])
    expect(await load(expiry)).toBe(result)
    expect(calls).toBe(1)
  })

  test("refreshes near expiry and recovers from a failed refresh", async () => {
    let calls = 0
    const load = delegationKeyCache(async () => {
      calls++
      if (calls === 1) throw new Error("RBAC unavailable")
      return key(calls === 2 ? new Date(Date.now() + 60_000) : undefined)
    })
    const expiry = new Date(Date.now() + 60_000)
    await expect(load(expiry)).rejects.toThrow("RBAC unavailable")
    await load(expiry)
    await load(expiry)
    expect(calls).toBe(3)
  })

  test("generates blob-scoped HTTPS user-delegation SAS with create/write permissions", async () => {
    const credential = {
      async getToken() {
        return { token: "unused", expiresOnTimestamp: Date.now() + 60_000 }
      },
    }
    const service = new BlobServiceClient("https://sixbtest.blob.core.windows.net", credential)
    const delegation = key()
    const sign = uploadSigner({
      credential,
      async getUserDelegationKey() {
        return delegation
      },
    })
    const expiry = new Date(Date.now() + 60_000)
    const blob = service.getContainerClient("files").getBlockBlobClient("sixb/uploads/id/object")
    const url = new URL(await sign(blob, expiry))
    expect(url.pathname).toBe("/files/sixb/uploads/id/object")
    expect(url.searchParams.get("sp")).toBe("cw")
    expect(url.searchParams.get("sr")).toBe("b")
    expect(url.searchParams.get("spr")).toBe("https")
    expect(url.searchParams.get("skoid")).toBe(delegation.signedObjectId)
    expect(new Date(url.searchParams.get("se")!).getTime()).toBeLessThanOrEqual(expiry.getTime())
    expect(url.searchParams.get("sig")).toBeTruthy()
  })
})
