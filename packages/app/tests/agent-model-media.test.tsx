import { describe, expect, test } from "bun:test"
import { getAiModelCallFilesOptions } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render as mount } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { ArtifactPanelRoot, useArtifactPanel } from "../src/agent/artifact-panel"
import { AssistantBody } from "../src/agent/components/message-parts"
import type { NormalizedPart } from "../src/agent/parts"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const IMAGE = 'sixb models image "A red delivery van" --model bfl/flux --output out/van.png'
const file = (mediaType: string) => ({
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 1024,
  mediaType,
})

function bash(
  command: string,
  result?: { readonly stdout: object | string; readonly exitCode?: number }
) {
  const part: NormalizedPart = {
    kind: "tool",
    tool: result
      ? {
          toolName: "bash",
          state: "output-available",
          input: { command },
          output: {
            stdout:
              typeof result.stdout === "string" ? result.stdout : JSON.stringify(result.stdout),
            stderr: "",
            exitCode: result.exitCode ?? 0,
            durationMs: 9000,
          },
        }
      : { toolName: "bash", state: "input-available", input: { command } },
  }
  return part
}

/** The calls' files, stored without a name, as the call route would return them. */
function callFiles(): QueryClient {
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
  return queryClient
}

/** A finished turn, with its calls' files. */
function render(parts: NormalizedPart[], live = false): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={callFiles()}>
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

  test("a finished step whose output names no call shows nothing", () => {
    // Its stdout is not one JSON object: two calls in one step, or the output piped elsewhere.
    // Reproduce by dropping the callId check from generatedMedia: each holds a frame forever.
    const twoCalls = [
      { callId: "call_van", files: ["out/van.jpg"] },
      { callId: "call_blue", files: ["out/blue.jpg"] },
    ]
      .map((output) => JSON.stringify(output))
      .join("\n")

    for (const step of [
      bash(`${IMAGE} && sixb models image "A blue van" --output out/blue.png`, {
        stdout: twoCalls,
      }),
      bash(`${IMAGE} | jq -r '.files[0]'`, { stdout: "out/van.jpg\n" }),
    ]) {
      const html = render([step, { kind: "text", text: "Here they are." }])
      expect(html).not.toContain("sixb-media-developing")
      expect(html).not.toContain("<img")
    }
  })

  test("an image opens in the viewer under the name the command saved it as", async () => {
    // Reproduce by dropping the fileName passed to modelCallFileSource: the viewer says "File".
    function OpenFile() {
      const target = useArtifactPanel()?.openTarget
      return <output data-testid="open">{target?.type === "file" ? target.source.name : ""}</output>
    }

    const view = mount(
      <QueryClientProvider client={callFiles()}>
        <MemoryRouter>
          <ArtifactPanelRoot scopeKey="thread">
            <AssistantBody
              parts={[bash(IMAGE, { stdout: { callId: "call_van", files: ["out/van.jpg"] } })]}
            />
            <OpenFile />
          </ArtifactPanelRoot>
        </MemoryRouter>
      </QueryClientProvider>
    )
    await act(async () => {
      fireEvent.click(view.getByLabelText("Open image"))
    })

    expect(view.getByTestId("open").textContent).toBe("van.jpg")
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
