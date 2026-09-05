import { RuntimeError } from "../runtime/errors"
import { AgentRequestError } from "./errors"

/** Reject JavaScript callers too: old configuration must not silently change authority. */
export function assertNoAgentDefinitions(input: object): void {
  if ("agents" in input) {
    throw new RuntimeError(
      "[Sixb] Agent definitions are no longer supported. Configure 'models' and 'tools' on createSixb() instead."
    )
  }
}

export function assertNoAgentSelector(input: object): void {
  if ("agentId" in input || "agentIds" in input) {
    throw new AgentRequestError(
      "agent_selector_removed",
      "[Sixb] There is one project Agent. Remove the agentId selector and use sixb.agent."
    )
  }
}
