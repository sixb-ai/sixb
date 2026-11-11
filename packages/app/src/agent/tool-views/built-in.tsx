import type { ReactNode } from "react"
import { BackgroundCommandStep } from "../background/background-card"
import { BackgroundToolRow } from "../background/background-tool-row"
import { isBackgroundStart } from "../background/interpret"
import { BashToolView } from "../bash/bash-tool-view"
import { WebFetchToolView } from "../components/web-fetch-tool-view"
import { WebSearchToolView } from "../components/web-search-tool-view"
import { EditToolView, WriteToolView } from "../file-edits/file-edit-tool-view"
import type { NormalizedTool } from "../parts"
import { isPlanCall } from "../plan/interpret"
import { PlanToolView } from "../plan/plan-tool-view"
import { OpenArtifactToolView } from "../publish-artifact/open-artifact-tool-view"
import { PublishArtifactToolView } from "../publish-artifact/publish-artifact-tool-view"
import { ReadToolView } from "../read/read-tool-view"
import { coerceGlobOutput, coerceGrepOutput } from "../search/interpret"
import { GlobToolView, GrepToolView } from "../search/search-tool-view"
import { coerceWebFetchOutput } from "../utils/web-fetch"
import { coerceWebSearchOutput } from "../utils/web-search"
import { describeViewFile } from "../view-file/interpret"
import { ViewFileToolView } from "../view-file/view-file-tool-view"
import { waitsForCommandsOnly } from "../waits"

type BuiltInToolView = (tool: NormalizedTool) => ReactNode

const publishArtifact: BuiltInToolView = (tool) => <PublishArtifactToolView tool={tool} />

// The framework's own rows in the work, by tool name. A view returns null to leave the call to the
// generic inspector, as web results do when their output does not parse.
const BUILT_IN_TOOL_VIEWS: ReadonlyMap<string, BuiltInToolView> = new Map([
  [
    "bash",
    (tool) =>
      isBackgroundStart(tool) ? (
        <BackgroundCommandStep tool={tool} />
      ) : (
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
  // A wait or a stop for commands alone is their row; one for a sub-agent is the sub-agent's. A
  // failed one keeps the inspector, which says why. Earlier threads hold bash_output and bash_stop.
  ...["wait", "stop", "bash_output", "bash_stop"].map((name): [string, BuiltInToolView] => [
    name,
    (tool) =>
      tool.state === "output-error" || !waitsForCommandsOnly(tool) ? null : (
        <BackgroundToolRow tool={tool} />
      ),
  ]),
  // A file read shows as itself, an image or a PDF, keeps the view view_file had.
  [
    "read",
    (tool) =>
      describeViewFile(tool).file ? <ViewFileToolView tool={tool} /> : <ReadToolView tool={tool} />,
  ],
  ["edit", (tool) => <EditToolView tool={tool} />],
  ["write", (tool) => <WriteToolView tool={tool} />],
  [
    "glob",
    (tool) =>
      tool.state !== "output-available" || coerceGlobOutput(tool.output) !== null ? (
        <GlobToolView tool={tool} />
      ) : null,
  ],
  [
    "grep",
    (tool) =>
      tool.state !== "output-available" || coerceGrepOutput(tool.output) !== null ? (
        <GrepToolView tool={tool} />
      ) : null,
  ],
  ["todo", (tool) => (isPlanCall(tool) ? <PlanToolView tool={tool} /> : null)],
  // Earlier threads hold calls to it.
  ["view_file", (tool) => <ViewFileToolView tool={tool} />],
  ["publish_artifact", publishArtifact],
  ["update_artifact", publishArtifact],
  ["publish_artifact_version", publishArtifact],
  ["open_artifact", (tool) => <OpenArtifactToolView tool={tool} />],
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
