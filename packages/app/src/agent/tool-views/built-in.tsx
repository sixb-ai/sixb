import type { ReactNode } from "react"
import { BashToolView } from "../bash/bash-tool-view"
import { WebFetchToolView } from "../components/web-fetch-tool-view"
import { WebSearchToolView } from "../components/web-search-tool-view"
import type { NormalizedTool } from "../parts"
import { PublishArtifactToolView } from "../publish-artifact/publish-artifact-tool-view"
import { ReadToolView } from "../read/read-tool-view"
import { coerceWebFetchOutput } from "../utils/web-fetch"
import { coerceWebSearchOutput } from "../utils/web-search"
import { ViewFileToolView } from "../view-file/view-file-tool-view"

type BuiltInToolView = (tool: NormalizedTool) => ReactNode

const publishArtifact: BuiltInToolView = (tool) => <PublishArtifactToolView tool={tool} />

// The framework's own rows in the work, by tool name. A view returns null to leave the call to the
// generic inspector, as web results do when their output does not parse.
const BUILT_IN_TOOL_VIEWS: ReadonlyMap<string, BuiltInToolView> = new Map([
  [
    "bash",
    (tool) => (
      <BashToolView
        tool={{
          state: tool.state,
          input: tool.input,
          inputText: tool.inputText,
          output: tool.output,
          errorText: tool.errorText,
        }}
      />
    ),
  ],
  ["read", (tool) => <ReadToolView tool={tool} />],
  ["view_file", (tool) => <ViewFileToolView tool={tool} />],
  ["publish_artifact", publishArtifact],
  ["publish_artifact_version", publishArtifact],
  [
    "web_fetch",
    (tool) =>
      tool.state !== "output-available" || coerceWebFetchOutput(tool.output) !== null ? (
        <WebFetchToolView tool={tool} />
      ) : null,
  ],
  [
    "web_search",
    (tool) =>
      tool.state !== "output-available" || coerceWebSearchOutput(tool.output) !== null ? (
        <WebSearchToolView tool={tool} />
      ) : null,
  ],
])

/** The framework's row for a call, or null when the generic inspector shows it. */
export function builtInToolView(tool: NormalizedTool): ReactNode {
  return BUILT_IN_TOOL_VIEWS.get(tool.toolName)?.(tool) ?? null
}
