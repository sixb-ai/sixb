import { describe, expect, test } from "bun:test"
import { InMemoryBlobStorage, type JsonValue } from "@sixb/core"
import { agentToolResultToModelOutput } from "../src/tool-result-output"

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  )
)

describe("agent tool model output", () => {
  test("keeps plain JSON tool output unchanged", async () => {
    await expect(
      agentToolResultToModelOutput({
        output: { ok: true },
        blobStorage: new InMemoryBlobStorage(),
      })
    ).resolves.toEqual({ type: "json", value: { ok: true } })
  })

  test("projects a rich image result without changing its durable FileRef", async () => {
    const blobStorage = new InMemoryBlobStorage()
    const fileRef = await blobStorage.put({
      body: PNG_BYTES,
      fileName: "generated.png",
      mediaType: "image/png",
    })
    const output: JsonValue = {
      kind: "agentToolResult",
      content: [
        { type: "text", text: "Created the image." },
        { type: "file", fileRef: { ...fileRef } },
      ],
    }

    const projected = await agentToolResultToModelOutput({
      output,
      blobStorage,
    })

    expect(projected.type).toBe("text")
    expect(projected.value).toContain("Created the image.")
    expect(projected.value).toContain("generated.png")
    expect(projected.value).not.toContain("data:image")
    expect(JSON.stringify(output)).not.toContain("data:image")
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
