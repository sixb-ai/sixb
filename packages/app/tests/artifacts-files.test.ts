import { describe, expect, test } from "bun:test"
import { SixbApiError } from "@sixb/client"
import { artifactPanelPresentation } from "../src/agent/artifact-panel-state"
import { artifactFileSource, messageFileSource } from "../src/artifacts/file-source"
import { fileLoadError } from "../src/artifacts/file-view"

const fileRef = {
  blobId: "blob",
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 128,
  fileName: "report.md",
  mediaType: "text/markdown",
}

describe("file sources", () => {
  test("read a message file through its message", () => {
    const source = messageFileSource({
      threadId: "thread/1",
      messageId: "message 1",
      path: "/parts/2/fileRef",
      fileRef,
      baseUrl: "https://example.test",
    })

    expect(source.name).toBe("report.md")
    expect(source.inlineUrl).toBe(
      "https://example.test/api/agent-threads/thread%2F1/messages/message%201/files/content?path=%2Fparts%2F2%2FfileRef&disposition=inline"
    )
    expect(source.downloadUrl).toContain("disposition=attachment")
  })

  test("name a message file that has no name of its own", () => {
    const { fileName: _fileName, ...unnamed } = fileRef
    const input = { threadId: "thread", messageId: "message", path: "/parts/0/fileRef" }
    expect(messageFileSource({ ...input, fileRef: unnamed }).name).toBe("File")
    expect(messageFileSource({ ...input, fileRef: unnamed, fallbackName: "Fichier" }).name).toBe(
      "Fichier"
    )
  })

  test("read an artifact file through its version", () => {
    const source = artifactFileSource({
      artifactId: "art_0123456789",
      version: 3,
      path: "figures/revenue chart.png",
      fileRef,
      baseUrl: "https://example.test",
    })

    expect(source.id).toBe("artifact:art_0123456789@3/figures/revenue chart.png")
    expect(source.name).toBe("figures/revenue chart.png")
    expect(source.inlineUrl).toBe(
      "https://example.test/api/artifacts/art_0123456789/versions/3/content?path=figures%2Frevenue+chart.png&disposition=inline"
    )
  })

  test("name why a file could not load in the reader's words, not the API's", () => {
    expect(fileLoadError(new SixbApiError("missing", { status: 404 }))).toBe("gone")
    expect(fileLoadError(new SixbApiError("missing storage", { status: 501 }))).toBe(
      "storageUnavailable"
    )
    expect(fileLoadError(new Error("network details"))).toBe("loadFailed")
  })
})

describe("artifact panel presentation", () => {
  const presentation = (
    input: Partial<Parameters<typeof artifactPanelPresentation>[0]>
  ): ReturnType<typeof artifactPanelPresentation> =>
    artifactPanelPresentation({
      compact: false,
      isMobile: false,
      hasCanvas: false,
      split: false,
      ...input,
    })

  test("sits beside the full-page conversation and opens as a dialog on a phone", () => {
    expect(presentation({})).toBe("panel")
    expect(presentation({ isMobile: true })).toBe("dialog")
    expect(presentation({ compact: true })).toBe("dialog")
  })

  test("keeps a compact conversation and artifact side by side when the host asks", () => {
    expect(presentation({ compact: true, split: true })).toBe("panel")
    expect(presentation({ compact: true, split: true, isMobile: true })).toBe("dialog")
  })

  test("opens as a canvas beside the dock without changing phones", () => {
    expect(presentation({ compact: true, hasCanvas: true })).toBe("canvas")
    expect(presentation({ compact: true, hasCanvas: true, isMobile: true })).toBe("dialog")
    expect(presentation({ hasCanvas: true })).toBe("panel")
  })
})
