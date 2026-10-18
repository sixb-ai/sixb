import { describe, expect, test } from "bun:test"
import { InMemoryBlobStorage } from "@sixb/core"
import { agentToolResultToModelOutput } from "../src/tools/result-output"

describe("agent tool model output", () => {
  test("keeps plain JSON tool output unchanged", async () => {
    await expect(
      agentToolResultToModelOutput({
        output: { ok: true },
        blobStorage: new InMemoryBlobStorage(),
      })
    ).resolves.toEqual({ type: "json", value: { ok: true } })
  })

  test("keeps a bounded prefix for oversized text files", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const body = new TextEncoder().encode(`first line\n${"0123456789\n".repeat(8_000)}last line`)
    const fileRef = await blobStorage.put({
      body,
      fileName: "generated.txt",
      mediaType: "text/plain",
    })

    const projected = await agentToolResultToModelOutput({
      output: {
        kind: "agentToolResult",
        content: [{ type: "file", fileRef: { ...fileRef } }],
      },
      blobStorage,
    })

    expect(projected.type).toBe("text")
    expect(projected.value).toContain("first line")
    expect(projected.value).toContain("Text file truncated for model input")
    expect(projected.value).not.toContain("last line")
    expect(projected.value).not.toContain("exceeds the attachment read limit")
  })
})
