import { handoffAgentSurfaceThread } from "@sixb/agent-ui"

export const ATLAS_AGENT_SURFACE_SCOPE = "agents"
export const ATLAS_AGENT_SURFACE_KEY = "sixb.atlas.agent-surface.v1"

export function selectAtlasAgentThread(threadId: string) {
  handoffAgentSurfaceThread(ATLAS_AGENT_SURFACE_SCOPE, threadId, ATLAS_AGENT_SURFACE_KEY)
}
