import { describe, expect, test } from "bun:test"
import { getAiModelCallFilesOptions } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { AssistantBody } from "../src/agent/components/message-parts"
import type { NormalizedPart } from "../src/agent/parts"

const IMAGE = 'sixb models image "A red delivery van" --model bfl/flux --output out/van.png'
const file = (mediaType: string) => ({
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 1024,
  mediaType,
})

function bash(command: string, result?: { readonly stdout: object; readonly exitCode?: number }) {
  const part: NormalizedPart = {
    kind: "tool",
    tool: result
      ? {
          toolName: "bash",
          state: "output-available",
          input: { command },
          output: {
            stdout: JSON.stringify(result.stdout),
            stderr: "",
            exitCode: result.exitCode ?? 0,
            durationMs: 9000,
          },
        }
      : { toolName: "bash", state: "input-available", input: { command } },
  }
  return part
}

/** A finished turn, with the calls' files as the call route would return them. */
function render(parts: NormalizedPart[], live = false): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  for (const [callId, mediaType] of [
    ["call_van", "image/jpeg"],
    ["call_voice", "audio/mpeg"],
  ] as const) {
    queryClient.setQueryData(getAiModelCallFilesOptions({ path: { callId } }).queryKey, {
      callId,
      files: [file(mediaType)],
      recordedAt: "2026-10-22T12:00:00.000Z",
    })
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AssistantBody parts={parts} live={live} />
    </QueryClientProvider>
  )
}

describe("what the agent's models made", () => {
  // Removal proof: drop the generated media from WorkGroup; the image is behind the closed work.
  test("an image shows under the closed work, with its request as the caption", () => {
    const html = render([
      bash(IMAGE, { stdout: { callId: "call_van", files: ["out/van.jpg"] } }),
      { kind: "text", text: "Here it is." },
    ])

    expect(html).toContain("/api/ai/model-calls/call_van/files/content?path=%2Ffiles%2F0")
    expect(html).toContain("A red delivery van")
    // However long the request, its caption is held to two lines.
    expect(html).toMatch(/line-clamp-2[^>]*>A red delivery van/)
    // The model and the command stay inside the closed work group.
    expect(html).not.toContain("bfl/flux")
    expect(html).not.toContain("sixb models image")
  })

  test("an image being made holds its place; a failed call shows nothing", () => {
    expect(render([bash(IMAGE)], true)).toContain("sixb-media-developing")

    const failed = render([
      bash(IMAGE, { stdout: { error: "Image size is not supported" }, exitCode: 1 }),
      { kind: "text", text: "That size is not available." },
    ])
    expect(failed).not.toContain("sixb-media-developing")
    expect(failed).not.toContain("<img")
  })

  test("a voice clip shows as a player, with its words as the caption", () => {
    const html = render([
      bash('sixb models speech "The report is ready." --output out/ready.mp3', {
        stdout: { callId: "call_voice", files: ["out/ready.mp3"] },
      }),
    ])

    expect(html).toContain('aria-label="Play"')
    expect(html).toContain("/api/ai/model-calls/call_voice/files/content")
    expect(html).toContain("“The report is ready.”")
  })
})
