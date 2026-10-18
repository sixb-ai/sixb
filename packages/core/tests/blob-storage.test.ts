import { describe, expect, test } from "bun:test"
import type { FileRef } from "../src"
import { fileNameFor, InMemoryBlobStorage, isFileRef } from "../src"
import { BlobStorageError } from "../src/blob-storage"
import {
  canonicalMediaType,
  inferFileMediaType,
  sniffFileMediaType,
} from "../src/blob-storage/media-type"
import { isValidFileRef } from "../src/blob-storage/validation"

const encoder = new TextEncoder()

const hex = "a".repeat(64)
const validFileRef: FileRef = {
  blobId: `blob_${hex}`,
  digest: `sha256:${hex}`,
  sizeBytes: 3,
}

describe("InMemoryBlobStorage", () => {
  test("keeps one blob per content, whatever the body, and serves it by id, range, and stat", async () => {
    const store = new InMemoryBlobStorage()

    const first = await store.put({
      body: encoder.encode("range bytes"),
      fileName: "first.txt",
    })
    const second = await store.put({
      body: new Blob(["range bytes"]),
      fileName: "second.txt",
    })

    expect(second.blobId).toBe(first.blobId)
    expect(second.digest).toBe(first.digest)
    expect(first.fileName).toBe("first.txt")
    expect(second.fileName).toBe("second.txt")
    const range = await store.openRange(first.blobId, { start: 6, endInclusive: 10 })
    expect(await new Response(range).text()).toBe("bytes")
    await expect(store.stat(first.blobId)).resolves.toEqual({
      blobId: first.blobId,
      digest: first.digest,
      sizeBytes: 11,
    })
  })

  test("unknown blob ids return null from stat and throw from open", async () => {
    const store = new InMemoryBlobStorage()

    await expect(store.stat("blob_missing")).resolves.toBeNull()
    await expect(store.open("blob_missing")).rejects.toBeInstanceOf(BlobStorageError)
    await expect(store.open("blob_missing")).rejects.toThrow("Unknown blob 'blob_missing'")
  })
})

describe("isFileRef", () => {
  test("accepts content-addressed references and rejects forged or malformed ones", async () => {
    const produced = await new InMemoryBlobStorage().put({ body: encoder.encode("abc") })
    for (const valid of [validFileRef, produced]) expect(isFileRef(valid)).toBe(true)

    for (const invalid of [
      // The blobId must derive from the digest.
      { ...validFileRef, blobId: `blob_${"b".repeat(64)}` },
      { ...validFileRef, digest: "md5:abc" },
      { ...validFileRef, sizeBytes: -1 },
      { ...validFileRef, sizeBytes: 1.5 },
      { ...validFileRef, fileName: 123 },
      null,
    ]) {
      expect(isFileRef(invalid), JSON.stringify(invalid)).toBe(false)
    }
  })

  // Stored references keep loading whatever their media type; only writes use isValidFileRef.
  // Regression proof: require a valid media type in isFileRef; the listed type then fails here.
  test("accepts any string mediaType, which isValidFileRef narrows to one media type", () => {
    expect(isFileRef({ ...validFileRef, mediaType: 42 })).toBe(false)
    for (const mediaType of ["image/png", "Text/Plain; Charset=UTF-8"]) {
      expect(isFileRef({ ...validFileRef, mediaType }), mediaType).toBe(true)
      expect(isValidFileRef({ ...validFileRef, mediaType }), mediaType).toBe(true)
    }
    for (const mediaType of ["image/png,text/html", "image/png text/html", ""]) {
      expect(isFileRef({ ...validFileRef, mediaType }), mediaType).toBe(true)
      expect(isValidFileRef({ ...validFileRef, mediaType }), mediaType).toBe(false)
    }
    expect(isValidFileRef(validFileRef)).toBe(true)
    expect(isValidFileRef({ ...validFileRef, sizeBytes: -1 })).toBe(false)
  })
})

describe("canonicalMediaType", () => {
  test("lowercases type, subtype, and parameter names, and keeps parameter values", () => {
    for (const [value, canonical] of [
      ["image/png", "image/png"],
      ["IMAGE/PNG", "image/png"],
      ["Text/Plain; Charset=UTF-8", "text/plain;charset=UTF-8"],
      ["text/plain;charset=utf-8;format=flowed", "text/plain;charset=utf-8;format=flowed"],
      ['text/plain; charset="utf-8"', 'text/plain;charset="utf-8"'],
      [
        'application/octet-stream; name="Q3 report.pdf"',
        'application/octet-stream;name="Q3 report.pdf"',
      ],
      ["application/vnd.ms-excel", "application/vnd.ms-excel"],
      ["application/ld+json", "application/ld+json"],
    ]) {
      expect(canonicalMediaType(value), value).toBe(canonical)
    }
  })

  test("rejects lists and anything else that is not one well-formed media type", () => {
    for (const value of [
      // A browser reads a list as its last type.
      "image/png,text/html",
      "image/png, text/html",
      "image/png;charset=utf-8,text/html",
      'text/plain;name="a,b"',
      "image/png,",
      "",
      "image",
      "image/",
      "/png",
      "image/png/x",
      " image/png",
      "image/png ",
      "image /png",
      "image/png;",
      "image/png;charset",
      "image/png;charset=",
      "image/png; charset = utf-8",
      'text/plain;charset="utf-8',
      'text/plain;name="a\\"b"',
      "image/pñg",
      "image/png\r\nx-injected: 1",
      "text/(html)",
      undefined,
      42,
    ]) {
      expect(canonicalMediaType(value), String(value)).toBeNull()
    }
  })
})

describe("inferFileMediaType", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const pdf = new TextEncoder().encode("%PDF-1.7\n")

  test("trusts a known signature, then the extension in any case, then octet-stream", () => {
    for (const [fileName, bytes, mediaType] of [
      ["report.MD", undefined, "text/markdown"],
      ["data.tsv", undefined, "text/tab-separated-values"],
      [
        "deck.pptx",
        undefined,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ],
      ["archive.tar.zip", undefined, "application/zip"],
      ["chart.txt", png, "image/png"],
      ["scan.bin", pdf, "application/pdf"],
      ["README", undefined, "application/octet-stream"],
      ["notes.unknown", new TextEncoder().encode("plain"), "application/octet-stream"],
    ] as const) {
      expect(inferFileMediaType(fileName, bytes), fileName).toBe(mediaType)
    }
  })

  test("recognizes only unambiguous signatures", () => {
    expect(sniffFileMediaType(png)).toBe("image/png")
    expect(sniffFileMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(sniffFileMediaType(new TextEncoder().encode("GIF89a"))).toBe("image/gif")
    expect(sniffFileMediaType(new TextEncoder().encode("RIFF\0\0\0\0WEBP"))).toBe("image/webp")
    expect(sniffFileMediaType(new TextEncoder().encode("<svg></svg>"))).toBeUndefined()
    expect(sniffFileMediaType(new Uint8Array())).toBeUndefined()
  })
})

describe("fileNameFor", () => {
  test("prefers the fileName tail, then the logicalPath tail, then a synthetic name", () => {
    expect(fileNameFor({ ...validFileRef, fileName: "dir/report.pdf" })).toBe("report.pdf")
    expect(fileNameFor({ ...validFileRef, logicalPath: "a/b/c.txt" })).toBe("c.txt")
    expect(fileNameFor(validFileRef)).toBe(`blob_${hex}.bin`)
  })
})
