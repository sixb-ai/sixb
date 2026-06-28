import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Sandbox } from "@sixb/core"
import { renderAgentSkillCatalog, writeAgentSkills } from "./agent-skills"
import { normalizeApiBaseUrl } from "./api-url"

export interface AgentSandboxApiContext {
  readonly env: Readonly<Record<string, string>>
  readonly systemAddendum: string
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

  await mkdir(join(contextDir, "context"), { recursive: true })
  await writeAgentSkills(skillsDir)
  await writeFile(
    runContextPath,
    JSON.stringify(
      {
        projectId: input.projectId,
        agentId: input.agentId,
        threadId: input.threadId,
        runId: input.runId,
        apiBaseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
      },
      null,
      2
    ),
    "utf-8"
  )

  return {
    env: {
      SIXB_API_BASE_URL: normalizeApiBaseUrl(input.apiBaseUrl),
      SIXB_CONTEXT_DIR: contextDir,
      SIXB_SKILLS_DIR: skillsDir,
      SIXB_RUN_CONTEXT: runContextPath,
      SIXB_PROJECT_ID: input.projectId,
      SIXB_AGENT_ID: input.agentId,
      SIXB_THREAD_ID: input.threadId,
      SIXB_RUN_ID: input.runId,
    },
    systemAddendum: renderAgentSkillCatalog(),
  }
}
