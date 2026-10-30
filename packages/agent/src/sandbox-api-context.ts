import { join, resolve } from "node:path"
import {
  AGENT_MEMORY_ENTRY,
  AGENT_MEMORY_MANIFEST,
  AGENT_MEMORY_STARTER,
  AGENT_RUNTIME_PROFILE,
  type AgentMemoryManifest,
  agentMemoryFileHash,
  loadSandboxCliAssets,
} from "@sixb/cli-core"
import type {
  AgentMemoryRepoView,
  AgentProjectFile,
  AgentSkillDefinition,
  Sandbox,
  SandboxFileRecord,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { MaterializedArtifacts } from "./artifacts/materialize"
import type { PreparedAgentAttachmentContext } from "./attachments"

/**
 * Where a conversation's artifacts are installed, and their manifest, relative to the context
 * directory. A sandbox that outlives the run clears that directory when it opens, so each run's
 * install starts empty.
 */
export const AGENT_ARTIFACTS_DIRECTORY = "artifacts"
export const AGENT_ARTIFACTS_MANIFEST = "context/artifacts.json"
const ARTIFACTS_RESET_TIMEOUT_MS = 30_000

export interface AgentSandboxApiContext {
  readonly env: Readonly<Record<string, string>>
}

export interface PrepareAgentSandboxApiContextInput {
  readonly sandbox: Sandbox
  /** Where the run's files go: relative to the working directory, or absolute. */
  readonly contextDirectory: string
  /** The API origin; commands reach it at the sandbox's credentialed address for it. */
  readonly apiBaseUrl: string
  readonly projectId: string
  readonly actorId?: string
  readonly threadId?: string
  readonly runId: string
  readonly attachments?: PreparedAgentAttachmentContext
  readonly skills: readonly AgentSkillDefinition[]
  /** The run's ontology reference docs and scripts, by path relative to the ontology directory. */
  readonly ontologyFiles: readonly AgentProjectFile[]
  /** A conversation's published artifacts, under {@link AGENT_ARTIFACTS_DIRECTORY}. */
  readonly artifacts?: MaterializedArtifacts
  /** A conversation's memory repos, under `$SIXB_MEMORY_DIR/<repo>/`. */
  readonly memory?: readonly AgentMemoryRepoView[]
}

export async function prepareAgentSandboxApiContext(
  input: PrepareAgentSandboxApiContextInput
): Promise<AgentSandboxApiContext> {
  const contextDir = resolve(input.sandbox.workingDirectory, input.contextDirectory)
  const skillsDir = join(contextDir, "skills")
  const ontologyDir = join(contextDir, "ontology")
  const binDir = join(contextDir, "bin")
  const libDir = join(contextDir, "lib")
  const runContextPath = join(contextDir, "context", "run.json")
  const bashEnvPath = join(contextDir, "context", "bash-env")
  const runtimeProbePath = join(contextDir, "runtime", "read-probe.txt")
  const attachmentsManifestPath = join(contextDir, "context", "attachments.json")
  const attachmentsDir = join(contextDir, "attachments")
  const artifactsDir = join(contextDir, AGENT_ARTIFACTS_DIRECTORY)
  const artifactsManifestPath = join(contextDir, AGENT_ARTIFACTS_MANIFEST)
  const memoryDir = join(contextDir, "memory")
  const cli = await loadSandboxCliAssets()
  // The run's commands reach the API through the sandbox's credentialed address, which adds the
  // run token on the way out: no command holds it.
  if (!input.sandbox.credentialedUrl) {
    throw createSixbError(
      "agent.execution_failed",
      `[SixbAgentWorker] Sandbox provider "${input.sandbox.provider}" advertises request credentials but its sandbox has no credentialedUrl.`
    )
  }
  const apiBaseUrl = input.sandbox.credentialedUrl(input.apiBaseUrl)

  // apiBaseUrl arrives already normalized (see worker.ts), so it is used verbatim. No file or env
  // var of the run holds the token: the sandbox adds it to requests to apiBaseUrl.
  const runContext = JSON.stringify(
    {
      projectId: input.projectId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      runId: input.runId,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      apiBaseUrl,
      attachmentsManifestPath,
      attachmentsDir,
      ...(input.artifacts ? { artifactsManifestPath, artifactsDir } : {}),
    },
    null,
    2
  )

  // A persistent workspace keeps what earlier runs installed: each artifact's copy must hold exactly
  // the version installed now, never a file only an older version had.
  if (input.artifacts) {
    const cleared = await input.sandbox.runCommand(
      "bash",
      ["-c", 'rm -rf -- "$SIXB_ARTIFACTS_RESET"'],
      {
        env: { SIXB_ARTIFACTS_RESET: artifactsDir },
        timeout: ARTIFACTS_RESET_TIMEOUT_MS,
      }
    )
    if (cleared.exitCode !== 0 || cleared.timedOut) {
      throw new Error(
        `[SixbAgentWorker] Could not clear ${join(input.contextDirectory, AGENT_ARTIFACTS_DIRECTORY)}: ${cleared.stderr.trim() || `exit ${cleared.exitCode}`}`
      )
    }
  }

  // Materialize skills, ontology docs + run context through the sandbox capability rather than the host
  // filesystem, so any provider (including non-host-path ones like smolvm) places the bytes in the
  // guest. Awaited before sandbox tools run, so the agent never sees an un-provisioned sandbox.
  await input.sandbox.writeFiles([
    ...input.skills.flatMap((skill) => installFiles(join(skillsDir, skill.name), skill.files)),
    ...installFiles(ontologyDir, input.ontologyFiles),
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
    ...(input.artifacts
      ? [
          { path: artifactsManifestPath, contents: input.artifacts.manifestJson },
          ...input.artifacts.files.map((file) => ({
            ...file,
            path: resolve(input.sandbox.workingDirectory, file.path),
          })),
        ]
      : []),
    ...(input.memory
      ? memoryFiles(memoryDir, join(contextDir, AGENT_MEMORY_MANIFEST), input.memory)
      : []),
    // Last: a file a parent handed its child from its own copy of an artifact keeps its changes.
    ...(input.attachments?.sandboxFiles.map((file) => ({
      path: resolve(input.sandbox.workingDirectory, file.path),
      contents: file.bytes,
    })) ?? []),
  ])

  return {
    env: {
      SIXB_API_BASE_URL: apiBaseUrl,
      SIXB_CONTEXT_DIR: contextDir,
      SIXB_SKILLS_DIR: skillsDir,
      SIXB_ONTOLOGY_DIR: ontologyDir,
      SIXB_BIN_DIR: binDir,
      SIXB_AGENT_RUNTIME_PROFILE: AGENT_RUNTIME_PROFILE,
      SIXB_RUNTIME_PROBE_FILE: runtimeProbePath,
      BASH_ENV: bashEnvPath,
      SIXB_RUN_CONTEXT: runContextPath,
      SIXB_ATTACHMENTS: attachmentsManifestPath,
      SIXB_ATTACHMENT_DIR: attachmentsDir,
      ...(input.artifacts
        ? { SIXB_ARTIFACTS: artifactsManifestPath, SIXB_ARTIFACTS_DIR: artifactsDir }
        : {}),
      ...(input.memory ? { SIXB_MEMORY_DIR: memoryDir } : {}),
      SIXB_PROJECT_ID: input.projectId,
      ...(input.actorId === undefined ? {} : { SIXB_ACTOR_ID: input.actorId }),
      ...(input.threadId ? { SIXB_THREAD_ID: input.threadId } : {}),
      SIXB_RUN_ID: input.runId,
    },
  }
}

/** Records that install project files under `dir`, ready to hand to {@link Sandbox.writeFiles}. */
function installFiles(dir: string, files: readonly AgentProjectFile[]): SandboxFileRecord[] {
  return files.map((file) => ({
    path: join(dir, file.path),
    contents: file.contents,
    ...(file.mode === undefined ? {} : { mode: file.mode }),
  }))
}

/**
 * Each repo's files, a starter MEMORY.md for a repo without one, and the manifest `sixb memory`
 * saves against. The starter is not in the manifest, so the first save stores it.
 */
function memoryFiles(
  dir: string,
  manifestPath: string,
  repos: readonly AgentMemoryRepoView[]
): SandboxFileRecord[] {
  const manifest: AgentMemoryManifest = {
    repos: Object.fromEntries(
      repos.map((repo) => [
        repo.repo,
        {
          revision: repo.revision,
          files: Object.fromEntries(
            repo.files.map((file) => [file.path, agentMemoryFileHash(file.contents)])
          ),
        },
      ])
    ),
  }
  return [
    ...repos.flatMap((repo) => [
      ...repo.files.map((file) => ({
        path: join(dir, repo.repo, ...file.path.split("/")),
        contents: file.contents,
      })),
      ...(repo.files.some((file) => file.path === AGENT_MEMORY_ENTRY)
        ? []
        : [{ path: join(dir, repo.repo, AGENT_MEMORY_ENTRY), contents: AGENT_MEMORY_STARTER }]),
    ]),
    { path: manifestPath, contents: `${JSON.stringify(manifest, null, 2)}\n` },
  ]
}

function emptyManifestJson(): string {
  return JSON.stringify({ attachments: [] }, null, 2)
}
