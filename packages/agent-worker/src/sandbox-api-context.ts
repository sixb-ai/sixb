import { join } from "node:path"
import type { Sandbox } from "@sixb/core"
import { type AgentSkill, buildAgentSkillFiles } from "./agent-skills"
import type { PreparedAgentAttachmentContext } from "./attachments"

export interface AgentSandboxApiContext {
  readonly env: Readonly<Record<string, string>>
}

export interface PrepareAgentSandboxApiContextInput {
  readonly sandbox: Sandbox
  readonly apiBaseUrl: string
  readonly projectId: string
  readonly agentId: string
  readonly threadId?: string
  readonly runId: string
  readonly attachments?: PreparedAgentAttachmentContext
  readonly skills: readonly AgentSkill[]
}

export async function prepareAgentSandboxApiContext(
  input: PrepareAgentSandboxApiContextInput
): Promise<AgentSandboxApiContext> {
  const contextDir = join(input.sandbox.workingDirectory, ".sixb", "agent")
  const skillsDir = join(contextDir, "skills")
  const runContextPath = join(contextDir, "context", "run.json")
  const attachmentsManifestPath = join(contextDir, "context", "attachments.json")
  const attachmentsDir = join(contextDir, "attachments")
  const outputRoot = join(contextDir, "outputs")
  const outputStagingDir = join(outputRoot, "staging")
  const outputDir = join(outputRoot, "published")

  // apiBaseUrl arrives already normalized + wrapped as the run's gateway URL (see worker.ts /
  // api-url.ts), so it is used verbatim — no second normalization pass here.
  const runContext = JSON.stringify(
    {
      projectId: input.projectId,
      agentId: input.agentId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      runId: input.runId,
      apiBaseUrl: input.apiBaseUrl,
      attachmentsManifestPath,
      attachmentsDir,
      outputDir,
      outputStagingDir,
    },
    null,
    2
  )

  // Materialize skills + run context through the sandbox capability rather than the host
  // filesystem, so any provider (including non-host-path ones like smolvm) places the bytes in the
  // guest. Awaited before sandbox tools run, so the agent never sees an un-provisioned sandbox.
  await input.sandbox.writeFiles([
    ...buildAgentSkillFiles(skillsDir, input.skills),
    { path: runContextPath, contents: runContext },
    {
      path: attachmentsManifestPath,
      contents: input.attachments?.manifestJson ?? emptyManifestJson(),
    },
    { path: join(outputStagingDir, ".keep"), contents: "" },
    { path: join(outputDir, ".keep"), contents: "" },
    ...(input.attachments?.sandboxFiles.map((file) => ({
      path: join(input.sandbox.workingDirectory, file.path),
      contents: file.bytes,
    })) ?? []),
  ])

  return {
    env: {
      SIXB_API_BASE_URL: input.apiBaseUrl,
      SIXB_CONTEXT_DIR: contextDir,
      SIXB_SKILLS_DIR: skillsDir,
      SIXB_RUN_CONTEXT: runContextPath,
      SIXB_ATTACHMENTS: attachmentsManifestPath,
      SIXB_ATTACHMENT_DIR: attachmentsDir,
      SIXB_OUTPUT_DIR: outputDir,
      SIXB_OUTPUT_STAGING_DIR: outputStagingDir,
      SIXB_PROJECT_ID: input.projectId,
      SIXB_AGENT_ID: input.agentId,
      ...(input.threadId ? { SIXB_THREAD_ID: input.threadId } : {}),
      SIXB_RUN_ID: input.runId,
    },
  }
}

function emptyManifestJson(): string {
  return JSON.stringify({ attachments: [] }, null, 2)
}
