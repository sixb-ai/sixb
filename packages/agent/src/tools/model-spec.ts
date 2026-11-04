import type { AgentRunWebPlan, AgentToolSpec } from "@sixb/core/internal/agents"
import type { SandboxNetworkPolicy } from "@sixb/core/sandboxes"
import {
  PUBLISH_ARTIFACT_TOOL_SPEC,
  PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
} from "../artifacts/publish-tool"
import { BASH_OUTPUT_TOOL_SPEC, BASH_STOP_TOOL_SPEC } from "./background"
import { BASH_TOOL_SPEC } from "./bash"
import { READ_TOOL_SPEC } from "./read"
import { VIEW_FILE_TOOL_SPEC } from "./view-file"
import { WEB_FETCH_TOOL_SPEC } from "./web-fetch/tool"
import { WEB_SEARCH_TOOL_SPEC } from "./web-search"

/**
 * Describe exactly the tools a conversational model receives, in its order, without starting its
 * sandbox. A conversation publishes artifacts once its run executes in a thread; it searches the
 * web when its plan names a search model, and fetches pages when its plan has web tools at all,
 * unless its sandbox's network is `none`.
 */
export function agentModelToolSpecs(
  projectTools: readonly AgentToolSpec[],
  options: {
    readonly publishes?: boolean
    readonly web?: AgentRunWebPlan
    readonly networkPolicy?: SandboxNetworkPolicy
  } = {}
): readonly AgentToolSpec[] {
  return [
    ...projectTools,
    VIEW_FILE_TOOL_SPEC,
    READ_TOOL_SPEC,
    BASH_TOOL_SPEC,
    BASH_OUTPUT_TOOL_SPEC,
    BASH_STOP_TOOL_SPEC,
    ...(options.web?.search ? [WEB_SEARCH_TOOL_SPEC] : []),
    ...(fetchesWeb(options.web, options.networkPolicy) ? [WEB_FETCH_TOOL_SPEC] : []),
    ...(options.publishes === false
      ? []
      : [PUBLISH_ARTIFACT_TOOL_SPEC, PUBLISH_ARTIFACT_VERSION_TOOL_SPEC]),
  ]
}

/** Whether a run has `web_fetch`: web tools are on, and its sandbox may reach the network. */
export function fetchesWeb(
  web: AgentRunWebPlan | undefined,
  networkPolicy: SandboxNetworkPolicy | undefined
): boolean {
  return web !== undefined && networkPolicy?.mode !== "none"
}
