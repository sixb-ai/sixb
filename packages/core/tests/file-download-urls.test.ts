import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import { type FileRef, InMemoryBroker, InMemoryStorage, SixbHost } from "../src"
import { InMemoryBlobStorage } from "../src/blob-storage"
import { resolveFileDownload } from "../src/blob-storage/download-urls"
import { DomainEventService, OntologyOutboxDispatcher } from "../src/events"
import { OntologyMaintenance } from "../src/maintenance"
import { setApiPublicOrigin } from "../src/runtime/public-origin"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const origin = "https://api.example.com"
const hour = 60 * 60 * 1000

afterEach(() => {
  setSystemTime()
})

function createHost(options: { readonly id?: string; readonly origin?: string | null } = {}) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: options.id ?? "project-a", ontology: [], ...deps })
  if (options.origin !== null) setApiPublicOrigin(host, options.origin ?? origin)
  return { host, sixb: createTestSixb(host), storage: deps.storage }
}

async function storedPhoto(sixb: ReturnType<typeof createHost>["sixb"]): Promise<FileRef> {
  return sixb.blobs.put({
    body: new TextEncoder().encode("jpeg bytes"),
    fileName: "photo.jpg",
    mediaType: "image/jpeg",
    logicalPath: "campaigns/q4/photo.jpg",
  })
}

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1)
}

describe("blobs.createDownloadUrl", () => {
  test("issues a URL that serves the file until it expires", async () => {
    const { host, sixb } = createHost()
    const photo = await storedPhoto(sixb)
    setSystemTime(new Date("2026-10-05T12:00:00.000Z"))

    const { url, expiresAt } = await sixb.blobs.createDownloadUrl(photo)

    expect(url.startsWith(`${origin}/api/files/downloads/`)).toBe(true)
    expect(expiresAt).toEqual(new Date("2026-10-05T13:00:00.000Z"))
    const { logicalPath: _logicalPath, ...served } = photo
    setSystemTime(new Date(expiresAt.getTime() - 1))
    expect(await resolveFileDownload(host, tokenOf(url))).toEqual(served)
    setSystemTime(expiresAt)
    expect(await resolveFileDownload(host, tokenOf(url))).toBeNull()
  })

  test("stores which execution issued the URL, and the token only as a hash", async () => {
    const { sixb, storage } = createHost()
    const { id, url } = await sixb.blobs.createDownloadUrl(await storedPhoto(sixb))
    const tokenHash = createHash("sha256").update(tokenOf(url)).digest("hex")

    const grant = await storage.fileDownloadGrants.findByTokenHash({
      projectId: "project-a",
      tokenHash,
    })

    expect(grant).toMatchObject({ id, executionId: sixb.execution.id })
  })

  test("issues independent URLs for the same file", async () => {
    const { host, sixb } = createHost()
    const photo = await storedPhoto(sixb)
    const first = await sixb.blobs.createDownloadUrl(photo)
    const second = await sixb.blobs.createDownloadUrl(photo)

    await sixb.blobs.revokeDownloadUrl(first.id)

    expect(second.url).not.toBe(first.url)
    expect(await resolveFileDownload(host, tokenOf(first.url))).toBeNull()
    expect(await resolveFileDownload(host, tokenOf(second.url))).not.toBeNull()
  })

  test("honors any requested lifetime that ends before the year 10000", async () => {
    const { sixb } = createHost()
    const photo = await storedPhoto(sixb)
    setSystemTime(new Date("2026-10-05T12:00:00.000Z"))
    const year = 365 * 24 * hour

    const { expiresAt } = await sixb.blobs.createDownloadUrl(photo, { expiresInMs: year })

    expect(expiresAt).toEqual(new Date("2027-10-05T12:00:00.000Z"))
    for (const expiresInMs of [0, -1, 1.5, Number.NaN]) {
      await expect(
        sixb.blobs.createDownloadUrl(photo, { expiresInMs }),
        `${expiresInMs}`
      ).rejects.toThrow("expiresInMs must be a positive integer")
    }
    await expect(
      sixb.blobs.createDownloadUrl(photo, { expiresInMs: 8_000 * year })
    ).rejects.toThrow("before the year 10000")
  })

  test("names the missing public origin", async () => {
    const { sixb } = createHost({ origin: null })
    const photo = await storedPhoto(sixb)

    await expect(sixb.blobs.createDownloadUrl(photo)).rejects.toThrow("SIXB_API_PUBLIC_ORIGIN")
  })

  test("refuses a reference no stored blob matches", async () => {
    const { sixb } = createHost()
    const photo = await storedPhoto(sixb)
    const missingDigest = "0".repeat(64)
    const missing: FileRef = {
      blobId: `blob_${missingDigest}`,
      digest: `sha256:${missingDigest}`,
      sizeBytes: 1,
    }

    for (const file of [missing, { ...photo, sizeBytes: photo.sizeBytes + 1 }]) {
      await expect(sixb.blobs.createDownloadUrl(file)).rejects.toThrow("No stored blob matches")
    }
    await expect(
      sixb.blobs.createDownloadUrl({ ...photo, blobId: `blob_${missingDigest}` })
    ).rejects.toThrow("requires a valid file reference")
  })
})

describe("blobs.revokeDownloadUrl", () => {
  test("stops a URL before it expires", async () => {
    const { host, sixb } = createHost()
    const { id, url } = await sixb.blobs.createDownloadUrl(await storedPhoto(sixb))

    await sixb.blobs.revokeDownloadUrl(id)
    await sixb.blobs.revokeDownloadUrl(id)

    expect(await resolveFileDownload(host, tokenOf(url))).toBeNull()
  })

  test("refuses an id it never issued", async () => {
    const { sixb } = createHost()

    await expect(sixb.blobs.revokeDownloadUrl("filedownload_unknown")).rejects.toThrow(
      "does not exist"
    )
  })
})

describe("resolveFileDownload", () => {
  test("rejects a malformed token and a token of another project", async () => {
    const { host, sixb, storage } = createHost()
    const { url } = await sixb.blobs.createDownloadUrl(await storedPhoto(sixb))
    const token = tokenOf(url)

    expect(await resolveFileDownload(host, `${token}x`)).toBeNull()
    expect(await resolveFileDownload(host, "")).toBeNull()
    expect(await resolveFileDownload({ id: "project-b", storage }, token)).toBeNull()
  })
})

describe("setApiPublicOrigin", () => {
  test("keeps the latest origin, normalized", async () => {
    const { host, sixb } = createHost()
    const photo = await storedPhoto(sixb)

    setApiPublicOrigin(host, "https://other.example.com/")

    expect((await sixb.blobs.createDownloadUrl(photo)).url).toStartWith(
      "https://other.example.com/api/files/downloads/"
    )
  })

  test("accepts only an http or https origin", () => {
    const { host } = createHost({ origin: null })
    const invalid = [
      ["api.example.com", "Invalid API public origin"],
      ["ftp://api.example.com", "must use http or https"],
      ["https://api.example.com/v1", "must be an origin"],
    ] as const
    for (const [value, message] of invalid) {
      expect(() => setApiPublicOrigin(host, value)).toThrow(message)
    }
  })
})

describe("expired download grants", () => {
  test("stay a week for audit, then a maintenance pass deletes them", async () => {
    const storage = new InMemoryStorage()
    const events = new DomainEventService({ projectId: "project", broker: new InMemoryBroker() })
    const maintenance = new OntologyMaintenance({
      projectId: "project",
      storage,
      dispatcher: new OntologyOutboxDispatcher({ projectId: "project", storage, events }),
      blobStorage: new InMemoryBlobStorage(),
      options: { intervalMs: 60_000 },
      onError: () => {},
    })
    const now = Date.now()
    const grant = (id: string, expiredAgoMs: number) =>
      storage.fileDownloadGrants.create({
        id,
        projectId: "project",
        tokenHash: id.padEnd(64, "0"),
        file: {
          blobId: `blob_${"c".repeat(64)}`,
          digest: `sha256:${"c".repeat(64)}`,
          sizeBytes: 1,
        },
        executionId: "execution-1",
        createdAt: new Date(now - expiredAgoMs - hour),
        expiresAt: new Date(now - expiredAgoMs),
      })
    await grant("a", 8 * 24 * hour)
    await grant("b", 6 * 24 * hour)

    await maintenance.runNow()

    const remaining = await Promise.all(
      ["a", "b"].map((id) =>
        storage.fileDownloadGrants.findByTokenHash({
          projectId: "project",
          tokenHash: id.padEnd(64, "0"),
        })
      )
    )
    expect(remaining.map((record) => record?.id ?? null)).toEqual([null, "b"])
  })
})
