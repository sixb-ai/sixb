import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core"
import { createSixbClient, objectFileContentUrl, client as sharedClient } from "../src"

const fileRef: FileRef = {
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 12,
  fileName: "logo, final.png",
  mediaType: "image/png",
}
const input = {
  objectTypeId: "document type",
  objectId: "doc/1",
  pathSegments: ["attachments", "a/b", "tilde~name"],
  fileRef,
}

describe("objectFileContentUrl", () => {
  test("defaults to the shared client configuration", () => {
    const config = sharedClient.getConfig()
    try {
      sharedClient.setConfig({ baseUrl: "https://shared.test" })
      expect(objectFileContentUrl(input).startsWith("https://shared.test/api/objects/")).toBe(true)
    } finally {
      sharedClient.setConfig(config)
    }
  })

  test("uses the client base path and encodes object IDs and JSON pointers", () => {
    const client = createSixbClient({ baseUrl: "https://sixb.test/prefix/api" })
    const url = new URL(objectFileContentUrl({ ...input, client, disposition: "attachment" }))
    expect(url.origin).toBe("https://sixb.test")
    expect(url.pathname).toBe("/prefix/api/objects/document%20type/doc%2F1/files/content")
    expect(url.searchParams.get("path")).toBe("/properties/attachments/a~1b/tilde~0name")
    expect(url.searchParams.get("disposition")).toBe("attachment")
    // Elysia 1.4 parses comma-delimited query values into arrays before validation.
    // Replacing the scalar key with JSON.stringify([...]) reproduces a route 422.
    expect(url.searchParams.get("v")).not.toContain(",")
  })

  // Regression for #527: removing `v` from the helper must fail the replacement assertions.
  test("keeps identical references stable and changes the URL for content or metadata edits", () => {
    const client = createSixbClient()
    const original = objectFileContentUrl({ ...input, client })
    expect(original.startsWith("/api/objects/")).toBe(true)
    expect(objectFileContentUrl({ ...input, client, fileRef: { ...fileRef } })).toBe(original)
    for (const replacement of [
      { ...fileRef, digest: `sha256:${"b".repeat(64)}` as const, blobId: `blob_${"b".repeat(64)}` },
      { ...fileRef, fileName: "new-name.png" },
      { ...fileRef, mediaType: "image/jpeg" },
      { ...fileRef, logicalPath: "images/logo.png" },
    ]) {
      expect(objectFileContentUrl({ ...input, client, fileRef: replacement })).not.toBe(original)
    }
  })

  test("supports relative deployment prefixes and rejects missing context", () => {
    const client = createSixbClient({ baseUrl: "/prefix/api" })
    expect(objectFileContentUrl({ ...input, client }).startsWith("/prefix/api/objects/")).toBe(true)
    for (const invalid of [{ objectId: "" }, { objectTypeId: "" }, { pathSegments: [] }]) {
      expect(() => objectFileContentUrl({ ...input, ...invalid })).toThrow("[SixbClient]")
    }
  })
})
