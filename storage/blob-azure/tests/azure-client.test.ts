import { describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import { DefaultAzureCredential } from "@azure/identity"
import { AzureBlobStorage } from "../src"
import { azureErrorCode, createAzureClient, webStream } from "../src/azure-client"

describe("Azure client configuration", () => {
  test("requires unambiguous authentication before accepting an upload", () => {
    const base = { container: "files" }
    expect(() => new AzureBlobStorage(base)).toThrow("exactly one")
    expect(
      () =>
        new AzureBlobStorage({
          ...base,
          accountName: "validaccount",
          serviceUrl: "https://example.com",
        })
    ).toThrow("exactly one")
    expect(
      () =>
        new AzureBlobStorage({
          ...base,
          connectionString: "UseDevelopmentStorage=true",
          accountName: "validaccount",
        })
    ).toThrow("cannot be combined")
    expect(
      () =>
        new AzureBlobStorage({
          ...base,
          connectionString: "BlobEndpoint=https://example.com;SharedAccessSignature=sv=test",
        })
    ).toThrow("account key")
    expect(() => new AzureBlobStorage({ ...base, accountName: "invalid/account" })).toThrow(
      "accountName"
    )
    expect(() => new AzureBlobStorage({ ...base, serviceUrl: "http://example.com" })).toThrow(
      "HTTPS"
    )
    expect(
      () => new AzureBlobStorage({ ...base, accountName: "validaccount", concurrency: 0 })
    ).toThrow("concurrency")
    expect(
      () => new AzureBlobStorage({ ...base, accountName: "validaccount", blockSizeBytes: 0 })
    ).toThrow("blockSizeBytes")
  })

  test("uses default credentials lazily", () => {
    const client = createAzureClient({ container: "files", accountName: "validaccount" }, 0)
    expect(client.container.url).toBe("https://validaccount.blob.core.windows.net/files")
    expect(client.container.credential).toBeInstanceOf(DefaultAzureCredential)
  })

  test("uses an explicit credential for private copy-source authorization", async () => {
    const scopes: Array<string | string[]> = []
    const credential = {
      async getToken(scope: string | string[]) {
        scopes.push(scope)
        return { token: "test-token", expiresOnTimestamp: Date.now() + 60_000 }
      },
    }
    const client = createAzureClient(
      { container: "files", accountName: "validaccount", credential },
      0
    )
    const blob = client.container.getBlockBlobClient("staging")
    expect(client.container.credential).toBe(credential)
    expect(await client.copySource(blob)).toEqual({
      url: blob.url,
      sourceAuthorization: { scheme: "Bearer", value: "test-token" },
    })
    expect(scopes).toEqual(["https://storage.azure.com/.default"])
  })

  test("shared-key copy-source URLs grant read access only", async () => {
    const client = createAzureClient(
      { container: "files", connectionString: "UseDevelopmentStorage=true" },
      0
    )
    const source = await client.copySource(client.container.getBlockBlobClient("private/staging"))
    const url = new URL(source.url)
    expect(url.searchParams.get("sp")).toBe("r")
    expect(url.searchParams.get("sr")).toBe("b")
    expect(url.searchParams.has("sig")).toBe(true)
  })

  test("copy-source SAS includes a bounded validity window for expiration policies", async () => {
    // Regression: removing startsOn in copySource fails this test. Azure accounts
    // enforcing SAS expiration policies reject signatures without a signed start.
    const client = createAzureClient(
      { container: "files", connectionString: "UseDevelopmentStorage=true" },
      0
    )
    const before = Date.now()
    const source = await client.copySource(client.container.getBlockBlobClient("private/staging"))
    const after = Date.now()
    const params = new URL(source.url).searchParams
    expect(params.has("st")).toBe(true)
    const start = Date.parse(params.get("st")!)
    const end = Date.parse(params.get("se")!)
    // Azure serializes timestamps to whole seconds.
    expect(start).toBeGreaterThanOrEqual(before - 5 * 60_000 - 1000)
    expect(start).toBeLessThanOrEqual(after - 5 * 60_000)
    expect(end - start).toBe(65 * 60_000)
  })

  test("extracts Azure codes without conflating all 404s", () => {
    expect(azureErrorCode({ statusCode: 404 })).toBeUndefined()
    expect(azureErrorCode({ code: "BlobNotFound" })).toBe("BlobNotFound")
    expect(azureErrorCode({ code: "RestError", details: { errorCode: "ContainerNotFound" } })).toBe(
      "ContainerNotFound"
    )
  })
})

describe("Azure download stream bridge", () => {
  test("streams bytes and closes the underlying response on cancellation", async () => {
    let destroyed = false
    const source = new Readable({
      read() {
        this.push(Buffer.from("bytes"))
      },
      destroy(error, callback) {
        destroyed = true
        callback(error)
      },
    })
    const reader = webStream(source).getReader()
    expect((await reader.read()).value).toEqual(new TextEncoder().encode("bytes"))
    await reader.cancel()
    expect(destroyed).toBe(true)
  })

  test("propagates a mid-stream response failure", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("download failed"))
      },
    })
    await expect(new Response(webStream(source)).bytes()).rejects.toThrow("download failed")
  })
})
