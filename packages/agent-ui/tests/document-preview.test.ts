import { describe, expect, test } from "bun:test"
import { SixbApiError } from "@sixb/client"
import { agentDocumentKind } from "../src/document-preview/classify"
import {
  documentLoadError,
  MAX_MARKDOWN_PREVIEW_BYTES,
  markdownPreviewTooLarge,
} from "../src/document-preview/content"
import {
  DelimitedTextParseError,
  MAX_DELIMITED_PREVIEW_COLUMNS,
  MAX_DELIMITED_PREVIEW_ROWS,
  parseDelimitedText,
} from "../src/document-preview/delimited"
import { buildSafeHtmlPreviewDocument, HTML_PREVIEW_SANDBOX } from "../src/document-preview/html"
import { documentPreviewPresentation } from "../src/document-preview/presentation"
import { agentDocumentPreviewRenderer } from "../src/document-preview/rendering"
import { createAgentDocumentSource } from "../src/document-preview/source"
import {
  documentPreviewReducer,
  documentTabIdAfterKey,
  EMPTY_DOCUMENT_PREVIEW_STATE,
} from "../src/document-preview/state"
import type { AgentDocumentSource } from "../src/document-preview/types"
import type { AgentFileRef } from "../src/types"

const MARKDOWN_FILE: AgentFileRef = {
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 128,
  fileName: "report.md",
  mediaType: "text/markdown",
}

describe("agent document classification", () => {
  test("recognizes supported MIME types and ignores parameters", () => {
    expect(agentDocumentKind("text/markdown; charset=utf-8", "report.bin")).toBe("markdown")
    expect(agentDocumentKind("text/html", "page.bin")).toBe("html")
    expect(agentDocumentKind("text/csv", "rows.bin")).toBe("csv")
    expect(agentDocumentKind("text/tab-separated-values", "rows.bin")).toBe("tsv")
    expect(agentDocumentKind("application/pdf", "report.bin")).toBe("pdf")
  })

  test("uses extensions only for missing or generic media metadata", () => {
    expect(agentDocumentKind(undefined, "REPORT.MD")).toBe("markdown")
    expect(agentDocumentKind("application/octet-stream", "report.pdf")).toBe("pdf")
    expect(agentDocumentKind("image/png", "not-really.md")).toBeNull()
    expect(agentDocumentKind(undefined, "workbook.xlsx")).toBeNull()
  })
})

describe("agent document source", () => {
  test("builds contextual inline and attachment URLs", () => {
    const source = createAgentDocumentSource({
      threadId: "thread/1",
      messageId: "message 1",
      partIndex: 2,
      fileRef: MARKDOWN_FILE,
      baseUrl: "https://example.test",
    })

    expect(source.kind).toBe("markdown")
    expect(source.id).toBe(MARKDOWN_FILE.blobId)
    expect(source.inlineUrl).toBe(
      "https://example.test/api/agent-threads/thread%2F1/messages/message%201/files/content?path=%2Fparts%2F2%2FfileRef&disposition=inline"
    )
    expect(source.downloadUrl).toContain("disposition=attachment")
  })

  test("keeps a source for unsupported files so browser fallback remains available", () => {
    const source = createAgentDocumentSource({
      threadId: "thread-1",
      messageId: "message-1",
      partIndex: 0,
      fileRef: { ...MARKDOWN_FILE, fileName: "archive.zip", mediaType: "application/zip" },
      baseUrl: "https://example.test",
    })

    expect(source.kind).toBeNull()
    expect(source.inlineUrl).toContain("disposition=inline")
  })
})

describe("document preview rendering", () => {
  test("uses the native browser path for PDFs without selecting the text loader", () => {
    expect(agentDocumentPreviewRenderer("markdown")).toBe("markdown")
    expect(agentDocumentPreviewRenderer("pdf")).toBe("pdf-native")
    expect(agentDocumentPreviewRenderer("html")).toBe("html-static")
    expect(agentDocumentPreviewRenderer("csv")).toBe("delimited-text")
    expect(agentDocumentPreviewRenderer("tsv")).toBe("delimited-text")
    expect(agentDocumentPreviewRenderer(null)).toBeNull()
  })
})

describe("delimited text preview", () => {
  test("parses CSV quoting, escaped quotes, CRLF, multiline cells, BOM, and blank headers", () => {
    const preview = parseDelimitedText(
      '\uFEFFname,,note\r\nAlice,42,"hello, world"\r\nBob,,"line 1\nline 2"\r\nEve,7,"said ""hi"""\r\n',
      "csv"
    )

    expect(preview.headers).toEqual(["name", "Column 2", "note"])
    expect(preview.rows).toEqual([
      ["Alice", "42", "hello, world"],
      ["Bob", "", "line 1\nline 2"],
      ["Eve", "7", 'said "hi"'],
    ])
    expect(preview.totalRows).toBe(3)
    expect(preview.rowsTruncated).toBe(false)
  })

  test("parses TSV with an explicit tab delimiter", () => {
    const preview = parseDelimitedText('name\tnote\nAda\t"one\ttwo"', "tsv")
    expect(preview.headers).toEqual(["name", "note"])
    expect(preview.rows).toEqual([["Ada", "one\ttwo"]])
  })

  test("normalizes uneven rows without dropping additional columns", () => {
    const preview = parseDelimitedText("a,b\n1\n2,3,4", "csv")
    expect(preview.headers).toEqual(["a", "b", "Column 3"])
    expect(preview.rows).toEqual([
      ["1", "", ""],
      ["2", "3", "4"],
    ])
  })

  test("rejects empty and malformed files", () => {
    expect(() => parseDelimitedText("  \n", "csv")).toThrow(DelimitedTextParseError)
    expect(() => parseDelimitedText('a,b\n"unterminated', "csv")).toThrow(
      "malformed delimited text near row 2"
    )
  })

  test("counts a large row stream while retaining only the bounded preview", () => {
    const rowCount = 20_000
    const preview = parseDelimitedText(`value\n${"x\n".repeat(rowCount)}`, "csv")

    expect(preview.totalRows).toBe(rowCount)
    expect(preview.rows).toHaveLength(MAX_DELIMITED_PREVIEW_ROWS)
    expect(preview.rowsTruncated).toBe(true)
  })

  test("caps rendered rows and columns while retaining the source dimensions", () => {
    const headers = Array.from(
      { length: MAX_DELIMITED_PREVIEW_COLUMNS + 1 },
      (_, index) => `column-${index + 1}`
    )
    const rows = Array.from(
      { length: MAX_DELIMITED_PREVIEW_ROWS + 1 },
      (_, index) => `${index},value`
    )
    const preview = parseDelimitedText(`${headers.join(",")}\n${rows.join("\n")}`, "csv")

    expect(preview.headers).toHaveLength(MAX_DELIMITED_PREVIEW_COLUMNS)
    expect(preview.rows).toHaveLength(MAX_DELIMITED_PREVIEW_ROWS)
    expect(preview.totalColumns).toBe(MAX_DELIMITED_PREVIEW_COLUMNS + 1)
    expect(preview.totalRows).toBe(MAX_DELIMITED_PREVIEW_ROWS + 1)
    expect(preview.columnsTruncated).toBe(true)
    expect(preview.rowsTruncated).toBe(true)
  })
})

describe("safe HTML preview", () => {
  test("places a restrictive CSP before untrusted document content", () => {
    const source = '<script src="https://example.test/tracker.js"></script><h1>Report</h1>'
    const document = buildSafeHtmlPreviewDocument(source)

    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<script"))
    expect(document).toContain("<h1>Report</h1>")
    expect(document).toContain("default-src 'none'")
    expect(document).toContain("script-src 'none'")
    expect(document).toContain("connect-src 'none'")
    expect(document).toContain("base-uri 'none'")
    expect(document).toContain("form-action 'none'")
    expect(HTML_PREVIEW_SANDBOX).toBe("")
  })

  test("neutralizes links, image-map areas, form targets, bases, and refresh navigation", () => {
    const document = buildSafeHtmlPreviewDocument(`
      <base href="https://base.example/">
      <meta http-equiv="refresh" content="0;url=https://refresh.example/">
      <a href="https://link.example/" target="_self" ping="https://ping.example/">Leave</a>
      <map><area href="https://area.example/" target="_top"></map>
      <form action="https://form.example/" target="_self">
        <button formaction="https://button.example/">Submit</button>
      </form>
      <svg><a xlink:href="https://svg.example/"><text>SVG link</text></a></svg>
    `)

    expect(document).not.toContain("https://base.example/")
    expect(document).not.toContain("https://refresh.example/")
    expect(document).not.toContain("https://link.example/")
    expect(document).not.toContain("https://ping.example/")
    expect(document).not.toContain("https://area.example/")
    expect(document).not.toContain("https://form.example/")
    expect(document).not.toContain("https://button.example/")
    expect(document).not.toContain("https://svg.example/")
    expect(document).toContain("<a>Leave</a>")
    expect(document).toContain("<button>Submit</button>")
  })

  test("normalizes both fragments and full documents", () => {
    const safeFragment = buildSafeHtmlPreviewDocument("<main>Fragment</main>")
    const safeFullDocument = buildSafeHtmlPreviewDocument(
      "<!doctype html><html><body>Full</body></html>"
    )

    expect(safeFragment).toContain("<body><main>Fragment</main></body>")
    expect(safeFullDocument).toContain("<body>Full</body>")
    expect(safeFragment.match(/Content-Security-Policy/g)).toHaveLength(1)
    expect(safeFullDocument.match(/Content-Security-Policy/g)).toHaveLength(1)
  })
})

describe("document preview presentation", () => {
  test("uses the side panel only for full-page desktop chat", () => {
    expect(documentPreviewPresentation(false, false)).toBe("panel")
    expect(documentPreviewPresentation(false, true)).toBe("dialog")
    expect(documentPreviewPresentation(true, false)).toBe("dialog")
    expect(documentPreviewPresentation(true, true)).toBe("dialog")
  })
})

describe("document preview tabs", () => {
  test("supports wrapped arrow navigation and Home/End keys", () => {
    const ids = ["first", "second", "third"]
    expect(documentTabIdAfterKey(ids, "first", "ArrowRight")).toBe("second")
    expect(documentTabIdAfterKey(ids, "third", "ArrowRight")).toBe("first")
    expect(documentTabIdAfterKey(ids, "first", "ArrowLeft")).toBe("third")
    expect(documentTabIdAfterKey(ids, "second", "Home")).toBe("first")
    expect(documentTabIdAfterKey(ids, "second", "End")).toBe("third")
    expect(documentTabIdAfterKey([], "first", "End")).toBeNull()
  })

  test("opens, selects, de-duplicates, and closes documents predictably", () => {
    const first = document("first", "first.md")
    const second = document("second", "second.md")
    let state = documentPreviewReducer(EMPTY_DOCUMENT_PREVIEW_STATE, {
      type: "open",
      document: first,
    })
    state = documentPreviewReducer(state, { type: "open", document: second })
    state = documentPreviewReducer(state, { type: "open", document: first })

    expect(state.documents.map((item) => item.id)).toEqual(["first", "second"])
    expect(state.activeId).toBe("first")

    state = documentPreviewReducer(state, { type: "close", id: "first" })
    expect(state.documents.map((item) => item.id)).toEqual(["second"])
    expect(state.activeId).toBe("second")

    state = documentPreviewReducer(state, { type: "close", id: "second" })
    expect(state).toEqual(EMPTY_DOCUMENT_PREVIEW_STATE)
  })

  test("keeps the active tab when closing a background document", () => {
    const first = document("first", "first.md")
    const second = document("second", "second.md")
    let state = documentPreviewReducer(EMPTY_DOCUMENT_PREVIEW_STATE, {
      type: "open",
      document: first,
    })
    state = documentPreviewReducer(state, { type: "open", document: second })
    state = documentPreviewReducer(state, { type: "close", id: "first" })

    expect(state.activeId).toBe("second")
  })
})

describe("Markdown document loading policy", () => {
  test("rejects oversized Markdown before loading it", () => {
    expect(markdownPreviewTooLarge(document("small", "small.md"))).toBe(false)
    expect(
      markdownPreviewTooLarge({
        ...document("large", "large.md"),
        fileRef: { ...MARKDOWN_FILE, sizeBytes: MAX_MARKDOWN_PREVIEW_BYTES + 1 },
      })
    ).toBe(true)
  })

  test("normalizes expected API errors", () => {
    expect(documentLoadError(new SixbApiError("missing", { status: 404 }))).toBe(
      "This document is no longer available."
    )
    expect(documentLoadError(new SixbApiError("missing storage", { status: 501 }))).toBe(
      "Document storage is not available."
    )
    expect(documentLoadError(new Error("network details"))).toBe("Could not load this document.")
  })
})

function document(id: string, fileName: string): AgentDocumentSource {
  return {
    id,
    kind: "markdown",
    fileRef: { ...MARKDOWN_FILE, blobId: id, fileName },
    threadId: "thread-1",
    messageId: `message-${id}`,
    partIndex: 0,
    inlineUrl: `https://example.test/${id}`,
    downloadUrl: `https://example.test/${id}?disposition=attachment`,
  }
}
