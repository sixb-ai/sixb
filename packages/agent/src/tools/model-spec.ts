import type { JsonObject } from "@sixb/core/models"
import {
  PUBLISH_ARTIFACT_TOOL_SPEC,
  PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
} from "../artifacts/publish-tool"
import { BASH_TOOL_SPEC } from "./bash"
import { READ_TOOL_SPEC } from "./read"
import { VIEW_FILE_TOOL_SPEC } from "./view-file"

/** The exact name, description, and input schema presented to the model for one tool. */
export interface AgentModelToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}

/** Describe exactly the tools a conversational model receives, without starting its sandbox. */
export function agentModelToolSpecs(
  projectTools: readonly AgentModelToolSpec[]
): readonly AgentModelToolSpec[] {
  return [
    ...projectTools,
    VIEW_FILE_TOOL_SPEC,
    READ_TOOL_SPEC,
    BASH_TOOL_SPEC,
    PUBLISH_ARTIFACT_TOOL_SPEC,
    PUBLISH_ARTIFACT_VERSION_TOOL_SPEC,
  ]
}
