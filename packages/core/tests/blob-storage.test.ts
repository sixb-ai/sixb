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

  // The first bytes of files FFmpeg wrote, except the Theora stream, which the encoder this was
  // made with lacks: its first packet is written by hand.
  const media = {
    mp4: bytes("000000206674797069736f6d0000020069736f6d69736f32617663316d703431"),
    mov: bytes("00000014667479707174202000000200717420200000000877696465000004ef"),
    m4a: bytes("0000001c667479704d344120000002004d34412069736f6d69736f3200000008"),
    webm: bytes("1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878102"),
    mkv: bytes("1a45dfa3a34286810142f7810142f2810442f381084282886d6174726f736b61"),
    mp3: bytes("49443304000000000022545353450000000e0000034c61766636332e312e3130"),
    mp3WithoutTag: bytes("fffb50c400000a2c432e55948001811566233ad00007aac38e3385d364f1a1c1"),
    aac: bytes("fff1504020fffcdc004c61766336332e312e313031000260ac5ba9507226a578"),
    wav: bytes("524946462e45000057415645666d7420100000000100010044ac000088580100"),
    flac: bytes("664c614300000022040004000001210001840ac440f000002274b4f27f6fef49"),
    opus: bytes("4f676753000200000000000000005bca460c00000000280d469501134f707573486561640101"),
    theora: bytes(`4f6767530002${"00".repeat(20)}01${Buffer.from("\x80theora").toString("hex")}`),
  }

  test("recognizes video and audio containers by their signature", () => {
    expect(sniffFileMediaType(media.mp4)).toBe("video/mp4")
    expect(sniffFileMediaType(media.mov)).toBe("video/quicktime")
    expect(sniffFileMediaType(media.m4a)).toBe("audio/mp4")
    expect(sniffFileMediaType(media.webm)).toBe("video/webm")
    expect(sniffFileMediaType(media.mkv)).toBe("video/x-matroska")
    expect(sniffFileMediaType(media.mp3)).toBe("audio/mpeg")
    expect(sniffFileMediaType(media.mp3WithoutTag)).toBe("audio/mpeg")
    expect(sniffFileMediaType(media.aac)).toBe("audio/aac")
    expect(sniffFileMediaType(media.wav)).toBe("audio/wav")
    expect(sniffFileMediaType(media.flac)).toBe("audio/flac")
    expect(sniffFileMediaType(media.opus)).toBe("audio/ogg")
    expect(sniffFileMediaType(media.theora)).toBe("video/ogg")
  })

  // Reproduce by answering `video/mp4` for any `ftyp` box, or `audio/mpeg` for the sync bits alone.
  test("leaves look-alike media signatures to the name", () => {
    // An AVIF image is an ISO media file too; only its brand tells it from a video.
    const avif = bytes("0000001c6674797061766966000000006176696600000000")
    // Reserved bitrate and sampling rate: the sync bits alone are not an MP3.
    const notMp3 = bytes("fffbfc00")
    // An EBML file that is neither WebM nor Matroska.
    const otherEbml = bytes("1a45dfa39f42828465626d6c")

    for (const unknown of [avif, notMp3, otherEbml]) {
      expect(sniffFileMediaType(unknown)).toBeUndefined()
    }
    expect(inferFileMediaType("photo.avif", avif)).toBe("application/octet-stream")
  })

  // Reproduce by accepting any MPEG audio layer in mpegAudioMediaType: the byte order mark `FF FE`
  // reads as a layer I header, and each of these files as `audio/mpeg`.
  test("leaves UTF-16 text, whose byte order mark looks like an MP3 frame, to the name", () => {
    for (const [fileName, text, mediaType] of [
      ["export.csv", "id,city\n", "text/csv"],
      ["notes.txt", "Draft\n", "text/plain"],
      ["data.json", '{"a":1}', "application/json"],
    ] as const) {
      const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from(text, "utf16le")])
      expect(sniffFileMediaType(utf16), fileName).toBeUndefined()
      expect(inferFileMediaType(fileName, utf16), fileName).toBe(mediaType)
    }
  })

  test("names captions and media by their extension, and lets it say a container holds sound", () => {
    for (const [fileName, content, mediaType] of [
      ["intro.MP4", undefined, "video/mp4"],
      ["intro.mov", undefined, "video/quicktime"],
      ["episode.mp3", undefined, "audio/mpeg"],
      ["captions.vtt", undefined, "text/vtt"],
      ["captions.srt", undefined, "application/x-subrip"],
      // A signature wins over a name that disagrees about the format.
      ["clip.mp3", media.mp4, "video/mp4"],
      // Only the name can tell a WebM or an MP4 holding sound alone. Reproduce by returning the
      // sniffed type first in inferFileMediaType: both read as video.
      ["voice.weba", media.webm, "audio/webm"],
      ["voice.m4a", media.mp4, "audio/mp4"],
      ["voice.webm", media.webm, "video/webm"],
    ] as const) {
      expect(inferFileMediaType(fileName, content), fileName).toBe(mediaType)
    }
  })
})

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"))
}

describe("fileNameFor", () => {
  test("prefers the fileName tail, then the logicalPath tail, then a synthetic name", () => {
    expect(fileNameFor({ ...validFileRef, fileName: "dir/report.pdf" })).toBe("report.pdf")
    expect(fileNameFor({ ...validFileRef, logicalPath: "a/b/c.txt" })).toBe("c.txt")
    expect(fileNameFor(validFileRef)).toBe(`blob_${hex}.bin`)
  })
})
