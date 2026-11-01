import type { AgentToolSpec } from "@sixb/core/internal/agents"
import {
  PUBLISH_ARTIFACT_TOOL_SPEC,
  PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
} from "../artifacts/publish-tool"
import { BASH_TOOL_SPEC } from "./bash"
import { READ_TOOL_SPEC } from "./read"
import { VIEW_FILE_TOOL_SPEC } from "./view-file"

/**
 * Describe exactly the tools a conversational model receives, in its order, without starting its
 * sandbox. A conversation publishes artifacts once its run executes in a thread.
 */
export function agentModelToolSpecs(
  projectTools: readonly AgentToolSpec[],
  options: { readonly publishes?: boolean } = {}
): readonly AgentToolSpec[] {
  return [
    ...projectTools,
    VIEW_FILE_TOOL_SPEC,
    READ_TOOL_SPEC,
    BASH_TOOL_SPEC,
    ...(options.publishes === false
      ? []
      : [PUBLISH_ARTIFACT_TOOL_SPEC, PUBLISH_ARTIFACT_VERSION_TOOL_SPEC]),
  ]
}
