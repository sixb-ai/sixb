import { join } from "node:path"
import type { Sandbox } from "@sixb/core"
import { loadAgentCliAssets } from "./agent-cli-assets"
import { AGENT_RUNTIME_PROFILE } from "./agent-runtime/profile"
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
  const binDir = join(contextDir, "bin")
  const libDir = join(contextDir, "lib")
  const runContextPath = join(contextDir, "context", "run.json")
  const bashEnvPath = join(contextDir, "context", "bash-env")
  const runtimeProbePath = join(contextDir, "runtime", "read-probe.txt")
  const attachmentsManifestPath = join(contextDir, "context", "attachments.json")
  const attachmentsDir = join(contextDir, "attachments")
  const outputRoot = join(contextDir, "outputs")
  const outputStagingDir = join(outputRoot, "staging")
  const outputDir = join(outputRoot, "published")
  const cli = await loadAgentCliAssets()

  // apiBaseUrl arrives already normalized + wrapped as the run's gateway URL (see worker.ts /
  // api-url.ts), so it is used verbatim — no second normalization pass here.
  const runContext = JSON.stringify(
    {
      projectId: input.projectId,
      agentId: input.agentId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      runId: input.runId,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
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
    { path: join(binDir, "sixb"), contents: cli.launcher, mode: 0o755 },
    { path: join(libDir, "sixb.mjs"), contents: cli.artifact, mode: 0o644 },
    { path: runContextPath, contents: runContext },
    { path: runtimeProbePath, contents: "first\nsixb-runtime-probe\nthird\n", mode: 0o644 },
    {
      path: bashEnvPath,
      contents: [
        "# Installed by Sixb for every sandboxed bash command.",
        `if [ -n "\${SIXB_BIN_DIR:-}" ]; then`,
        '  export PATH="$SIXB_BIN_DIR:$PATH"',
        "fi",
        "export SIXB_BASH_ENV_READY=1",
        "",
      ].join("\n"),
    },
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
      SIXB_BIN_DIR: binDir,
      SIXB_AGENT_RUNTIME_PROFILE: AGENT_RUNTIME_PROFILE,
      SIXB_RUNTIME_PROBE_FILE: runtimeProbePath,
      BASH_ENV: bashEnvPath,
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
