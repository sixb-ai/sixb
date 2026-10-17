import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { ArtifactPanelRoot } from "../src/agent/artifact-panel"
import { AssistantBody } from "../src/agent/components/message-parts"
import type { NormalizedPart, NormalizedTool } from "../src/agent/parts"
import { turnArtifacts, unpublishedTitles } from "../src/agent/publish-artifact/interpret"
import { PublishArtifactToolView } from "../src/agent/publish-artifact/publish-artifact-tool-view"

function publish(artifactId: string, version: number, title: string): NormalizedPart {
  return {
    kind: "tool",
    tool: {
      toolName: version === 1 ? "publish_artifact" : "publish_artifact_version",
      state: "output-available",
      input: { path: "work/review", title },
      output: { artifactId, version, kind: "document", title, warnings: [] },
    },
  }
}

function refused(input: Record<string, unknown>): NormalizedPart {
  return {
    kind: "tool",
    tool: {
      toolName: "id" in input ? "publish_artifact_version" : "publish_artifact",
      state: "output-error",
      input: { path: "work/review", ...input },
      errorText: "[SixbAgentWorker] publish_artifact refused: there is nothing to publish.",
    },
  }
}

function render(node: ReactNode): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  )
}

describe("what a turn published", () => {
  const parts: NormalizedPart[] = [
    publish("art_review0001", 1, "Q3 review draft"),
    { kind: "text", text: "Drafted it; tightening the numbers." },
    publish("art_brief00001", 1, "Board brief"),
    publish("art_review0001", 2, "Q3 review"),
    { kind: "text", text: "Both are ready." },
  ]

  test("is one card per artifact, at the last version the turn published", () => {
    expect(turnArtifacts(parts).map((artifact) => [artifact.artifactId, artifact.version])).toEqual(
      [
        ["art_review0001", 2],
        ["art_brief00001", 1],
      ]
    )

    const html = render(<AssistantBody parts={parts} />)
    expect(html).toContain('aria-label="Published in this response"')
    expect(html.match(/aria-label="Open /g)).toHaveLength(2)
    expect(html).toContain('aria-label="Open Q3 review"')
    expect(html).toContain(">Document · Version 2<")
    expect(html).not.toContain("Q3 review draft")
    // The cards close the answer, after its text.
    expect(html.indexOf("Both are ready.")).toBeLessThan(html.indexOf("Published in this response"))
  })

  test("keeps every publish in the work, with its version, warnings, or refusal", () => {
    const warned: NormalizedTool = {
      toolName: "publish_artifact",
      state: "output-available",
      input: { title: "Q3 review" },
      output: {
        artifactId: "art_review0001",
        version: 3,
        kind: "document",
        title: "Q3 review",
        warnings: [{ code: "contrast", message: "Low contrast text.", part: "risks" }],
      },
    }
    const refused: NormalizedTool = {
      toolName: "publish_artifact",
      state: "output-error",
      input: { title: "Q3 review" },
      errorText:
        "[SixbAgentWorker] publish_artifact refused: document.md shows the image 'chart.svg', which is not one of the artifact's files.",
    }

    const published = render(<PublishArtifactToolView tool={warned} />)
    expect(published).toContain("Published Q3 review")
    expect(published).toContain("· v3")
    expect(published).toContain("risks: Low contrast text.")

    const failed = render(<PublishArtifactToolView tool={refused} />)
    expect(failed).toContain("Couldn&#x27;t publish Q3 review")
    expect(failed).toContain(
      "document.md shows the image &#x27;chart.svg&#x27;, which is not one of the artifact&#x27;s files."
    )
    expect(failed).not.toContain("[SixbAgentWorker]")
  })
})

describe("an artifact's cards across turns", () => {
  test("only the card of the version that is open reads as open", () => {
    // Reproduce by letting useIsOpen match on the artifact alone: both cards read as open.
    const html = render(
      <MemoryRouter>
        <ArtifactPanelRoot
          scopeKey="thread"
          routeTarget={{ type: "artifact", artifactId: "art_review0001", version: 3 }}
          onRouteTargetChange={() => {}}
        >
          <AssistantBody parts={[publish("art_review0001", 2, "Q3 review")]} />
          <AssistantBody parts={[publish("art_review0001", 3, "Q3 review")]} />
        </ArtifactPanelRoot>
      </MemoryRouter>
    )
    const pressed = [...html.matchAll(/aria-pressed="(true|false)"/g)].map((match) => match[1])
    expect(pressed).toEqual(["false", "true"])
  })
})

describe("what a turn could not publish", () => {
  test("is said where the card would be, once the turn is over", () => {
    // Reproduce by dropping the NotPublished blocks from AssistantBody: only the work, collapsed,
    // would show the refusals, and the answer may still claim the deliverable is ready.
    const parts: NormalizedPart[] = [
      refused({ kind: "document", title: "Q3 review" }),
      refused({ kind: "document", title: "Q3 review" }),
      { kind: "text", text: "I prepared the Q3 review." },
    ]
    expect(render(<AssistantBody parts={parts} />)).toContain("Couldn&#x27;t publish Q3 review")
    expect(render(<AssistantBody parts={parts} live />)).not.toContain("Couldn&#x27;t publish")
    expect(unpublishedTitles(parts)).toEqual(["Q3 review"])
  })

  test("is only what no later publish replaced", () => {
    expect(
      unpublishedTitles([
        refused({ kind: "document", title: "Q3 review" }),
        publish("art_review0001", 1, "Q3 review"),
      ])
    ).toEqual([])
    // A revision that failed after the first version still failed.
    expect(
      unpublishedTitles([
        publish("art_review0001", 1, "Q3 review"),
        refused({ id: "art_review0001", title: "Q3 review, final" }),
      ])
    ).toEqual(["Q3 review, final"])
  })
})
