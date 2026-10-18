import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { ArtifactPanelRoot, useArtifactPanel } from "../src/agent/artifact-panel"
import { createLiveRunState, type LiveRunState } from "../src/agent/live-run"
import type { NormalizedPart } from "../src/agent/parts"
import { useLivePublishes } from "../src/agent/publish-artifact/use-live-publishes"
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

const published: NormalizedPart = {
  kind: "tool",
  tool: {
    toolName: "publish_artifact",
    state: "output-available",
    input: { title: "Q3 review" },
    output: {
      artifactId: "art_review0001",
      version: 1,
      kind: "document",
      title: "Q3 review",
      warnings: [],
    },
  },
}

function Conversation({ live }: { readonly live: LiveRunState }) {
  useLivePublishes(live)
  const panel = useArtifactPanel()
  return <output data-testid="open">{panel?.openKey ?? "none"}</output>
}

/** A conversation whose run publishes its first artifact once it is on screen. */
async function publishInto(compact: boolean, runId: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  const ui = (parts: readonly NormalizedPart[]) => (
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <ArtifactPanelRoot compact={compact} scopeKey="thread">
          <Conversation live={{ ...createLiveRunState(runId), active: true, parts }} />
        </ArtifactPanelRoot>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(ui([]))
  expect(view.getByTestId("open").textContent).toBe("none")
  await act(async () => {
    view.rerender(ui([published]))
  })
  return view.getByTestId("open").textContent
}

describe("a run's first publish", () => {
  test("opens the artifact beside the conversation", async () => {
    expect(await publishInto(false, "run_beside")).toBe("artifact:art_review0001")
  })

  test("leaves it to its card where the panel would open as a dialog", async () => {
    // A dialog takes focus, the composer's included, while the Agent is still working. The dock
    // with no room beside it opens the panel as one, as a phone does. Reproduce by dropping the
    // presentation check from useLivePublishes: the artifact opens.
    expect(await publishInto(true, "run_docked")).toBe("none")
  })
})
