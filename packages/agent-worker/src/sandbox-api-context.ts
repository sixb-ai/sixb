import { join } from "node:path"
import type { Sandbox } from "@sixb/core"
import { buildAgentSkillFiles } from "./agent-skills"

export interface AgentSandboxApiContext {
  readonly env: Readonly<Record<string, string>>
}

export interface PrepareAgentSandboxApiContextInput {
  readonly sandbox: Sandbox
  readonly apiBaseUrl: string
  readonly projectId: string
  readonly agentId: string
  readonly threadId: string
  readonly runId: string
}

export async function prepareAgentSandboxApiContext(
  input: PrepareAgentSandboxApiContextInput
): Promise<AgentSandboxApiContext> {
  const contextDir = join(input.sandbox.workingDirectory, ".sixb", "agent")
  const skillsDir = join(contextDir, "skills")
  const runContextPath = join(contextDir, "context", "run.json")

  // apiBaseUrl arrives already normalized + wrapped as the run's gateway URL (see worker.ts /
  // api-url.ts), so it is used verbatim — no second normalization pass here.
  const runContext = JSON.stringify(
    {
      projectId: input.projectId,
      agentId: input.agentId,
      threadId: input.threadId,
      runId: input.runId,
      apiBaseUrl: input.apiBaseUrl,
    },
    null,
    2
  )

  // Materialize skills + run context through the sandbox capability rather than the host
  // filesystem, so any provider (including non-host-path ones like smolvm) places the bytes in the
  // guest. Awaited before the bash tool runs, so the agent never sees an un-provisioned sandbox.
  await input.sandbox.writeFiles([
    ...(await buildAgentSkillFiles(skillsDir)),
    { path: runContextPath, contents: runContext },
  ])

  return {
    env: {
      SIXB_API_BASE_URL: input.apiBaseUrl,
      SIXB_CONTEXT_DIR: contextDir,
      SIXB_SKILLS_DIR: skillsDir,
      SIXB_RUN_CONTEXT: runContextPath,
      SIXB_PROJECT_ID: input.projectId,
      SIXB_AGENT_ID: input.agentId,
      SIXB_THREAD_ID: input.threadId,
      SIXB_RUN_ID: input.runId,
    },
  }
}
