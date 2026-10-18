import { describe, expect, test } from "bun:test"
import { SixbApiError } from "@sixb/client"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { artifactPanelPresentation } from "../src/agent/artifact-panel-state"
import {
  artifactFileSource,
  type FileSource,
  messageFileSource,
  useFileName,
} from "../src/artifacts/file-source"
import { fileLoadError } from "../src/artifacts/file-view"

function FileName({ source }: { readonly source: FileSource }) {
  return useFileName(source)
}

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

  test("name a message file that has no name of its own in the reader's language", () => {
    // Reproduce by naming the source in English where it is made, as `en.files.file` did: the
    // French reader sees "File".
    const { fileName: _fileName, ...unnamed } = fileRef
    const source = messageFileSource({
      threadId: "thread",
      messageId: "message",
      path: "/parts/0/fileRef",
      fileRef: unnamed,
    })
    expect(source.name).toBe("")
    const name = (locale: string) =>
      renderToStaticMarkup(
        createElement(LocaleProvider, { locale }, createElement(FileName, { source }))
      )
    expect(name("en")).toBe("File")
    expect(name("fr")).toBe("Fichier")
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
  // Beside a full-page conversation, or a compact one whose host asks for a split, it is a panel;
  // beside the dock it is a canvas; on a phone, or in a compact conversation, a dialog.
  test.each([
    [{}, "panel"],
    [{ isMobile: true }, "dialog"],
    [{ compact: true }, "dialog"],
    [{ compact: true, split: true }, "panel"],
    [{ compact: true, split: true, isMobile: true }, "dialog"],
    [{ compact: true, hasCanvas: true }, "canvas"],
    [{ compact: true, hasCanvas: true, isMobile: true }, "dialog"],
    [{ hasCanvas: true }, "panel"],
  ] as const)("%o opens as a %s", (input, expected) => {
    expect(
      artifactPanelPresentation({
        compact: false,
        isMobile: false,
        hasCanvas: false,
        split: false,
        ...input,
      })
    ).toBe(expected)
  })
})
